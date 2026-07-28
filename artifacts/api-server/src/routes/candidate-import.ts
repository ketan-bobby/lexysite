/**
 * candidate-import.ts
 *
 * POST /api/candidates/import
 *
 * Receives a resume file (PDF or DOCX) from the .NET API, parses it,
 * extracts structured candidate data with AI, uploads the file to S3,
 * and creates or safely updates a candidate record.
 *
 * This is purely additive — it does not modify any existing Lexy
 * candidate flows, employer flows, QOR workflows, AI interview flows,
 * or scoring logic.
 *
 * Auth:    Authorization: Bearer <LEXY_IMPORT_API_KEY>
 * Upload:  multipart/form-data, field name: "resume"
 *          REQUIRED field: "tenantId" — the importing company's tenant UUID.
 *          Optional field: "source" (defaults to "bulk_resume_import")
 *
 * Ruling (July 2026): imported candidates are ALWAYS scoped to the importing
 * company's own pool (pool='tenant'). There is no platform-pool default —
 * platform-wide discovery requires the candidate's own explicit opt-in via
 * the discovery-consent chokepoint.
 *
 * .NET example:
 *   var content = new MultipartFormDataContent();
 *   content.Add(new StreamContent(fileStream), "resume", fileName);
 *   content.Add(new StringContent("dotnet_resume_parser"), "source");
 *   content.Add(new StringContent(tenantId), "tenantId");
 *   await client.PostAsync("/api/candidates/import", content);
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import multer from "multer";
import { createRequire } from "node:module";
import nodeCrypto from "node:crypto";
import mammoth from "mammoth";
import { controlDb, db } from "@workspace/db";
import {
  candidatesTable,
  candidateImportBatchesTable,
  candidateImportRecordsTable,
  usersTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { generateJSON } from "../lib/ai.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { logger } from "../lib/logger.js";
import { getAuthUserId } from "../lib/auth-token";
import { findExistingCandidate } from "../lib/candidate-dedup.js";

const _require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = _require("pdf-parse");

const storage = new ObjectStorageService();

/* ── Multer — accept any single file in the "resume" field ──────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB max
});

const router: IRouter = Router();

/* ── API-key auth middleware ─────────────────────────────────────────────── */

/**
 * Express middleware that validates the import API key on every inbound request.
 *
 * Authentication scheme:
 *   Authorization: Bearer <LEXY_IMPORT_API_KEY>
 *
 * This is a separate key from the Lexy JWT tokens used by the web app —
 * it is specifically for machine-to-machine calls from the .NET importer.
 * The key is stored as an environment secret (LEXY_IMPORT_API_KEY).
 *
 * Returns:
 *   503 if the key has not been configured on the server (misconfiguration)
 *   401 if the request token is missing or does not match the configured key
 */
function requireImportKey(req: any, res: any, next: any) {
  const importKey = process.env.LEXY_IMPORT_API_KEY;
  if (!importKey) {
    logger.warn("[candidate-import] LEXY_IMPORT_API_KEY not configured");
    return res.status(503).json({ error: "Import endpoint not configured — LEXY_IMPORT_API_KEY missing" });
  }
  const auth  = req.headers.authorization as string | undefined;
  const token = auth?.replace(/^Bearer\s+/i, "").trim();
  /* Constant-time comparison (hash both sides to equalize lengths for
   * timingSafeEqual) — prevents recovering the key via a timing side-channel.
   * Same pattern as billing.ts and webhooks.ts. */
  const tokenHash = nodeCrypto.createHash("sha256").update(token ?? "").digest();
  const keyHash = nodeCrypto.createHash("sha256").update(importKey).digest();
  if (!token || !nodeCrypto.timingSafeEqual(tokenHash, keyHash)) {
    return res.status(401).json({ error: "Invalid or missing import API key" });
  }
  next();
}

/* ── Text extraction ─────────────────────────────────────────────────────── */

/**
 * Extract raw plain text from an uploaded resume file.
 *
 * Supported formats:
 *   • PDF  — via pdf-parse (CommonJS, loaded with createRequire to work in ESM)
 *   • DOCX — via mammoth (Microsoft Word Open XML)
 *   • DOC  — via mammoth (legacy Word binary; basic support)
 *
 * The mime type is the primary check, but we also fall back to inspecting
 * the file extension because some clients send incorrect or generic MIME types
 * (e.g. "application/octet-stream" for a PDF).
 *
 * Throws if the format is not recognised — the caller is responsible for
 * catching this and returning a 422 to the client.
 */
