/**
 * routes/recruiter-avatar.ts — Recruiter Intro Avatar (HeyGen) — Phase 1 (backend)
 *
 * Staff-gated endpoints to manage a recruiter's talking-avatar intro and to drive
 * HeyGen renders, plus a candidate-experience contract endpoint that always
 * resolves to either a recruiter video or a Lexy fallback (never blocking).
 *
 * Tenant scoping mirrors routes/ai-jobs.ts: getAuthUserId → controlDb lookup →
 * STAFF_ROLES allowlist → getAllowedTenantIds subtree. All table access uses
 * dbAdmin with explicit tenant filters.
 *
 * NOTE: this is backend-only. Recruiter settings UI (Phase 2) and the interview
 * start-screen playback/transition (Phase 3) are intentionally out of scope.
 */
import { Router, type IRouter } from "express";
import {
  controlDb,
  dbAdmin,
  usersTable,
  tenantsTable,
  recruiterAvatarProfilesTable,
  recruiterAvatarVideoJobsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { storageServingUrl, type IntroScriptContext } from "../lib/recruiter-intro-core";
import { generateIntroScript } from "../lib/recruiter-intro-script";
import {
  ensureIntroVideoJob,
  pollIntroVideoJob,
  getCandidateIntro,
} from "../lib/recruiter-intro-video";
import { logCandidateEvent } from "../lib/candidate-event-logger";
import { type CandidateEventType } from "@workspace/db";

const router: IRouter = Router();

/* recruiter_admin included: working managers record intro videos too. Their
 * tenant ceiling is already the restricted getDataScopeTenantIds in
 * resolveStaff below (never the whole agency subtree). */
const STAFF_ROLES = [
  "platform_admin",
  "tenant_admin",
  "recruiter",
  "recruiter_admin",
  "hiring_manager",
  "interviewer",
];

async function resolveStaff(
  req: any,
  res: any,
): Promise<{ caller: any; allowedTenants: string[] | null } | null> {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (!STAFF_ROLES.includes(caller.role)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (caller.role === "platform_admin") return { caller, allowedTenants: null };
  const allowedTenants = await getDataScopeTenantIds(caller as any);
  if (!allowedTenants || allowedTenants.length === 0) return { caller, allowedTenants: [] };
  return { caller, allowedTenants };
}

async function getCompanyName(tenantId: string | null): Promise<string> {
  if (!tenantId) return "our team";
  const [t] = await controlDb
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);
  return ((t as any)?.name as string | undefined) ?? "our team";
}

function buildCtx(caller: any, companyName: string, b: any): IntroScriptContext {
  return {
    recruiterName:
      typeof b.recruiterName === "string" && b.recruiterName
        ? b.recruiterName
        : (caller.name ?? "your recruiter"),
    recruiterTitle: typeof b.recruiterTitle === "string" ? b.recruiterTitle : null,
    companyName: typeof b.companyName === "string" && b.companyName ? b.companyName : companyName,
    roleTitle: typeof b.roleTitle === "string" ? b.roleTitle : null,
    language: String(b.language),
    tone: typeof b.tone === "string" ? b.tone : "warm_professional",
  };
}

function serializeProfile(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    recruiterUserId: row.recruiterUserId,
    tenantId: row.tenantId,
    avatarImageObjectPath: row.avatarImageObjectPath ?? null,
    avatarImageUrl: row.avatarImageObjectPath ? storageServingUrl(row.avatarImageObjectPath) : null,
    hasHeygenTalkingPhoto: !!row.heygenTalkingPhotoId,
    selectedVoiceId: row.selectedVoiceId ?? null,
    voiceGender: row.voiceGender,
    primaryLanguage: row.primaryLanguage,
    tone: row.tone,
    consentConfirmed: row.consentConfirmed,
    consentAt: row.consentAt ? new Date(row.consentAt).toISOString() : null,
    status: row.status,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

function serializeJob(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    language: row.language,
    candidateId: row.candidateId ?? null,
    interviewId: row.interviewId ?? null,
    jobId: row.jobId ?? null,
    voiceId: row.voiceId ?? null,
    heygenVideoId: row.heygenVideoId ?? null,
    outputVideoObjectPath: row.outputVideoObjectPath ?? null,
    videoUrl: row.outputVideoObjectPath ? storageServingUrl(row.outputVideoObjectPath) : null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/* POST /recruiter-avatar/profile — create/update the caller's avatar profile. */
router.post("/recruiter-avatar/profile", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const { caller } = auth;
  const b = req.body ?? {};

  const consent = b.consentConfirmed === true;
  const avatarImageObjectPath =
    typeof b.avatarImageObjectPath === "string" ? b.avatarImageObjectPath : null;

  /* The photo pointer doubles as a read grant (storage.ts avatar fallback),
   * so the claim must be validated: only paths from the dedicated
   * recruiter-avatars upload namespace are accepted (a caller-supplied
   * generic /objects/uploads/… path could otherwise claim-and-read a foreign
   * private object, e.g. a resume), and a path already pinned to ANOTHER
   * recruiter's profile can't be re-claimed. */
  if (avatarImageObjectPath) {
    if (!avatarImageObjectPath.startsWith("/objects/recruiter-avatars/")) {
      res.status(400).json({ error: "Invalid photo path — please re-upload your photo" });
      return;
    }
    const claimed = await dbAdmin
      .select({ recruiterUserId: recruiterAvatarProfilesTable.recruiterUserId })
      .from(recruiterAvatarProfilesTable)
      .where(eq(recruiterAvatarProfilesTable.avatarImageObjectPath, avatarImageObjectPath))
      .limit(2);
    if (claimed.some((c) => c.recruiterUserId !== caller.id)) {
      res.status(409).json({ error: "This photo is already in use" });
      return;
    }
  }

  const [existing] = await dbAdmin
    .select()
    .from(recruiterAvatarProfilesTable)
    .where(eq(recruiterAvatarProfilesTable.recruiterUserId, caller.id))
    .limit(1);

  const effectiveConsent = consent || (existing?.consentConfirmed ?? false);
  const effectiveImage = avatarImageObjectPath ?? existing?.avatarImageObjectPath ?? null;
  const status =
    b.disabled === true ? "disabled" : effectiveConsent && effectiveImage ? "ready" : "draft";

  const common = {
    avatarImageObjectPath: effectiveImage,
    selectedVoiceId:
      typeof b.selectedVoiceId === "string"
        ? b.selectedVoiceId
        : (existing?.selectedVoiceId ?? null),
    voiceGender:
      typeof b.voiceGender === "string" ? b.voiceGender : (existing?.voiceGender ?? "female"),
    primaryLanguage:
      typeof b.primaryLanguage === "string"
        ? b.primaryLanguage
        : (existing?.primaryLanguage ?? "en-US"),
    tone: typeof b.tone === "string" ? b.tone : (existing?.tone ?? "warm_professional"),
    consentConfirmed: effectiveConsent,
    status: status as any,
    updatedAt: new Date(),
  };

  let row;
  if (existing) {
    const setVals: any = { ...common };
    // If the photo changed, invalidate the cached HeyGen talking_photo id.
    if (avatarImageObjectPath && existing.avatarImageObjectPath !== avatarImageObjectPath) {
      setVals.heygenTalkingPhotoId = null;
    }
    if (consent && !existing.consentConfirmed) {
      setVals.consentAt = new Date();
      setVals.consentVersion = "v1";
    }
    [row] = await dbAdmin
      .update(recruiterAvatarProfilesTable)
      .set(setVals)
      .where(eq(recruiterAvatarProfilesTable.id, existing.id))
      .returning();
  } else {
    [row] = await dbAdmin
      .insert(recruiterAvatarProfilesTable)
      .values({
        recruiterUserId: caller.id,
        tenantId: caller.tenantId ?? "",
        ...common,
        consentAt: consent ? new Date() : null,
        consentVersion: consent ? "v1" : null,
      })
      .returning();
  }

  res.json(serializeProfile(row));
});

/* GET /recruiter-avatar/profile — the caller's avatar profile (or null). */
router.get("/recruiter-avatar/profile", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const [row] = await dbAdmin
    .select()
    .from(recruiterAvatarProfilesTable)
    .where(eq(recruiterAvatarProfilesTable.recruiterUserId, auth.caller.id))
    .limit(1);
  const serialized = serializeProfile(row);
  if (!serialized) {
    res.json(null);
    return;
  }

  /* Re-attach the most recent completed render so the recruiter still sees
     their saved intro video after a page reload — the completed MP4 lives in
     recruiter_avatar_video_jobs, not on the profile row, so without this the
     preview only survived in client state and vanished on refresh. */
  const [latest] = await dbAdmin
    .select()
    .from(recruiterAvatarVideoJobsTable)
    .where(
      and(
        eq(recruiterAvatarVideoJobsTable.recruiterAvatarProfileId, row.id),
        eq(recruiterAvatarVideoJobsTable.status, "completed"),
      ),
    )
    .orderBy(desc(recruiterAvatarVideoJobsTable.createdAt))
    .limit(1);

  res.json({ ...serialized, latestVideo: serializeJob(latest) });
});

/* POST /recruiter-avatar/script/preview — generate (not persist) an intro script. */
router.post("/recruiter-avatar/script/preview", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const b = req.body ?? {};
  if (typeof b.language !== "string" || !b.language) {
    res.status(400).json({ error: "language is required" });
    return;
  }
  const companyName = await getCompanyName(auth.caller.tenantId);
  const ctx = buildCtx(auth.caller, companyName, b);
  const gen = await generateIntroScript(
    ctx,
    "preview",
    typeof b.jobId === "string" ? b.jobId : null,
  );
  res.json({ scriptText: gen.scriptText, scriptHash: gen.scriptHash, language: gen.language });
});

