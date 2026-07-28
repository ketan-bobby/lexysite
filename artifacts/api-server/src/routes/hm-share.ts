/**
 * routes/hm-share.ts — Hiring-Manager Share Packages
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Lets a recruiter email a branded "candidate profile package" to a hiring
 * manager who has no Lexy login. Each send creates one `hiring_manager_shares`
 * row per recipient with a signed, expiring token. The hiring manager can:
 *   • open a no-login branded web view at /hm/:token, AND
 *   • read the same evaluation as a PDF attachment (corporate mail may block links),
 *   • submit a decision (advance / interview / pass + comment) that flows back
 *     into the recruiter's inbox + the candidate page.
 *
 * ─── Routers exported ───────────────────────────────────────────────────────
 *   default  → authed router (mounted at "/"):
 *                POST /hm-share            create + send
 *                GET  /hm-share            list shares for a candidate
 *   hmSharePublicRouter → no-auth router (mounted at "/public/hm-share"):
 *                GET  /:token              branded package view (marks viewed)
 *                GET  /:token/resume       stream résumé (only if included)
 *                POST /:token/decision     record hiring-manager decision
 *
 * ─── Security ────────────────────────────────────────────────────────────────
 * • Authed routes gate by recruiter-staff role + data scope (getDataScopeTenantIds)
 *   and recruiter ownership before any row is written; hm_shares is accessed via
 *   dbAdmin with explicit app-layer tenant gating (the table is new + RLS-free).
 * • Public routes authorise SOLELY by the unguessable token + expiry; they never
 *   accept a tenant/candidate id from the caller.
 * • Contact details are stripped server-side when includeContact is false, so a
 *   leaked link can never reveal more than the recruiter chose to share.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { validate } from "../middlewares/validate";
import {
  controlDb,
  dbAdmin,
  hiringManagerSharesTable,
  candidatesTable,
  tenantsTable,
  usersTable,
  jobsTable,
  applicationsTable,
  sourcedCandidatesTable,
  talentPoolSubmissionsTable,
  recruiterInboxTable,
  candidateEventsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { classBRead, CLASS_B_READ_EXEMPTION } from "../lib/class-b-read";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { sendEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { ObjectStorageService, s3Client } from "../lib/objectStorage";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { applyCandidateHardExclusions } from "./candidates";

const router: IRouter = Router();
export const hmSharePublicRouter: IRouter = Router();

/* Recruiter-staff allowlist — getDataScopeTenantIds is a DATA ceiling, not a
   role gate, so a tenant-scoped candidate account would otherwise pass it. */
const STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];

const SHARE_DECISIONS = ["advance", "interview", "pass"] as const;
type ShareDecision = (typeof SHARE_DECISIONS)[number];

const DECISION_LABEL: Record<ShareDecision, string> = {
  advance: "Advance to next stage",
  interview: "Request an interview",
  pass: "Pass",
};

/* Map an HM decision onto the canonical candidate_events funnel type so the
   decision shows up on every event-driven surface (timeline, funnels), not only
   the inbox. The precise decision + comment ride in metadata_json. */
const DECISION_EVENT_TYPE: Record<ShareDecision, "RECRUITER_SHORTLISTED" | "HIRING_MANAGER_INTERVIEW_SCHEDULED" | "REJECTED"> = {
  advance: "RECRUITER_SHORTLISTED",
  interview: "HIRING_MANAGER_INTERVIEW_SCHEDULED",
  pass: "REJECTED",
};

/** Resolve the bearer token to a full user row (role + tenantId). */
async function getCallerUser(req: Request) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/** A plain recruiter may only act on candidates tied to a requisition assigned
 *  to them (applications, sourced rows, or pushed pool rows). Mirrors the
 *  recruiter ownership ceiling used by the candidate routes. */
async function recruiterCanAccessCandidate(
  caller: { id: string; role: string; tenantId: string | null },
  candidateId: string,
): Promise<boolean> {
  const jobIds = await getRecruiterAssignedJobIds(caller);
  if (jobIds.length === 0) return false;
  const [apps, sourced, pushed] = await Promise.all([
    dbAdmin.select({ c: applicationsTable.candidateId }).from(applicationsTable)
      .where(and(eq(applicationsTable.candidateId, candidateId), inArray(applicationsTable.jobId, jobIds))).limit(1),
    dbAdmin.select({ c: sourcedCandidatesTable.normalizedCandidateId }).from(sourcedCandidatesTable)
      .where(and(
        eq(sourcedCandidatesTable.normalizedCandidateId, candidateId),
        inArray(sql`${sourcedCandidatesTable.rawData}->>'jobId'`, jobIds),
      )).limit(1),
    dbAdmin.select({ c: (talentPoolSubmissionsTable as any).candidateId }).from(talentPoolSubmissionsTable)
      .where(and(
        eq((talentPoolSubmissionsTable as any).candidateId, candidateId),
        inArray((talentPoolSubmissionsTable as any).jobPostingId, jobIds),
      )).limit(1),
  ]);
  return apps.length > 0 || sourced.length > 0 || pushed.length > 0;
}