async function extractText(file: Express.Multer.File): Promise<string> {
  const name = file.originalname.toLowerCase();
  const mime = file.mimetype;

  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    const parsed = await pdfParse(file.buffer);
    return parsed.text;
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  throw new Error(`Unsupported file type: ${mime || name}. Only PDF and Word documents are accepted.`);
}

/* ── AI-powered resume parser ────────────────────────────────────────────── */

/**
 * Structured fields extracted from a resume by the AI parser.
 * All fields are nullable — the AI is instructed not to invent data,
 * so anything not present in the resume text will be null or [].
 */
interface ParsedResume {
  firstName:      string | null;
  lastName:       string | null;
  email:          string | null;
  phone:          string | null;   // with country code if visible
  location:       string | null;   // city/country as written on the resume
  currentTitle:   string | null;   // most recent job title
  currentCompany: string | null;   // most recent employer
  linkedinUrl:    string | null;   // must start with linkedin.com/in/
  githubUrl:      string | null;   // must start with github.com/
  skills:         string[];        // up to 20 specific technologies/competencies
  experience:     Array<{ title: string; company: string; duration?: string }>;
  education:      Array<{ degree: string; institution: string; year?: number }>;
  summary:        string | null;   // 2-3 sentence professional summary generated by AI
}

/**
 * Run the raw resume text through the AI to extract structured candidate data.
 *
 * The text is truncated to 7000 characters before being sent to the model.
 * This keeps token costs predictable and covers the vast majority of resumes —
 * the most important information (contact details, recent experience, skills)
 * is almost always in the first portion of a CV.
 *
 * The AI is explicitly instructed NOT to invent data, so missing fields will
 * be null rather than hallucinated values.
 *
 * Throws if the AI response cannot be parsed as a valid ParsedResume object.
 */
async function parseResumeWithAI(rawText: string): Promise<ParsedResume> {
  const truncated = rawText.slice(0, 7000);

  return generateJSON<ParsedResume>(
    `You are a precise resume parser. Extract structured candidate data from the resume text below.

RESUME TEXT:
${truncated}

Return JSON with these exact fields (use null or [] for anything not found):
{
  "firstName": string | null,
  "lastName": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "currentTitle": string | null,
  "currentCompany": string | null,
  "linkedinUrl": string | null,
  "githubUrl": string | null,
  "skills": string[] (up to 20 top skills, specific technologies and competencies),
  "experience": [{ "title": string, "company": string, "duration": string | null }],
  "education": [{ "degree": string, "institution": string, "year": number | null }],
  "summary": string | null (2-3 sentence professional summary)
}

Rules:
- currentTitle = most recent job title from experience section
- currentCompany = most recent employer
- phone: include country code if visible
- linkedinUrl: must start with linkedin.com/in/
- githubUrl: must start with github.com/
- Do NOT invent data — only extract what is explicitly in the text`,
    "You are a precise resume/CV parser. Return only valid JSON.",
  );
}