/* POST /recruiter-avatar/video-jobs — create (or reuse) a HeyGen render. */
router.post("/recruiter-avatar/video-jobs", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const b = req.body ?? {};
  if (typeof b.language !== "string" || !b.language) {
    res.status(400).json({ error: "language is required" });
    return;
  }
  const companyName = await getCompanyName(auth.caller.tenantId);
  const ctx = buildCtx(auth.caller, companyName, b);
  const result = await ensureIntroVideoJob({
    recruiterUserId: auth.caller.id,
    candidateId: typeof b.candidateId === "string" ? b.candidateId : null,
    interviewId: typeof b.interviewId === "string" ? b.interviewId : null,
    jobId: typeof b.jobId === "string" ? b.jobId : null,
    language: b.language,
    voiceId: typeof b.voiceId === "string" ? b.voiceId : null,
    voiceGender: typeof b.voiceGender === "string" ? b.voiceGender : null,
    ctx,
  });
  if (!result.ok) {
    const code =
      result.reason === "disabled"
        ? 503
        : result.reason === "no_avatar" || result.reason === "no_profile"
          ? 409
          : 502;
    res.status(code).json({ ok: false, reason: result.reason });
    return;
  }
  res.json({ ok: true, job: serializeJob(result.job) });
});

/* GET /recruiter-avatar/video-jobs/:id — poll HeyGen + persist on completion. */
router.get("/recruiter-avatar/video-jobs/:id", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const { allowedTenants } = auth;

  const [job] = await dbAdmin
    .select({
      id: recruiterAvatarVideoJobsTable.id,
      tenantId: recruiterAvatarVideoJobsTable.tenantId,
      profileRecruiterUserId: recruiterAvatarProfilesTable.recruiterUserId,
    })
    .from(recruiterAvatarVideoJobsTable)
    .leftJoin(
      recruiterAvatarProfilesTable,
      eq(recruiterAvatarProfilesTable.id, recruiterAvatarVideoJobsTable.recruiterAvatarProfileId),
    )
    .where(eq(recruiterAvatarVideoJobsTable.id, req.params.id))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  /* Ownership wins: the recruiter who owns the avatar profile can always poll
   * their own render. Without this, a recruiter_admin whose data scope covers
   * client tenants but NOT their own agency tenant (where the job row lives)
   * 404s on the job they just created — the UI shows "processing" forever and
   * the finished video is never persisted. */
  const isOwner = job.profileRecruiterUserId === auth.caller.id;
  if (
    !isOwner &&
    allowedTenants !== null &&
    (!job.tenantId || !allowedTenants.includes(job.tenantId))
  ) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const polled = await pollIntroVideoJob(job.id);
  res.json(serializeJob(polled));
});