function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.APP_PUBLIC_URL ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
    ""
  ).replace(/\/$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Sanitise the client-supplied package snapshot SERVER-SIDE so a toggle that
 *  is OFF truly removes the data from what we persist + ever serve — never just
 *  hides it in the UI. The client is untrusted (the public token endpoints read
 *  this snapshot back), so we strip the omitted fields before the row is written
 *  rather than relying on the client to have honoured the toggles. */
function sanitizePackageSnapshot(
  pkg: any,
  opts: { includeContact: boolean; includeNotes: boolean },
): any {
  if (!pkg || typeof pkg !== "object") return pkg ?? null;
  const out: any = JSON.parse(JSON.stringify(pkg));
  if (!opts.includeContact && out.candidate && typeof out.candidate === "object") {
    delete out.candidate.email;
    delete out.candidate.phone;
    delete out.candidate.location;
  }
  if (!opts.includeNotes) {
    // Recruiter-authored prose lives under resumeScreen.recruiterSummary and the
    // top-level preparedBy note. Drop both so notes-off omits them from storage.
    if (out.resumeScreen && typeof out.resumeScreen === "object") {
      delete out.resumeScreen.recruiterSummary;
    }
  }
  return out;
}

/** Extension → MIME type for résumé attachments. */
const RESUME_EXT_TO_CT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  txt: "text/plain",
  odt: "application/vnd.oasis.opendocument.text",
};
/** S3-stored MIME type → file extension. */
const RESUME_CT_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/plain": "txt",
  "application/vnd.oasis.opendocument.text": "odt",
};

/** Definitive file-type sniff from the leading magic bytes — the ground truth
 *  the filename/extension can lie about. Returns null when inconclusive.
 *  Note: a ZIP container (PK\x03\x04) is intentionally NOT classified here —
 *  it is ambiguous (docx/odt/…) and resolved by the caller against the
 *  S3-stored ContentType first. */
function sniffResumeType(buf: Buffer): { ext: string; contentType: string } | null {
  if (buf.length >= 4) {
    if (buf.toString("latin1", 0, 4) === "%PDF")
      return { ext: "pdf", contentType: RESUME_EXT_TO_CT.pdf };
    // Legacy MS Office OLE/CFB container → .doc
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0)
      return { ext: "doc", contentType: RESUME_EXT_TO_CT.doc };
  }
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "{\\rtf")
    return { ext: "rtf", contentType: RESUME_EXT_TO_CT.rtf };
  return null;
}

/** True if the buffer begins with the ZIP local-file-header magic (PK\x03\x04).
 *  All OOXML (docx/xlsx/pptx) and OpenDocument (odt/ods/…) files are ZIPs. */
function isZipContainer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** Resolve a résumé's true file extension + MIME type from its bytes, the
 *  S3-stored ContentType, and any extension on the source path. Stored résumé
 *  objects are routinely extensionless and are often DOCX, so trusting the
 *  filename or a blind `.pdf` produced unopenable files.
 *  Priority: definitive magic sniff → (ZIP: S3 CT → path ext → docx) → S3 CT →
 *  path ext → octet-stream. */
function resolveResumeFileType(
  buf: Buffer,
  s3ContentType: string | undefined,
  sourcePath: string,
): { ext: string; contentType: string } {
  const baseName = sourcePath.split("/").pop() || "resume";
  const pathExt = baseName.includes(".") ? baseName.split(".").pop()!.toLowerCase() : "";
  const ctExt = s3ContentType
    ? RESUME_CT_TO_EXT[s3ContentType.split(";")[0]!.trim().toLowerCase()]
    : undefined;
  const sniffed = sniffResumeType(buf);

  let ext: string;
  if (sniffed) {
    ext = sniffed.ext;
  } else if (isZipContainer(buf)) {
    ext = ctExt || pathExt || "docx";
  } else {
    ext = ctExt || pathExt || "bin";
  }
  const contentType =
    sniffed?.contentType || RESUME_EXT_TO_CT[ext] || s3ContentType || "application/octet-stream";
  return { ext, contentType };
}