/* ── POST /api/candidates/import ─────────────────────────────────────────── */
router.post(
  "/candidates/import",
  requireImportKey,
  upload.single("resume"),
  async (req: any, res: any) => {
    const file = req.file as Express.Multer.File | undefined;

    /* Multipart form-fields arrive as strings. Validate inline AFTER multer
     * (the validate() middleware can't run pre-multer because req.body
     * doesn't exist until multer parses the multipart envelope). Schema is
     * strict so a caller can't smuggle in stray columns (e.g. `pool`,
     * `tenantName`) hoping a future refactor picks them up. */
    const ImportFields = z.object({
      source: z.string().trim().min(1).max(120).optional(),
      tenantId: z.string().trim().min(1).max(200).optional(),
      /* HRIS/ATS connectors set this to mark imports as current employees.
       * Multer gives us strings only; coerce explicitly to bool. */
      isCurrentEmployee: z.union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0"), z.boolean()]).optional(),
    }).strict();
    const parsedFields = ImportFields.safeParse(req.body ?? {});
    if (!parsedFields.success) {
      return res.status(400).json({
        error: "VALIDATION_FAILED",
        message: "Import form fields did not match the expected schema.",
        issues: parsedFields.error.issues,
      });
    }
    const source = parsedFields.data.source ?? "bulk_resume_import";
    const rawTenantId = parsedFields.data.tenantId ?? null;
    const rawEmployee = parsedFields.data.isCurrentEmployee;
    const isCurrentEmployee =
      rawEmployee === true || rawEmployee === "true" || rawEmployee === "1";

    if (!file) {
      return res.status(400).json({
        error: "No file received. Send the resume as multipart/form-data with field name 'resume'.",
      });
    }

    /* ── Resolve target tenant ────────────────────────────────────────────── */
    // Ruling (July 2026): staff bulk-import NEVER defaults to the shared
    // platform pool. Imported candidates are the importing company's own
    // records (pool='tenant') — they haven't consented to cross-company
    // discovery any more than an applicant has. Platform discovery still
    // requires the explicit candidate opt-in via the discovery-consent
    // chokepoint (if/when they claim a portal account). tenantId is
    // therefore REQUIRED.
    if (!rawTenantId) {
      return res.status(400).json({
        error:
          "tenantId is required. Imported candidates are scoped to the importing company's own pool; " +
          "direct platform-pool placement is not supported — platform discovery requires the candidate's explicit opt-in.",
      });
    }

    const [tenant] = await db
      .select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, rawTenantId))
      .limit(1);

    if (!tenant) {
      return res.status(400).json({
        error: `Tenant not found: "${rawTenantId}". Pass a valid tenant UUID.`,
      });
    }

    const targetTenantId = tenant.id;
    const targetPool = "tenant" as const;
    const targetTenantName: string | null = (tenant as any).name ?? null;

    logger.info(
      { fileName: file.originalname, size: file.size, mime: file.mimetype, targetTenantId, targetPool },
      "[candidate-import] File received",
    );

    /* ── Open a batch record ──────────────────────────────────────────────── */
    const [batch] = await db
      .insert(candidateImportBatchesTable)
      .values({ source, tenantId: rawTenantId })
      .returning();

    /* ── 1. Extract raw text from file ────────────────────────────────────── */
    let rawText = "";
    try {
      rawText = await extractText(file);
    } catch (err: any) {
      logger.warn({ err: err.message }, "[candidate-import] Text extraction failed");
      await db.insert(candidateImportRecordsTable).values({
        batchId:      batch.id,
        fileName:     file.originalname,
        status:       "failed",
        errorMessage: `Text extraction failed: ${err.message}`,
      });
      return res.status(422).json({ error: err.message });
    }

    if (!rawText.trim()) {
      await db.insert(candidateImportRecordsTable).values({
        batchId:      batch.id,
        fileName:     file.originalname,
        status:       "failed",
        errorMessage: "File contained no readable text",
      });
      return res.status(422).json({ error: "File appears to be empty or image-only — no text could be extracted." });
    }

    /* ── 2. AI extraction ─────────────────────────────────────────────────── */
    let parsed: ParsedResume;
    try {
      parsed = await parseResumeWithAI(rawText);
    } catch (err: any) {
      logger.error({ err: err.message }, "[candidate-import] AI parse failed");
      await db.insert(candidateImportRecordsTable).values({
        batchId:      batch.id,
        fileName:     file.originalname,
        status:       "failed",
        errorMessage: `AI parsing failed: ${err.message}`,
      });
      return res.status(500).json({ error: "Failed to parse resume with AI", detail: err.message });
    }

    logger.info(
      { name: `${parsed.firstName} ${parsed.lastName}`, email: parsed.email },
      "[candidate-import] AI extraction complete",
    );

    /* ── 3. Upload file to S3 ─────────────────────────────────────────────── */
    let resumeUrl: string | null = null;
    try {
      resumeUrl = await storage.uploadBuffer(file.buffer, file.mimetype || "application/octet-stream");
      logger.info({ resumeUrl }, "[candidate-import] Resume uploaded to S3");
    } catch (err: any) {
      logger.warn({ err: err.message }, "[candidate-import] S3 upload failed — continuing without resumeUrl");
      // Non-fatal: candidate is still created, just without a stored file link
    }

    /* ── 4. Duplicate detection (scoped to the target tenant) ────────────── */
    // Imports are checked only within the target tenant's own candidates.
    /* Dedup via the shared resolver so import and sourcing agree on identity
     * (LinkedIn → email → phone → name+location). Previously import ignored
     * LinkedIn URL, so a person sourced by LinkedIn and later imported created a
     * duplicate row. */
    const dedupTenantId = targetTenantId;
    const existingCandidate: any = await findExistingCandidate({
      tenantId: dedupTenantId,
      email: parsed.email,
      phone: parsed.phone,
      linkedinUrl: parsed.linkedinUrl,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      location: parsed.location,
    });

    /* ── 5a. Duplicate — safe field update ────────────────────────────────── */
    if (existingCandidate) {
      const updates: Record<string, any> = {};

      if (!existingCandidate.phone        && parsed.phone)        updates.phone        = parsed.phone;
      if (!existingCandidate.location     && parsed.location)     updates.location     = parsed.location;
      if (!existingCandidate.currentTitle && parsed.currentTitle) updates.currentTitle = parsed.currentTitle;
      if (!existingCandidate.currentCompany && parsed.currentCompany) updates.currentCompany = parsed.currentCompany;
      if (!existingCandidate.linkedinUrl  && parsed.linkedinUrl)  updates.linkedinUrl  = parsed.linkedinUrl;
      if (!existingCandidate.resumeUrl    && resumeUrl)           updates.resumeUrl    = resumeUrl;
      if (parsed.skills?.length && !existingCandidate.skills?.length) updates.skills = parsed.skills;

      let status = "duplicate_skipped";
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date();
        await db.update(candidatesTable).set(updates).where(eq(candidatesTable.id, existingCandidate.id));
        status = "duplicate_updated";
      }

      await db.insert(candidateImportRecordsTable).values({
        batchId:     batch.id,
        tenantId:    rawTenantId,
        fileName:    file.originalname,
        status,
        candidateId: existingCandidate.id,
        parsedData:  { ...parsed, resumeUrl, rawTextLength: rawText.length, targetTenantId, targetPool },
      });

      logger.info({ candidateId: existingCandidate.id, status, targetTenantId }, "[candidate-import] Duplicate handled");

      return res.json({
        status,
        candidateId: existingCandidate.id,
        batchId:     batch.id,
        resumeUrl,
        parsed: {
          name:  `${parsed.firstName} ${parsed.lastName}`,
          email: parsed.email,
          title: parsed.currentTitle,
        },
        message:
          status === "duplicate_updated"
            ? "Existing candidate found — missing fields updated"
            : "Existing candidate found — no changes needed",
      });
    }

    /* ── 5b. New candidate ────────────────────────────────────────────────── */
    if (!parsed.firstName || !parsed.lastName) {
      await db.insert(candidateImportRecordsTable).values({
        batchId:      batch.id,
        fileName:     file.originalname,
        status:       "needs_review",
        errorMessage: "Could not extract first/last name from resume",
        parsedData:   { ...parsed, resumeUrl },
      });
      return res.status(422).json({
        error:   "Could not determine candidate name from the resume",
        batchId: batch.id,
        status:  "needs_review",
        parsed,
      });
    }

    try {
      const [newCandidate] = await db
        .insert(candidatesTable)
        .values({
          tenantId:       targetTenantId,
          firstName:      parsed.firstName.trim(),
          lastName:       parsed.lastName.trim(),
          email:          parsed.email?.trim() ?? `noemail_${nodeCrypto.randomUUID()}@import.local`,
          phone:          parsed.phone          ?? null,
          location:       parsed.location       ?? null,
          currentTitle:   parsed.currentTitle   ?? null,
          currentCompany: parsed.currentCompany ?? null,
          linkedinUrl:    parsed.linkedinUrl    ?? null,
          githubUrl:      parsed.githubUrl      ?? null,
          skills:         parsed.skills         ?? [],
          resumeUrl:      resumeUrl             ?? null,
          source:         isCurrentEmployee ? "hris_sync" : "bulk_resume_import",
          pool:           targetPool,
          isCurrentEmployee,
        })
        .returning();

      // TODO: Future step — trigger AI enrichment and embeddings after successful import.

      await db.insert(candidateImportRecordsTable).values({
        batchId:     batch.id,
        tenantId:    rawTenantId,
        fileName:    file.originalname,
        status:      "imported",
        candidateId: newCandidate.id,
        parsedData:  { ...parsed, resumeUrl, rawTextLength: rawText.length, targetTenantId, targetPool },
      });

      logger.info({ candidateId: newCandidate.id, targetTenantId, targetPool }, "[candidate-import] New candidate created");

      return res.status(201).json({
        status:      "imported",
        candidateId: newCandidate.id,
        batchId:     batch.id,
        resumeUrl,
        tenantId:    targetTenantId,
        pool:        targetPool,
        tenantName:  targetTenantName,
        parsed: {
          name:     `${parsed.firstName} ${parsed.lastName}`,
          email:    parsed.email,
          phone:    parsed.phone,
          location: parsed.location,
          title:    parsed.currentTitle,
          company:  parsed.currentCompany,
          skills:   parsed.skills?.slice(0, 5),
        },
        message: `Candidate created successfully — proprietary to ${targetTenantName ?? targetTenantId}`,
      });
    } catch (err: any) {
      // A same-email candidate already exists in this tenant (the name/location
      // pre-check above won't catch an email-only match, and the
      // (tenant, lower(email)) unique index enforces it). Rather than 500, treat
      // it as a duplicate: re-select the existing row, fill in any missing
      // fields, and report it as handled — never create a second row.
      if (err?.code === "23505" && parsed.email) {
        const emailLower = parsed.email.trim().toLowerCase();
        const [dupe] = await db.select().from(candidatesTable)
          .where(and(eq(candidatesTable.tenantId, targetTenantId), sql`lower(${candidatesTable.email}) = ${emailLower}`))
          .limit(1);
        if (dupe) {
          const updates: Record<string, any> = {};
          if (!dupe.phone          && parsed.phone)          updates.phone          = parsed.phone;
          if (!dupe.location       && parsed.location)       updates.location       = parsed.location;
          if (!dupe.currentTitle   && parsed.currentTitle)   updates.currentTitle   = parsed.currentTitle;
          if (!dupe.currentCompany && parsed.currentCompany) updates.currentCompany = parsed.currentCompany;
          if (!dupe.linkedinUrl    && parsed.linkedinUrl)    updates.linkedinUrl    = parsed.linkedinUrl;
          if (!dupe.githubUrl      && parsed.githubUrl)      updates.githubUrl      = parsed.githubUrl;
          if (!dupe.resumeUrl      && resumeUrl)             updates.resumeUrl      = resumeUrl;
          if (parsed.skills?.length && !dupe.skills?.length) updates.skills         = parsed.skills;
          let status = "duplicate_skipped";
          if (Object.keys(updates).length > 0) {
            updates.updatedAt = new Date();
            await db.update(candidatesTable).set(updates).where(eq(candidatesTable.id, dupe.id));
            status = "duplicate_updated";
          }
          await db.insert(candidateImportRecordsTable).values({
            batchId:     batch.id,
            tenantId:    rawTenantId,
            fileName:    file.originalname,
            status,
            candidateId: dupe.id,
            parsedData:  { ...parsed, resumeUrl, rawTextLength: rawText.length, targetTenantId, targetPool },
          });
          logger.info({ candidateId: dupe.id, status, targetTenantId }, "[candidate-import] Duplicate handled (email match on insert)");
          return res.json({
            status,
            candidateId: dupe.id,
            batchId:     batch.id,
            resumeUrl,
            parsed: { name: `${parsed.firstName} ${parsed.lastName}`, email: parsed.email, title: parsed.currentTitle },
            message: status === "duplicate_updated"
              ? "Existing candidate found — missing fields updated"
              : "Existing candidate found — no changes needed",
          });
        }
      }
      logger.error({ err: err.message }, "[candidate-import] DB insert failed");
      await db.insert(candidateImportRecordsTable).values({
        batchId:      batch.id,
        fileName:     file.originalname,
        status:       "failed",
        errorMessage: err.message,
        parsedData:   { ...parsed, resumeUrl },
      });
      return res.status(500).json({ error: "Failed to save candidate", detail: err.message });
    }
  },
);