/* GET /recruiter-avatar/intro — candidate-experience contract (video | fallback).
   Phase 1: staff-gated for testing. Phase 3 resolves the recruiter from the
   interview and serves this to the authenticated candidate. */
router.get("/recruiter-avatar/intro", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : null;
  const language = typeof req.query.language === "string" ? req.query.language : null;
  if (!jobId || !language) {
    res.status(400).json({ error: "jobId and language are required" });
    return;
  }
  const recruiterUserId =
    typeof req.query.recruiterUserId === "string" ? req.query.recruiterUserId : auth.caller.id;
  // Authorize: a non-self recruiter target must live in the caller's tenant subtree.
  if (recruiterUserId !== auth.caller.id && auth.allowedTenants !== null) {
    const [target] = await controlDb
      .select({ tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(eq(usersTable.id, recruiterUserId))
      .limit(1);
    if (!target || !target.tenantId || !auth.allowedTenants.includes(target.tenantId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  const resp = await getCandidateIntro({ recruiterUserId, jobId, language });
  res.json(resp);
});

/* POST /recruiter-avatar/intro/event — log a candidate intro lifecycle event. */
const EVENT_MAP: Record<string, CandidateEventType> = {
  started: "INTRO_VIDEO_STARTED",
  completed: "INTRO_VIDEO_COMPLETED",
  skipped: "INTRO_VIDEO_SKIPPED",
};
router.post("/recruiter-avatar/intro/event", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const b = req.body ?? {};
  const eventType = EVENT_MAP[String(b.event)];
  if (!eventType) {
    res.status(400).json({ error: "invalid event" });
    return;
  }
  if (typeof b.candidateId !== "string" || typeof b.jobId !== "string") {
    res.status(400).json({ error: "candidateId and jobId are required" });
    return;
  }
  await logCandidateEvent({
    candidateId: b.candidateId,
    jobId: b.jobId,
    tenantId: auth.caller.tenantId ?? "",
    eventType,
    actorType: "candidate",
    source: "interview_agent",
    metadata: typeof b.metadata === "object" && b.metadata ? b.metadata : undefined,
  });
  res.json({ ok: true });
});

export default router;