/** Best-effort: fetch a candidate's résumé object into a base64 attachment.
 *  The stored object path is frequently extensionless (e.g.
 *  `/objects/uploads/<uuid>`), so naming the attachment is resolved from the
 *  real file type — magic bytes first, then the S3-stored ContentType, then any
 *  URL extension — never a blind `.pdf`, which produced unopenable files when
 *  the résumé was actually a DOCX. */
async function fetchResumeAttachment(
  resumeUrl: string | null | undefined,
  displayName?: string,
): Promise<{ filename: string; content: string; contentType: string } | null> {
  if (!resumeUrl) return null;
  try {
    const oss = new ObjectStorageService();
    const bucket = oss.getBucket();
    const privatePrefix = oss.getPrivatePrefix();
    let s3Key = resumeUrl.replace(/^\/objects\//, `${privatePrefix}/`);
    if (!s3Key.startsWith(privatePrefix)) s3Key = `${privatePrefix}/${s3Key.replace(/^\//, "")}`;
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    const body = resp.Body as import("stream").Readable | null;
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);

    const { ext, contentType } = resolveResumeFileType(buf, resp.ContentType, resumeUrl);

    const safeName = (displayName || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const filename = `Resume${safeName ? `-${safeName}` : ""}.${ext}`;
    return { filename, content: buf.toString("base64"), contentType };
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[hm-share] résumé fetch failed (non-fatal)");
    return null;
  }
}

/* ── POST /hm-share — create + send ──────────────────────────────────────── */
const CreateShareBody = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().nullable().optional(),
  applicationId: z.string().nullable().optional(),
  recipients: z.array(z.object({
    email: z.string().email(),
    name: z.string().optional(),
  })).min(1).max(10),
  includeContact: z.boolean().optional().default(false),
  includeResume: z.boolean().optional().default(false),
  includeNotes: z.boolean().optional().default(true),
  message: z.string().max(4000).optional(),
  package: z.any().optional(),
  pdf: z.object({ base64: z.string(), fileName: z.string() }).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional().default(14),
});