/* ── GET /api/candidates/import/admin-stats (Lexy JWT — for UI) ──────────── */
router.get("/candidates/import/admin-stats", async (req: any, res: any) => {
  const auth  = req.headers.authorization as string | undefined;
  const token = auth?.replace("Bearer ", "");
  const userId = getAuthUserId(req);
  if (!userId) return res.status(403).json({ error: "Forbidden" });

  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!u || u.role !== "platform_admin") return res.status(403).json({ error: "Forbidden" });

  const PAGE_SIZE = 20;
  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [statusRows, [{ totalRecords }], recentRecords] = await Promise.all([
    db.select({
        status: candidateImportRecordsTable.status,
        count:  sql<number>`cast(count(*) as int)`,
      })
      .from(candidateImportRecordsTable)
      .groupBy(candidateImportRecordsTable.status),

    db.select({ totalRecords: sql<number>`cast(count(*) as int)` })
      .from(candidateImportRecordsTable),

    db.select()
      .from(candidateImportRecordsTable)
      .orderBy(sql`${candidateImportRecordsTable.createdAt} DESC`)
      .limit(PAGE_SIZE)
      .offset(offset),
  ]);

  const totals = statusRows.reduce(
    (acc, r) => { acc[r.status] = r.count; acc.total += r.count; return acc; },
    { total: 0 } as Record<string, number>,
  );

  return res.json({
    totals,
    recentRecords,
    pagination: {
      page,
      pageSize:   PAGE_SIZE,
      totalItems: totalRecords,
      totalPages: Math.ceil(totalRecords / PAGE_SIZE),
    },
  });
});

export default router;