router.post("/hm-share", validate({ body: CreateShareBody }), async (req: Request, res: Response) => {
  const caller = await getCallerUser(req);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!STAFF_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return; }

  const {
    candidateId, jobId, applicationId, recipients,
    includeContact, includeResume, includeNotes, message, package: pkg, pdf, expiresInDays,
  } = req.body as z.infer<typeof CreateShareBody>;

  if (caller.role === "recruiter" && !(await recruiterCanAccessCandidate(caller as any, candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [candidate] = await dbAdmin.select().from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Candidate not found" }); return; }

  /* DATA-scope ceiling — the source candidate must be inside the caller's scope.
     platform_admin (null) bypasses. */
  const allowed = await getDataScopeTenantIds(caller as any);
  if (allowed && !allowed.includes(candidate.tenantId ?? "")) {
    res.status(404).json({ error: "Candidate not found" }); return;
  }

  /* Compliance hard-exclusion seal — a GDPR-erased / do-not-contact /
     not-yet-onboarded candidate must NEVER be packaged into a login-less
     external share link. This is the canonical seal (applyCandidateHardExclusions),
     enforced here at CREATE time so a barred candidate can't be emailed out at all.
     Discovery-preference filters (hide/block/pause/match-only) are intentionally
     NOT applied here: an hm-share is a recruiter acting on an EXISTING pipeline
     relationship, not a discovery surface. */
  if (applyCandidateHardExclusions([candidate]).length === 0) {
    res.status(403).json({ error: "Candidate not shareable" }); return;
  }

  const shareTenantId = candidate.tenantId ?? caller.tenantId;
  if (!shareTenantId) { res.status(400).json({ error: "Candidate has no tenant" }); return; }

  /* Validate caller-supplied foreign ids: a jobId/applicationId must belong to
     the share's tenant AND (for applications) actually link this candidate, or
     the inbox context downstream would be wrong / cross-tenant. Drop on mismatch. */
  let safeJobId: string | null = null;
  let safeApplicationId: string | null = null;
  if (jobId) {
    const [job] = await dbAdmin.select({ tenantId: jobsTable.tenantId }).from(jobsTable)
      .where(eq(jobsTable.id, jobId)).limit(1);
    if (job && job.tenantId === shareTenantId) safeJobId = jobId;
  }
  if (applicationId) {
    const [app] = await dbAdmin.select({
      tenantId: applicationsTable.tenantId,
      candidateId: applicationsTable.candidateId,
      jobId: applicationsTable.jobId,
    }).from(applicationsTable).where(eq(applicationsTable.id, applicationId)).limit(1);
    if (app && app.tenantId === shareTenantId && app.candidateId === candidateId) {
      safeApplicationId = applicationId;
      if (!safeJobId) safeJobId = app.jobId; // backfill a trustworthy jobId from the linked app
    }
  }

  const [brandRow] = await dbAdmin.select({
    name: tenantsTable.name,
    logoUrl: tenantsTable.logoUrl,
    primaryColor: tenantsTable.primaryColor,
  }).from(tenantsTable).where(eq(tenantsTable.id, shareTenantId)).limit(1);
  const brand = {
    name: brandRow?.name ?? "Lexy",
    logoUrl: brandRow?.logoUrl ?? null,
    primaryColor: brandRow?.primaryColor ?? "#7c3aed",
  };

  const candidateName = `${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim() || "Candidate";
  const base = publicBaseUrl();

  /* Snapshot the résumé object path at SEND time so the public stream serves
     exactly what was shared, even if the candidate later replaces their résumé. */
  const resumeObjectPath = includeResume ? (candidate.resumeUrl ?? null) : null;
  /* Build the résumé attachment once if requested (best-effort), reused per recipient. */
  const resumeAttachment = resumeObjectPath ? await fetchResumeAttachment(resumeObjectPath, candidateName) : null;

  /* Sanitise the snapshot server-side: an OFF toggle must REMOVE the data from
     storage, not merely hide it client-side (the snapshot is read back by the
     public token endpoints, which trust the stored row). */
  const safePackage = sanitizePackageSnapshot(pkg, { includeContact: !!includeContact, includeNotes: !!includeNotes });

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const sent: Array<{ recipientEmail: string; shareId: string; link: string; emailed: boolean }> = [];

  for (const r of recipients) {
    const [row] = await dbAdmin.insert(hiringManagerSharesTable).values({
      tenantId: shareTenantId,
      candidateId,
      jobId: safeJobId,
      applicationId: safeApplicationId,
      createdByUserId: caller.id,
      recipientEmail: r.email,
      recipientName: r.name ?? null,
      includeContact: !!includeContact,
      includeResume: !!includeResume,
      includeNotes: !!includeNotes,
      packageSnapshot: safePackage,
      brandSnapshot: brand,
      resumeObjectPath,
      message: message ?? null,
      status: "sent",
      expiresAt,
    }).returning();

    const link = base ? `${base}/hm/${row.token}` : `/hm/${row.token}`;
    const accent = brand.primaryColor || "#7c3aed";
    const greeting = r.name ? `Hi ${escapeHtml(r.name)},` : "Hello,";
    const noteBlock = message
      ? `<div style="margin:16px 0;padding:14px 16px;background:#f8fafc;border-left:3px solid ${accent};border-radius:6px;color:#334155;font-size:14px;white-space:pre-wrap;">${escapeHtml(message)}</div>`
      : "";
    const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
      <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
        <div style="text-align:center;margin-bottom:8px;">
          ${brand.logoUrl ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" style="max-height:40px;"/>` : `<span style="font-weight:700;font-size:18px;color:${accent};">${escapeHtml(brand.name)}</span>`}
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px 24px;border:1px solid #e2e8f0;">
          <p style="margin:0 0 12px;font-size:15px;">${greeting}</p>
          <p style="margin:0 0 4px;font-size:15px;">${escapeHtml(brand.name)} has shared a candidate profile with you for review:</p>
          <p style="margin:8px 0 0;font-size:20px;font-weight:700;">${escapeHtml(candidateName)}</p>
          ${candidate.currentTitle ? `<p style="margin:2px 0 0;color:#64748b;font-size:14px;">${escapeHtml(candidate.currentTitle)}${candidate.currentCompany ? " · " + escapeHtml(candidate.currentCompany) : ""}</p>` : ""}
          ${noteBlock}
          <div style="text-align:center;margin:24px 0 8px;">
            <a href="${link}" style="display:inline-block;padding:12px 28px;background:${accent};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Review the candidate →</a>
          </div>
          <p style="margin:16px 0 0;color:#94a3b8;font-size:12.5px;text-align:center;">No login required. You can advance, request an interview, or pass — right from the page.${pdf ? " A PDF copy is attached for your records." : ""}</p>
          <p style="margin:6px 0 0;color:#94a3b8;font-size:12px;text-align:center;">This link expires on ${expiresAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.</p>
        </div>
        <p style="margin:18px 0 0;color:#94a3b8;font-size:11px;text-align:center;">If the button doesn't work, paste this into your browser:<br/>${escapeHtml(link)}</p>
      </div></body></html>`;

    const text =
      `${r.name ? `Hi ${r.name},` : "Hello,"}\n\n` +
      `${brand.name} has shared a candidate profile with you for review: ${candidateName}.\n` +
      (message ? `\n${message}\n` : "") +
      `\nReview the candidate (no login required): ${link}\n` +
      `You can advance, request an interview, or pass directly from the page.\n` +
      `This link expires on ${expiresAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.\n`;

    const attachments: Array<{ filename: string; content: string; contentType?: string }> = [];
    if (pdf?.base64) attachments.push({ filename: pdf.fileName || `Evaluation-${candidateName}.pdf`, content: pdf.base64, contentType: "application/pdf" });
    if (resumeAttachment) attachments.push(resumeAttachment);

    let emailed = false;
    try {
      const result = await sendEmail({
        to: r.email,
        subject: `${brand.name} shared a candidate profile: ${candidateName}`,
        html,
        text,
        attachments,
        audit: {
          tenantId: shareTenantId,
          actorLabel: "Hiring Manager Share",
          subjectType: "external",
          subjectId: candidateId,
          subjectLabel: candidateName,
          action: "hm_share.send",
          metadata: { shareId: row.id, candidateId, recipient: r.email },
        },
      });
      emailed = result.ok;
    } catch (err: any) {
      logger.error({ err: err?.message, shareId: row.id }, "[hm-share] send failed");
    }

    sent.push({ recipientEmail: r.email, shareId: row.id, link, emailed });
  }

  res.json({ ok: true, sent });
});

/* ── GET /hm-share?candidateId= — list shares for candidate page ──────────── */
router.get("/hm-share", async (req: Request, res: Response) => {
  const caller = await getCallerUser(req);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!STAFF_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return; }

  const candidateId = String(req.query.candidateId ?? "");
  if (!candidateId) { res.status(400).json({ error: "candidateId is required" }); return; }

  if (caller.role === "recruiter" && !(await recruiterCanAccessCandidate(caller as any, candidateId))) {
    res.json({ shares: [] }); return;
  }

  const [candidate] = await dbAdmin.select({ tenantId: candidatesTable.tenantId }).from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Candidate not found" }); return; }

  const allowed = await getDataScopeTenantIds(caller as any);
  if (allowed && !allowed.includes(candidate.tenantId ?? "")) {
    res.status(404).json({ error: "Candidate not found" }); return;
  }

  const rows = await dbAdmin.select({
    id: hiringManagerSharesTable.id,
    recipientEmail: hiringManagerSharesTable.recipientEmail,
    recipientName: hiringManagerSharesTable.recipientName,
    status: hiringManagerSharesTable.status,
    decision: hiringManagerSharesTable.decision,
    decisionComment: hiringManagerSharesTable.decisionComment,
    decidedByName: hiringManagerSharesTable.decidedByName,
    decidedAt: hiringManagerSharesTable.decidedAt,
    viewedAt: hiringManagerSharesTable.viewedAt,
    viewCount: hiringManagerSharesTable.viewCount,
    includeContact: hiringManagerSharesTable.includeContact,
    includeResume: hiringManagerSharesTable.includeResume,
    includeNotes: hiringManagerSharesTable.includeNotes,
    createdAt: hiringManagerSharesTable.createdAt,
    expiresAt: hiringManagerSharesTable.expiresAt,
  }).from(hiringManagerSharesTable)
    .where(eq(hiringManagerSharesTable.candidateId, candidateId))
    .orderBy(desc(hiringManagerSharesTable.createdAt))
    .limit(100);

  res.json({ shares: rows });
});

/* ── PUBLIC: GET /public/hm-share/:token — branded package view ───────────── */
hmSharePublicRouter.get("/:token", async (req: Request, res: Response) => {
  const token = req.params.token;
  // Authorized by the opaque share token + expiry check below — the hiring
  // manager has no Lexy tenant, so there is no tenant column to scope by.
  classBRead(CLASS_B_READ_EXEMPTION.TOKEN_PRE_AUTHORIZED);
  const [share] = await dbAdmin.select().from(hiringManagerSharesTable)
    .where(eq(hiringManagerSharesTable.token, token)).limit(1);
  if (!share) { res.status(404).json({ error: "not_found" }); return; }

  if (new Date(share.expiresAt).getTime() < Date.now()) {
    if (share.status !== "expired") {
      await dbAdmin.update(hiringManagerSharesTable)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(hiringManagerSharesTable.id, share.id));
    }
    res.status(410).json({ error: "expired" }); return;
  }

  /* Live compliance re-check — a candidate GDPR-erased or set do-not-contact
     AFTER this link was minted must be revoked from the external view, even
     though the package snapshot was frozen at send time. Serve 410 (gone), never
     the stale snapshot. This closes the create-then-bar window on an endpoint
     that is reachable with no authentication at all. */
  const [liveCand] = await dbAdmin.select({
    dataErasedAt: candidatesTable.dataErasedAt,
    doNotContact: (candidatesTable as any).doNotContact,
    pool: (candidatesTable as any).pool,
  }).from(candidatesTable).where(eq(candidatesTable.id, share.candidateId)).limit(1);
  if (!liveCand || applyCandidateHardExclusions([liveCand]).length === 0) {
    res.status(410).json({ error: "revoked" }); return;
  }

  /* Track engagement: first view stamps viewedAt + flips sent→viewed. */
  await dbAdmin.update(hiringManagerSharesTable).set({
    viewCount: (share.viewCount ?? 0) + 1,
    viewedAt: share.viewedAt ?? new Date(),
    status: share.status === "sent" ? "viewed" : share.status,
    updatedAt: new Date(),
  }).where(eq(hiringManagerSharesTable.id, share.id));

  /* Defence in depth: strip contact details from the snapshot if the recruiter
     did not include them, even though the client-built snapshot already should. */
  const pkg: any = share.packageSnapshot ? JSON.parse(JSON.stringify(share.packageSnapshot)) : null;
  if (pkg && pkg.candidate && !share.includeContact) {
    delete pkg.candidate.email;
    delete pkg.candidate.phone;
  }

  res.json({
    package: pkg,
    brand: share.brandSnapshot ?? null,
    message: share.includeNotes ? share.message : null,
    recipientName: share.recipientName,
    includeContact: share.includeContact,
    includeResume: share.includeResume,
    decision: share.decision,
    decisionComment: share.decisionComment,
    decidedByName: share.decidedByName,
    decidedAt: share.decidedAt,
    expiresAt: share.expiresAt,
  });
});

/* ── PUBLIC: GET /public/hm-share/:token/resume — stream résumé ───────────── */
hmSharePublicRouter.get("/:token/resume", async (req: Request, res: Response) => {
  const token = req.params.token;
  // Authorized by the opaque share token + expiry check below (login-less HM).
  classBRead(CLASS_B_READ_EXEMPTION.TOKEN_PRE_AUTHORIZED);
  const [share] = await dbAdmin.select().from(hiringManagerSharesTable)
    .where(eq(hiringManagerSharesTable.token, token)).limit(1);
  if (!share) { res.status(404).json({ error: "not_found" }); return; }
  if (new Date(share.expiresAt).getTime() < Date.now()) { res.status(410).json({ error: "expired" }); return; }
  if (!share.includeResume) { res.status(404).json({ error: "not_found" }); return; }

  /* Live compliance re-check (mirror the package view): never stream a résumé for
     a candidate erased / set do-not-contact after the link was minted. */
  const [liveCand] = await dbAdmin.select({
    dataErasedAt: candidatesTable.dataErasedAt,
    doNotContact: (candidatesTable as any).doNotContact,
    pool: (candidatesTable as any).pool,
  }).from(candidatesTable).where(eq(candidatesTable.id, share.candidateId)).limit(1);
  if (!liveCand || applyCandidateHardExclusions([liveCand]).length === 0) {
    res.status(410).json({ error: "revoked" }); return;
  }

  /* Serve the résumé captured at SEND time, NOT the candidate's live résumé, so
     a later résumé replacement can never leak newer content to an old token. */
  const resumeObjectPath = share.resumeObjectPath;
  if (!resumeObjectPath) { res.status(404).json({ error: "no_resume" }); return; }

  try {
    const oss = new ObjectStorageService();
    const bucket = oss.getBucket();
    const privatePrefix = oss.getPrivatePrefix();
    let s3Key = resumeObjectPath.replace(/^\/objects\//, `${privatePrefix}/`);
    if (!s3Key.startsWith(privatePrefix)) s3Key = `${privatePrefix}/${s3Key.replace(/^\//, "")}`;
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    const body = resp.Body as import("stream").Readable | null;
    if (!body) { res.status(404).end(); return; }

    /* Buffer + sniff the real type. The stored object is extensionless and often
       a DOCX, so the old `Content-Type: …|| application/pdf` + extensionless
       `inline` filename made the browser feed DOCX bytes to its PDF viewer →
       "Failed to load PDF document". Serve the true type with a real extension
       so PDFs preview inline and other formats download cleanly. */
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);
    const { ext, contentType } = resolveResumeFileType(buf, resp.ContentType, resumeObjectPath);
    const disposition = contentType === "application/pdf" ? "inline" : "attachment";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="resume.${ext}"`);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Stream failed" });
  }
});

/* ── PUBLIC: POST /public/hm-share/:token/decision — record decision ──────── */
const DecisionBody = z.object({
  decision: z.enum(SHARE_DECISIONS),
  comment: z.string().max(4000).optional(),
  name: z.string().max(200).optional(),
});

hmSharePublicRouter.post("/:token/decision", validate({ body: DecisionBody }), async (req: Request, res: Response) => {
  const token = req.params.token;
  const { decision, comment, name } = req.body as z.infer<typeof DecisionBody>;

  // Authorized by the opaque share token + expiry/idempotency guards below.
  classBRead(CLASS_B_READ_EXEMPTION.TOKEN_PRE_AUTHORIZED);
  const [share] = await dbAdmin.select().from(hiringManagerSharesTable)
    .where(eq(hiringManagerSharesTable.token, token)).limit(1);
  if (!share) { res.status(404).json({ error: "not_found" }); return; }
  if (new Date(share.expiresAt).getTime() < Date.now()) { res.status(410).json({ error: "expired" }); return; }
  if (share.decision) { res.status(409).json({ error: "already_decided", decision: share.decision }); return; }

  const now = new Date();
  /* Atomic guard: decide only if still un-decided AND not yet expired. Both the
     idempotency (decision IS NULL) and the expiry (expires_at > now) live INSIDE
     the predicate so a request racing expiry or a concurrent tab cannot persist. */
  const [updated] = await dbAdmin.update(hiringManagerSharesTable).set({
    decision,
    decisionComment: comment ?? null,
    decidedByName: name ?? null,
    decidedAt: now,
    status: "decided",
    updatedAt: now,
  }).where(and(
    eq(hiringManagerSharesTable.id, share.id),
    sql`${hiringManagerSharesTable.decision} IS NULL`,
    sql`${hiringManagerSharesTable.expiresAt} > now()`,
  )).returning();

  if (!updated) {
    /* Either already decided, or it expired between our SELECT and UPDATE. */
    const [fresh] = await dbAdmin.select({
      decision: hiringManagerSharesTable.decision,
      expiresAt: hiringManagerSharesTable.expiresAt,
    }).from(hiringManagerSharesTable).where(eq(hiringManagerSharesTable.id, share.id)).limit(1);
    if (fresh && new Date(fresh.expiresAt).getTime() < Date.now()) {
      res.status(410).json({ error: "expired" }); return;
    }
    res.status(409).json({ error: "already_decided", decision: fresh?.decision ?? null }); return;
  }

  /* Feed the decision back to the recruiter's tenant-scoped inbox (the
     guaranteed in-app surface). Best-effort — never fail the HM's submission. */
  try {
    const [candidate] = await dbAdmin.select({
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
    }).from(candidatesTable).where(eq(candidatesTable.id, share.candidateId)).limit(1);
    const candName = candidate
      ? (`${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim() || "A candidate")
      : "A candidate";

    let jobTitle = "";
    if (share.jobId) {
      const [job] = await dbAdmin.select({ title: jobsTable.title }).from(jobsTable)
        .where(eq(jobsTable.id, share.jobId)).limit(1);
      jobTitle = job?.title ?? "";
    }

    const who = name?.trim() || share.recipientName || share.recipientEmail;
    const label = DECISION_LABEL[decision];
    const inboxType = decision === "advance" ? "positive_reply"
      : decision === "interview" ? "needs_followup"
      : "negative_reply";
    const priority = decision === "pass" ? "normal" : "high";
    const subject = `Hiring manager decision: ${label} — ${candName}${jobTitle ? ` (${jobTitle})` : ""}`;
    const bodyText =
      `${who} reviewed ${candName}${jobTitle ? ` for ${jobTitle}` : ""} and chose: ${label}.` +
      (comment ? `\n\nTheir comment:\n${comment}` : "");

    await dbAdmin.insert(recruiterInboxTable).values({
      tenantId: share.tenantId,
      type: inboxType as any,
      candidateId: share.candidateId,
      campaignId: share.jobId || share.id, // NOT NULL, no FK — fall back to jobId/share id
      subject,
      preview: bodyText.slice(0, 200),
      body: bodyText,
      priority,
    } as any);

    /* Also log to the canonical event stream so the decision surfaces on the
       candidate timeline + funnels, not only the inbox. jobId is NOT NULL on
       candidate_events; fall back to "" when the share carried no job context. */
    await dbAdmin.insert(candidateEventsTable).values({
      candidateId: share.candidateId,
      jobId: share.jobId ?? "",
      tenantId: share.tenantId,
      applicationId: share.applicationId ?? null,
      eventType: DECISION_EVENT_TYPE[decision],
      actorType: "hiring_manager",
      source: "email",
      metadataJson: {
        hmShareId: share.id,
        decision,
        decisionLabel: label,
        comment: comment ?? null,
        decidedByName: who,
        recipientEmail: share.recipientEmail,
      },
    } as any);

    /* Email the recruiter who sent the package at their REAL inbox (e.g. Outlook)
       so the decision reaches them outside Lexy too — the in-app inbox row above
       is the guaranteed surface, this is the proactive push. Best-effort and
       isolated: a missing creator / send failure must never fail the HM's
       submission or undo the inbox write. */
    if (share.createdByUserId) {
      try {
        const [recruiter] = await controlDb.select({
          email: usersTable.email,
          firstName: usersTable.firstName,
        }).from(usersTable).where(eq(usersTable.id, share.createdByUserId)).limit(1);
        if (recruiter?.email) {
          const accent = (share.brandSnapshot as any)?.primaryColor || "#7c3aed";
          const brandName = (share.brandSnapshot as any)?.name || "Lexy";
          const recruiterGreeting = recruiter.firstName ? `Hi ${escapeHtml(recruiter.firstName)},` : "Hello,";
          const commentBlock = comment
            ? `<div style="margin:16px 0;padding:14px 16px;background:#f8fafc;border-left:3px solid ${accent};border-radius:6px;color:#334155;font-size:14px;white-space:pre-wrap;">${escapeHtml(comment)}</div>`
            : "";
          const recruiterHtml = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
      <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
        <div style="background:#fff;border-radius:12px;padding:28px 24px;border:1px solid #e2e8f0;">
          <p style="margin:0 0 12px;font-size:15px;">${recruiterGreeting}</p>
          <p style="margin:0 0 4px;font-size:15px;"><strong>${escapeHtml(who)}</strong> reviewed <strong>${escapeHtml(candName)}</strong>${jobTitle ? ` for <strong>${escapeHtml(jobTitle)}</strong>` : ""} and made a decision:</p>
          <p style="margin:12px 0;font-size:20px;font-weight:700;color:${accent};">${escapeHtml(label)}</p>
          ${commentBlock}
          <p style="margin:16px 0 0;color:#94a3b8;font-size:12.5px;">This decision has also been recorded in your ${escapeHtml(brandName)} inbox and on the candidate's timeline.</p>
        </div>
      </div></body></html>`;
          const recruiterText =
            `${recruiter.firstName ? `Hi ${recruiter.firstName},` : "Hello,"}\n\n` +
            `${who} reviewed ${candName}${jobTitle ? ` for ${jobTitle}` : ""} and made a decision: ${label}.\n` +
            (comment ? `\nTheir comment:\n${comment}\n` : "") +
            `\nThis decision has also been recorded in your ${brandName} inbox and on the candidate's timeline.\n`;
          await sendEmail({
            to: recruiter.email,
            subject,
            html: recruiterHtml,
            text: recruiterText,
            audit: {
              tenantId: share.tenantId,
              actorLabel: "Hiring Manager Decision",
              subjectType: "external",
              subjectId: share.candidateId,
              subjectLabel: candName,
              action: "hm_share.decision_notify",
              metadata: { shareId: share.id, decision, recruiterEmail: recruiter.email },
            },
          });
        }
      } catch (mailErr: any) {
        logger.error({ err: mailErr?.message, shareId: share.id }, "[hm-share] recruiter decision email failed (non-fatal)");
      }
    }
  } catch (err: any) {
    logger.error({ err: err?.message, shareId: share.id }, "[hm-share] decision notify failed (non-fatal)");
  }

  res.json({ ok: true, decision });
});

export default router;
