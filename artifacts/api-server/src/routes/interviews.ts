/**
 * routes/interviews.ts — Interview Plans, Sessions & Real-time Transcription
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * All routes that support the end-to-end AI interview flow: creating and
 * managing interview plans per job, running live interview sessions with
 * real-time speech transcription, and generating AI assessments afterward.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /interviews/transcribe              STT: audio chunk → transcript text
 *                                            Primary: Azure Speech SDK
 *                                            Fallback: OpenAI Whisper
 *   POST /interviews/plans                   Create an interview plan for a job
 *   GET  /interviews/plans/:jobId            Fetch plan for a job
 *   PUT  /interviews/plans/:id               Update plan (type, questions, config)
 *   POST /interviews/plans/:id/generate      AI-generate questions for a plan
 *   GET  /interviews/sessions                List sessions (tenant-scoped)
 *   POST /interviews/sessions                Create a new session (sends invite)
 *   GET  /interviews/sessions/:id            Get session + full transcript
 *   POST /interviews/sessions/:id/complete   Trigger AI assessment after interview
 *   POST /interviews/sessions/:id/start      Mark session as "in_progress"
 *   GET  /interviews/sessions/:id/result     Get completed assessment result
 *   POST /interviews/sessions/:id/notify     Send in-app notification to recruiter
 *   GET  /interviews/schedules               List all scheduled interviews
 *   POST /interviews/schedules               Create a scheduled interview slot
 *   GET  /interviews/schedules/:id           Get schedule details
 *   PUT  /interviews/schedules/:id           Update schedule (time, notes, etc.)
 *   DELETE /interviews/schedules/:id         Cancel a scheduled interview
 *
 * ─── Whisper hallucination filter ────────────────────────────────────────────
 * cleanWhisperOutput() strips known Whisper model hallucinations ("Thanks for
 * watching!", CJK / Indic copy-paste garbage) that appear when audio is short,
 * silent, or in an unexpected language. The filter checks known phrases AND a
 * mixed-script detector (3+ non-Latin scripts in one utterance = hallucination).
 *
 * ─── STT language handling ───────────────────────────────────────────────────
 * The client sends X-Language: <BCP-47> (e.g. "ar-AE"). Azure Speech uses the
 * header directly. Whisper receives just the ISO 639-1 base code ("ar").
 * cleanWhisperOutput() also runs a script-mismatch check: if the expected
 * language uses a non-Latin script but the output is mostly Latin → discard.
 *
 * ─── AI assessment (complete endpoint) ───────────────────────────────────────
 * Builds a prompt from the full conversation transcript + interview plan
 * questions, asks GPT-4o to produce a structured assessment (score, strengths,
 * concerns, recommendation), saves to interview_summaries, updates
 * applications.stage and calls upsertIntelligenceFromInterviewSession().
 */
import { Router, type IRouter } from "express";
import { controlDb, db } from "@workspace/db";
import {
  interviewPlansTable,
  interviewSessionsTable,
  interviewSummariesTable,
  interviewSchedulesTable,
  applicationsTable,
  candidatesTable,
  jobsTable,
  userNotificationsTable,
  sourcedCandidatesTable,
  trustEventsTable,
  aiDecisionLogTable,
  tenantsTable,
  candidateAiConsentTable,
} from "@workspace/db";
import { resolveCandidateIntro } from "../lib/recruiter-intro-video";
import { eq, desc, inArray, or, and, sql } from "drizzle-orm";
import { resolveUser } from "../middlewares/resolveUser";
import {
  getAllowedTenantIds,
  getRecruiterAssignedJobIds,
  getDataScopeTenantIds,
} from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { usersTable } from "@workspace/db";
import OpenAI from "openai";
import {
  generateWithAI,
  generateJSON,
  SUPPORTED_LANGUAGES,
  resolveLangMeta,
  azureSpeechConfigured,
} from "../lib/ai";
import { upsertIntelligenceFromInterviewSession } from "../lib/intelligence";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import { FAIRNESS_DIRECTIVE } from "../lib/fairness";
import { interviewInviteTips, inviteEmailHtml } from "../lib/interview-invite-copy";
import { logger } from "../lib/logger";
import { isJobApprovedForInterview, JOB_NOT_APPROVED_MESSAGE } from "../lib/job-approval";
import {
  recordSttRequest,
  getSttMetrics,
  getSttTrends,
  getSttWindowSnapshot,
  type SttProvider,
} from "../lib/stt-metrics";
import { getSttAlertConfig } from "../lib/stt-alert-scheduler";
import { transcribeAudio } from "../lib/transcribe";
import { getTtsAccounts, pickAccount, noteSuccess, noteFailure } from "../lib/azure-pool";
import { admit } from "../lib/admission";
import {
  checkInterviewCreationAllowed,
  buildLimitExceededBody,
  recordCreditEvent,
} from "../lib/plan-enforcement";
import { getAuthUserId, issueToken } from "../lib/auth-token";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import {
  requireInterviewSessionCookie,
  bindOrResumeOnBegin,
  clearOnComplete,
  generateOtp,
  hashOtp,
  fingerprintFor,
  setSessionCookie,
  newNonce,
  STEP_UP_OTP_TTL_MIN,
  STEP_UP_MAX_ATTEMPTS,
  INTERVIEW_SESSION_TTL_HOURS,
  recordTrustEvent,
  TrustEventType,
} from "../lib/interview-session-cookie";
import { sendEmail, plainToHtml, isEmailConfigured } from "./../lib/email";
import nodeCrypto from "crypto";
import { z } from "zod";
import { validate } from "../middlewares/validate";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { enqueueAiJob } from "../lib/ai-queue/queue";

const router: IRouter = Router();

/* ── Inline Zod request-body schemas ─────────────────────────────────────── */
const TtsBody = z.object({
  text: z.string().min(1),
  language: z.string().optional(),
});

const ConverseBody = z
  .object({
    history: z.array(z.record(z.unknown())).optional(),
    questionNumber: z.number().optional(),
    totalQuestions: z.number().optional(),
  })
  .passthrough();

const SaveTurnBody = z
  .object({
    questionText: z.string().optional(),
    answerText: z.string().optional(),
    turnNumber: z.number().optional(),
  })
  .passthrough();

const WorkAuthBody = z
  .object({
    answerText: z.string().max(4000).optional(),
  })
  .passthrough();

const CreatePlanBody = z
  .object({
    jobId: z.string().min(1),
    interviewType: z.string().optional(),
    questionCount: z.number().optional(),
    language: z.string().optional(),
  })
  .passthrough();

const PatchRecordingBody = z
  .object({
    objectPath: z.string().min(1),
  })
  .passthrough();

const RecruiterCommentsBody = z.object({
  comments: z.string().max(8000),
});

const CulturalConfigBody = z
  .object({
    culturalDoc: z.string().optional(),
    customQuestions: z.array(z.string()).optional(),
  })
  .passthrough();

const GenerateLinkBody = z
  .object({
    jobId: z.string().min(1),
    candidateId: z.string().optional(),
    interviewType: z.string().optional(),
    questionCount: z.number().optional(),
    language: z.string().optional(),
    applicationId: z.string().optional(),
    roleTitle: z.string().optional(),
    culturalDoc: z.string().optional(),
    customQuestions: z.array(z.string()).optional(),
    focusDirective: z.string().max(2000).optional(),
    difficulty: z.string().optional(),
    /* Explicit "mint a fresh link even though a live one exists" — expires the
     existing live session and issues a new one. Absent/false = idempotent:
     a live session for this (candidate, job, type) is returned unchanged. */
    regenerate: z.boolean().optional(),
  })
  .passthrough();

const SubmitCodeBody = z
  .object({
    questionId: z.string().min(1),
    code: z.string(),
    language: z.string().optional(),
  })
  .passthrough();

const StartInterviewBody = z
  .object({
    applicationId: z.string().optional(),
    planId: z.string().min(1),
    candidateId: z.string().optional(),
  })
  .passthrough();

const StepUpVerifyBody = z
  .object({
    otp: z.string().min(1),
  })
  .passthrough();

const AnswerBody = z
  .object({
    questionId: z.string().min(1),
    answerText: z.string(),
  })
  .passthrough();

const ProctorEventBody = z
  .object({
    type: z.string().min(1),
    detail: z.unknown().optional(),
    snapshotBase64: z.string().optional(),
  })
  .passthrough();

const CreateScheduleBody = z
  .object({
    applicationId: z.string().min(1),
    interviewerId: z.string().optional().nullable(),
    interviewerName: z.string().optional().nullable(),
    location: z.string().optional().nullable(),
    scheduledAt: z.string().min(1),
    durationMinutes: z.number().optional(),
    type: z.string().min(1),
    notes: z.string().optional().nullable(),
  })
  .passthrough();

/* Strict allowlist for PUT /coordinator/schedules/:scheduleId.
 *
 * Unknown keys are stripped — tenantId, id, applicationId, createdAt
 * cannot be remapped via this route. scheduledAt is a string here and
 * coerced to Date in the handler. */
const UpdateScheduleBody = z.object({
  interviewerId: z.string().nullable().optional(),
  interviewerName: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  scheduledAt: z.string().optional(),
  durationMinutes: z.number().int().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().nullable().optional(),
  feedbackRating: z.number().int().nullable().optional(),
  feedbackNotes: z.string().nullable().optional(),
});

const FeedbackBody = z
  .object({
    rating: z.number(),
    notes: z.string().optional().nullable(),
  })
  .passthrough();

/* ── STT: audio → transcript via Azure Speech (primary) / Whisper (fallback)
 * Skipped Zod body validation: req.body is a raw audio Buffer (binary upload),
 * not JSON, so an object schema would never apply.
 *
 * SESSION + CONSENT GATE (Check 3 closure): this route processes candidate
 * VOICE AUDIO, so it must not be callable without a server-verified,
 * consent-backed interview session. It is bound under the session path so the
 * path-scoped HMAC cookie (minted only by /begin, which itself requires
 * consent) is presented, verified by requireInterviewSessionCookie, and the
 * consent row is RE-CHECKED here so a mid-session revocation stops further
 * audio processing. admit() (capacity control) runs after auth so
 * unauthorized calls never consume STT capacity. */
/* ── Per-request AI-consent re-check (mid-session revocation gate) ─────────
 * The session cookie proves the candidate passed the consent-gated /begin
 * once, but consent can be revoked mid-interview from the portal. Every
 * runtime route that CAPTURES or PROCESSES candidate interview data must
 * re-verify the consent row per request so revocation halts the session
 * immediately on ALL paths (not just mobile server-STT). 412 with the
 * structured code — the room client's requireConsent() resets the UI to the
 * consent gate. Must run AFTER requireInterviewSessionCookie (relies on
 * req.interviewSession). Demo/default sessions are exempt inside
 * hasActiveAiConsent, same as the /begin gate. */
async function requireActiveAiConsent(req: any, res: any, next: any): Promise<void> {
  try {
    const { hasActiveAiConsent, CURRENT_AI_CONSENT_VERSION } = await import("../lib/ai-consent.js");
    if (!(await hasActiveAiConsent(req.interviewSession?.candidateId))) {
      res
        .status(412)
        .json({ error: "AI_CONSENT_REQUIRED", consentVersion: CURRENT_AI_CONSENT_VERSION });
      return;
    }
    next();
  } catch (err) {
    /* Fail closed: if the consent check itself errors we must not process
       candidate data on an unverified consent state. */
    logger.error(
      { err, interviewId: req.params?.interviewId },
      "[interviews] consent re-check failed",
    );
    res.status(500).json({ error: "consent_check_failed" });
  }
}

router.post(
  "/interviews/:interviewId/transcribe",
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  admit(),
  async (req, res) => {
    const startedAt = Date.now();
    const contentType = (req.headers["content-type"] as string) || "audio/webm;codecs=opus";
    const ctBase = contentType.split(";")[0].trim().toLowerCase();
    const rawLang = (req.headers["x-language"] as string) || "en-US";
    /* Optional priming context: the answer transcribed so far for THIS question.
     Passed to Whisper to anchor the next segment and curb hallucination on
     short/quiet clips. Capped here as a cheap guard; transcribeAudio caps again
     to the model's prompt budget. */
    const rawPrompt = req.headers["x-prompt"];
    let prompt: string | undefined;
    if (typeof rawPrompt === "string" && rawPrompt) {
      /* The client URL-encodes the priming text (HTTP headers are latin1-only). */
      try {
        prompt = decodeURIComponent(rawPrompt).slice(0, 2000);
      } catch {
        prompt = undefined;
      }
    }

    /* All format routing + Azure→Whisper fallback lives in transcribeAudio() so
     it can be unit-tested without HTTP/DB/credentials. It never throws — any
     provider failure resolves to an empty transcript. */
    const { transcript, provider } = await transcribeAudio({
      buf: req.body as Buffer,
      contentType,
      rawLang,
      prompt,
    });

    recordSttRequest({
      format: ctBase,
      provider,
      empty: transcript.trim().length === 0,
      latencyMs: Date.now() - startedAt,
      language: rawLang,
    });
    res.json({ transcript });
  },
);

/* ── STT quality metrics — review the empty-transcript rate, provider mix and
 * latency. `live` is the in-process counter (resets on restart); `history` is
 * per-day buckets read from the persisted stt_transcribe_events table so trends
 * survive restarts (?days=N, default 30, max 365). Aggregate counts with no
 * candidate data, so it stays unauthenticated (unlike /:interviewId/transcribe,
 * which is session-cookie + consent gated). The
 * history read is fail-soft (empty daily[] on DB error). */
router.get("/interviews/transcribe/metrics", async (req, res) => {
  const days = Number.parseInt((req.query.days as string) ?? "", 10);
  const history = await getSttTrends(Number.isFinite(days) ? days : 30);

  /* The rolling-window snapshot is what the alert scheduler actually evaluates,
     so the admin dashboard can visually confirm a fired alert. Default the
     window to the scheduler's configured window (?windowMin=N overrides, 1..1440)
     and ship the alert thresholds alongside so the UI can flag a breach. */
  const alertConfig = getSttAlertConfig();
  const windowMinParam = Number.parseInt((req.query.windowMin as string) ?? "", 10);
  const windowMin =
    Number.isFinite(windowMinParam) && windowMinParam > 0
      ? Math.min(windowMinParam, 24 * 60)
      : alertConfig.windowMin;
  const window = { windowMin, ...getSttWindowSnapshot(windowMin * 60_000) };

  /* Spread live counters at the top level for backward compatibility, and add
     `window` (rolling snapshot the alerts watch), `alertConfig` (trip points)
     and `history` (persisted per-day trends that survive restarts). */
  res.json({ ...getSttMetrics(), window, alertConfig, history });
});

/* ── TTS: text → mp3 via Azure Neural TTS (primary) / OpenAI TTS (fallback) */
router.post("/interviews/tts", validate({ body: TtsBody }), admit(), async (req, res) => {
  const { text, language = "en-US" } = req.body;
  if (!text) {
    res.status(400).json({ error: "text required" });
    return;
  }
  try {
    const langMeta = resolveLangMeta(language);

    /* ── ElevenLabs multilingual TTS (per-language primary) ───────────────── */
    /* Languages whose meta sets ttsProvider:"elevenlabs" (e.g. Filipino) get
       ElevenLabs' multilingual voice first — Azure's voice for them is weak or
       missing. Any failure/timeout falls through to the normal Azure → OpenAI
       chain below, so this branch can never freeze an interview. */
    if (langMeta.ttsProvider === "elevenlabs" && process.env.ELEVENLABS_API_KEY) {
      const voiceId =
        process.env.ELEVENLABS_TTS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; /* Sarah — warm female */
      const elAc = new AbortController();
      const elTo = setTimeout(() => elAc.abort(), 9000);
      try {
        const elRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_96`,
          {
            method: "POST",
            headers: {
              "xi-api-key": process.env.ELEVENLABS_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
            signal: elAc.signal,
          },
        );
        if (elRes.ok) {
          const buffer = Buffer.from(await elRes.arrayBuffer());
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Length", buffer.length);
          res.send(buffer);
          return;
        }
        logger.warn(
          { status: elRes.status, language },
          "[TTS] ElevenLabs failed — falling back to Azure/OpenAI",
        );
      } catch (err: any) {
        logger.warn(
          { err: err?.message, language },
          "[TTS] ElevenLabs errored/timed out — falling back to Azure/OpenAI",
        );
      } finally {
        clearTimeout(elTo);
      }
    }

    /* ── Azure Neural TTS (preferred) ──────────────────────────────────────── */
    /* TTS draws on its OWN pool of Azure account(s) — separate from STT — so
       speech-to-text and Lexy's voice never starve each other's per-region
       concurrency quota. getTtsAccounts() prefers the dedicated AZURE_TTS_* /
       AZURE_TTS_KEYS accounts and falls back to the shared AZURE_SPEECH_* creds
       so nothing breaks until a dedicated TTS key is configured. Each account's
       key+region travel together as a pair (never mix a TTS key with an STT
       region), and a per-account breaker isolates a throttled account. When all
       accounts are tripped, pickAccount returns null → fall through to OpenAI. */
    const picked = pickAccount("tts", getTtsAccounts());
    if (picked) {
      const key = picked.account.key;
      const region = picked.account.region;
      /* Lexy is always British — override to her voice for all English interviews.
         AdaMultilingual is a young, natural-sounding British female (the older
         LibbyNeural read as matronly), keeping Lexy warm but contemporary. */
      const isEnglish = langMeta.family === "english";
      const voice = isEnglish ? "en-GB-AdaMultilingualNeural" : langMeta.azureVoice;
      const locale = isEnglish ? "en-GB" : langMeta.azureLocale;

      /* Warm, alluring delivery: an unhurried, relaxed pace with a slightly LOWER,
         richer pitch reads as smooth, confident and lovely to listen to. The earlier
         raised-pitch tuning (+10%) read as peppy/shrill rather than warm, so we drop
         the pitch a touch below natural and slow the rate for an intimate, easy cadence.
         Applied via prosody so it works on EVERY voice (express-as styles are only
         supported by a handful of voices). */
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${voice}'><prosody rate='-7%' pitch='-3%'>${escaped}</prosody></voice></speak>`;

      /* Bound the Azure call so a hung TTS provider can't freeze the interview —
         on timeout we abort and fall through to the OpenAI fallback below. */
      const azureAc = new AbortController();
      const azureTo = setTimeout(() => azureAc.abort(), 8000);
      let ttsRes: Response;
      let threw = false;
      try {
        ttsRes = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
          },
          body: ssml,
          signal: azureAc.signal,
        });
      } catch {
        threw = true;
        ttsRes = new Response(null, { status: 504 }); /* timeout/abort → fall through */
      } finally {
        clearTimeout(azureTo);
      }

      if (ttsRes.ok) {
        noteSuccess(picked.breakerKey);
        const buffer = Buffer.from(await ttsRes.arrayBuffer());
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Length", buffer.length);
        res.send(buffer);
        return;
      }
      /* Azure TTS failed (HTTP error or timeout/abort) — count it toward the
         account's breaker and fall through to OpenAI. */
      noteFailure(picked.breakerKey, picked.account?.id);
      logger.warn(
        { status: ttsRes.status, account: picked.account?.id, aborted: threw },
        "[TTS] Azure failed — falling back to OpenAI",
      );
    }

    /* ── OpenAI TTS fallback ────────────────────────────────────────────────── */
    /* Use direct OpenAI API (no proxy base URL) — the Replit AI proxy does not
       support the audio/speech endpoint and will 500 if baseURL is overridden. */
    const ttsApiKey = process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!ttsApiKey) {
      res.status(503).json({ error: "TTS not configured" });
      return;
    }
    const openai = new OpenAI({ apiKey: ttsApiKey, timeout: 12000, maxRetries: 1 });
    const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "shimmer", input: text });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: "TTS failed", detail: err?.message });
  }
});

/* ── Converse: organic AI-driven conversation ──────────────────────────────
   Rate-limited because every call hits the LLM (cost) and produces TTS audio
   (bandwidth + cost). 60 turns / minute is generous for a real interview but
   shuts down a runaway client / token-burner. */
import { rateLimit } from "../middlewares/rateLimit";
import { requireSameOriginPost } from "../middlewares/requireSameOriginPost";

/* Two-tier farewell detection — MUST stay in sync with room.tsx. The STT
   transcript of a normal substantive answer routinely contains "that's all",
   "nothing more", "we're done", "I'm finished" etc. (about a project, not the
   interview); treating those as a farewell ended interviews early at random
   question counts. STRONG signals are explicit and always close; WEAK signals
   only close when the whole utterance is short (a genuine sign-off). */
const STRONG_FAREWELL_RE =
  /\b(good\s?bye|end (?:the |this )?interview|that concludes (?:the |this )?interview)\b/i;
const WEAK_FAREWELL_RE =
  /\b(bye(?:\s?bye)?|see (?:you|ya)|that'?s (?:all|it|everything)|that is (?:all|it|everything)|i'?m (?:all )?done|i am done|i'?m finished|i'?m all set|nothing (?:else|more|further)|no (?:more|further) questions|we'?re done|let'?s (?:wrap|end)|wrap (?:it|this) up|i (?:have to|need to|gotta|got to)\s+(?:go|leave)\b(?!\s+to\b))\b/i;
const FAREWELL_WEAK_MAX_WORDS = 8;
function candidateWantsToEnd(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (STRONG_FAREWELL_RE.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= FAREWELL_WEAK_MAX_WORDS && WEAK_FAREWELL_RE.test(t);
}

/* Interview /begin: session-minting endpoint. Two complementary limiters to
 * balance abuse-resistance against NAT false-positives:
 *
 *   - Per-IP cap is intentionally generous (60/15m) because real candidate
 *     traffic clusters behind shared NAT — a corporate office, university
 *     library, hiring event venue, or carrier-grade NAT can put 20+ real
 *     candidates on the same egress IP. The old 10/15m would have rejected
 *     legitimate cohorts.
 *   - Per-interview cap is tight (8/15m). A real candidate starts an
 *     interview once and resumes a handful of times; an attacker probing
 *     fingerprints against ONE session ID gets cut off fast.
 *
 * The combination means: an attacker who has obtained 5 interview IDs can
 * still only make 40 attempts in 15m before the IP limit kicks in too, and
 * cannot focus all of those on a single victim session. */
const beginIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 60,
  scope: "interviews-begin-ip",
});
const beginInterviewLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 8,
  scope: "interviews-begin-id",
  keyFn: (req) => `begin:${req.params.interviewId || "missing"}`,
});

router.post(
  "/interviews/:interviewId/converse",
  rateLimit({
    windowMs: 60_000,
    max: 60,
    keyFn: (req) => req.params.interviewId || req.ip || "anon",
  }),
  validate({ body: ConverseBody }),
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  admit(),
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const { history = [], questionNumber = 1, totalQuestions = 8 } = req.body;

    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const [plan] = await db
      .select()
      .from(interviewPlansTable)
      .where(eq(interviewPlansTable.id, session.planId))
      .limit(1);

    /* ── Fetch job + candidate in parallel ── */
    const jobId = plan?.jobId;
    const [jobRows, candidateRows] = await Promise.all([
      jobId
        ? db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1)
        : Promise.resolve([] as (typeof jobsTable.$inferSelect)[]),
      session.candidateId && session.candidateId !== "demo"
        ? db
            .select()
            .from(candidatesTable)
            .where(eq(candidatesTable.id, session.candidateId))
            .limit(1)
        : Promise.resolve([] as (typeof candidatesTable.$inferSelect)[]),
    ]);
    const [jobRow] = jobRows;

    let candidateCtxBlock = "";
    if (session.candidateId && session.candidateId !== "demo") {
      const [candidate] = candidateRows;
      if (candidate) {
        const parts = [
          `Candidate: ${candidate.firstName} ${candidate.lastName}`,
          candidate.currentTitle ? `Current Title: ${candidate.currentTitle}` : null,
          candidate.currentCompany ? `Current Company: ${candidate.currentCompany}` : null,
          candidate.location ? `Location: ${candidate.location}` : null,
          candidate.skills?.length ? `Skills: ${candidate.skills.join(", ")}` : null,
        ].filter(Boolean);
        candidateCtxBlock = `\n\nCANDIDATE BACKGROUND (use this to ask informed, personalised follow-ups):\n${parts.join("\n")}`;
      }
    }

    let jobCtxBlock = "";
    if (jobRow) {
      jobCtxBlock = `\n\nROLE BEING INTERVIEWED FOR:\nTitle: ${jobRow.title}${jobRow.department ? ` | Dept: ${jobRow.department}` : ""}\n${jobRow.description.slice(0, 1200)}`;
    }

    const language = session.language ?? "en-US";
    const langLabel = resolveLangMeta(language).label;
    const interviewType = plan?.interviewType ?? "general";
    const jobTitle = jobRow?.title ?? plan?.title?.replace(/\s*—.*$/, "") ?? "this role";

    /* Close out the interview when we've exhausted the planned questions OR when
     the candidate has clearly signalled they want to end (said goodbye / "that's
     all" / "I'm done"). Without the farewell check, the agent would say goodbye
     back but the loop kept waiting for another answer. */
    const lastCandidateText: string =
      [...history].reverse().find((h: any) => h.role === "candidate")?.text ?? "";
    const candidateFarewell =
      !(questionNumber === 1 && history.length === 0) && candidateWantsToEnd(lastCandidateText);
    const isClosing = questionNumber > totalQuestions || candidateFarewell;
    const isOpening = questionNumber === 1 && history.length === 0;

    const historyText =
      history.length > 0
        ? history
            .map((h: any) => `${h.role === "ai" ? "Lexy" : "Candidate"}: ${h.text}`)
            .join("\n\n")
        : "";

    const topicGuide: Record<string, string> = {
      general:
        "background and career journey, motivations, key experiences, working style, challenges overcome, goals",
      technical:
        "technical depth, problem-solving approaches, past projects, architectural thinking, tools and technologies",
      behavioral:
        "specific past situations, the actions taken, outcomes achieved, collaboration, leadership moments, conflict resolution",
      competency:
        "demonstrated skills, knowledge applied in real scenarios, growth areas, how they handle ambiguity",
      cultural:
        "alignment with our values, how they handle disagreement and feedback, what kind of team environment they thrive in, examples of living the values they care about, how they've shaped or contributed to a team's culture",
      programming:
        "how they approach a coding problem from scratch, how they reason about edge cases, trade-offs they consider in design, debugging stories, code-quality habits, testing discipline, language/runtime depth",
    };
    const topics = topicGuide[interviewType] ?? topicGuide.general;

    /* Recruiter focus direction — steer the live agent's follow-ups toward the
     job-relevant competency the recruiter asked about, while keeping the EEO
     guardrail below fully intact. */
    const focusDir = (plan?.focusDirective ?? "").toString().trim();
    const focusBlock = focusDir
      ? `\n\nRECRUITER FOCUS (steer your follow-ups here): the recruiter specifically wants to understand the candidate's "${focusDir}". Treat this as a job-relevant competency and look for natural openings to observe it — e.g. ask for concrete examples that would reveal it. Never ask about personality labels or anything in the equal-opportunity list below.`
      : "";

    /* Recruiter custom questions — verbatim questions the recruiter wants asked
     during this interview (set in the Workflow configurator or the pipeline
     Interview-setup control). Stored on the plan's culturalConfig bag for all
     interview types. We instruct Lexy to weave them in naturally; the EEO
     guardrail below still overrides anything that would breach it. */
    const recruiterQuestions: string[] = Array.isArray(
      (plan?.culturalConfig as any)?.customQuestions,
    )
      ? ((plan!.culturalConfig as any).customQuestions as any[])
          .map((q) => (q ?? "").toString().trim())
          .filter(Boolean)
      : [];
    const customQBlock = recruiterQuestions.length
      ? `\n\nRECRUITER QUESTIONS (you MUST cover each of these during the interview, phrased naturally and conversationally — do not read them verbatim as a list, and weave them in at sensible moments):\n${recruiterQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\nIf you have not yet asked one of these and the conversation is winding down, ask it before closing. Never ask anything from the equal-opportunity list below, even if a recruiter question seems to point there.`
      : "";

    let directive: string;
    if (isOpening) {
      directive = `You're opening a job interview. Greet the candidate professionally and warmly — introduce yourself as Lexy, let them know the interview will take about 30 minutes, and then ask your first interview question directly. Do NOT explain the process, do NOT coach them, do NOT tell them to relax — just welcome them, mention the 30 minutes, and ask the first question. 3-4 sentences total.`;
    } else if (isClosing) {
      directive = `The conversation has naturally run its course. Wrap up warmly — thank the candidate genuinely for sharing so much, mention one specific thing that stood out from the conversation, and let them know the hiring team will be in touch. 2-3 sentences, genuine and human.`;
    } else {
      directive = `Continue the conversation naturally based on what the candidate just said. You may:
- Dig deeper into something interesting they mentioned ("That's fascinating — when you say X, can you walk me through what that actually looked like?")
- Explore a new area you haven't touched on yet from: ${topics}
- Ask a follow-up that shows you genuinely listened ("You mentioned Y earlier — how did that shape how you approach Z?")

Do NOT ask a rigid "next question". React like a curious, engaged human interviewer who is genuinely interested in this person. Keep it to 2-4 sentences. Never refer to question numbers or say things like "my next question is".`;
    }

    /* NOTE: The EEO guardrail below stays FULLY intact — the assessed conversation
     must NEVER ask about work authorization / sponsorship, because anything asked
     here is scored. Work-eligibility logistics are instead captured by a separate,
     non-scored step (GET/POST /interviews/:id/work-auth) that runs after the
     assessed questions and never writes into session.answers. */
    const systemPrompt = `You are Lexy, a warm, charming, and genuinely engaging AI interviewer conducting a real job interview for: ${jobTitle} (${interviewType} interview). Lexy is a British woman in her late 20s — she uses she/her pronouns. She has the kind of voice and presence that instantly puts people at ease: relaxed, lovely to talk to, quietly confident, and genuinely curious about the person in front of her. She speaks in a natural, confident British English style — warm and unhurried, articulate without being stiff, occasionally using understated British expressions ("that's quite interesting", "brilliant", "right then", "I'd love to hear more about that") — but never overdoing it. She does not put on an accent or announce she's British; it simply comes through naturally in her word choices and tone.

People should finish the interview thinking Lexy was a pleasure to talk to. You make the candidate feel genuinely heard, comfortable, and respected — warm, gracious, and human throughout. That said, your purpose is still to ASSESS the candidate, so you do not coach them, give tips, or critique their answers during the interview — you draw the best out of them and let them shine, then evaluate fairly afterwards.

Your style:
- You are warm, gracious, and easy to talk to — the candidate should feel relaxed and genuinely welcome
- You listen closely and respond to what was actually said — never ignore the candidate's answer
- You ask one question at a time — never stack multiple questions
- You acknowledge warmly when needed ("that's lovely", "I really like that", "makes complete sense") and then move forward with a question
- You probe deeper with genuine curiosity when answers are vague: "I'd love to hear more about that — walk me through it concretely?"
- You sound like a real, likeable person while staying in interviewer mode — you draw people out, you don't coach or critique
- You NEVER give tips, corrective feedback, or coaching during the interview, and you never tell the candidate how they're doing
- You NEVER use question numbers, bullet points, or say "my next question is"
- Flowing natural sentences only, 2-4 sentences max per turn

EQUAL-OPPORTUNITY GUARDRAIL (absolute, non-negotiable):
You must NEVER ask about, hint at, or follow up on any of:
- race, ethnicity, or national origin
- age, date of birth, or year of graduation / school-leaving
- religion, religious practice, or holidays observed
- gender identity or sexual orientation (do NOT ask for pronouns — use what the candidate has used, or none)
- marital or family status, pregnancy, children, or childcare arrangements
- disability, mental health, or medical history
- veteran status, or citizenship / work-authorization / visa / sponsorship status
These topics are either irrelevant to the role or are collected through a separate, voluntary, non-decisional disclosure surface outside this interview. If the candidate volunteers any of them, briefly and warmly acknowledge ("thanks for sharing that") and steer back to job-relevant skills, experience, or motivation — never probe, never repeat back, and never use it as a thread you return to later.
${candidateCtxBlock}${jobCtxBlock}${focusBlock}${customQBlock}

Always respond entirely in ${langLabel}.`;

    const prompt = `${directive}

${historyText ? `Conversation so far:\n${historyText}` : "This is the very start of the conversation."}`;

    try {
      const text = await generateWithAI(prompt, systemPrompt, language, {
        model: "gpt-4o-mini",
        maxTokens: 220,
      });
      /* Strip any "Lexy:" role-prefix the model echoes back from the
       * transcript format used in historyText — it should never be spoken aloud. */
      const cleaned = text.trim().replace(/^Lexy\s*:\s*/i, "");
      res.json({ text: cleaned, isClosing, questionNumber });
    } catch (err: any) {
      res.status(500).json({ error: "AI generation failed", detail: err?.message });
    }
  },
);

/* ── Save a conversational turn ──────────────────────────────────────────── */
router.post(
  "/interviews/:interviewId/save-turn",
  validate({ body: SaveTurnBody }),
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const { questionText = "", answerText = "", turnNumber = 1 } = req.body;

    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const answers = (session.answers as any[]) || [];
    answers.push({
      questionId: `turn-${turnNumber}`,
      questionText,
      answer: answerText,
      /* Conversational turns are NOT scored inline — the candidate's answer is
       graded once, holistically, when the interview ends (see /end, where each
       unscored answer is rated against its question). A null sentinel marks the
       turn as "pending evaluation"; never store a fabricated placeholder score. */
      score: null,
    });

    await db
      .update(interviewSessionsTable)
      .set({ answers, currentQuestionIndex: turnNumber })
      .where(eq(interviewSessionsTable.id, req.params.interviewId));

    res.json({ ok: true, turns: answers.length });
  },
);

/* ── Work-authorization logistics (SEPARATE, NON-SCORED) ───────────────────
   The job interview's EEO guardrail forbids work-auth questions from the
   assessed conversation. Instead, after the assessed questions are done, the
   candidate is asked two lawful work-eligibility logistics questions as a
   clearly separate, non-decisional step. The answer is extracted and persisted
   onto the candidate row for the recruiter Verification card — it is NEVER
   written into session.answers, so it can never influence the interview score,
   transcript, or hiring recommendation. */

/* GET — localized prompt the interviewer reads before closing. */
router.get(
  "/interviews/:interviewId/work-auth-prompt",
  requireInterviewSessionCookie,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const language = session.language ?? "en-US";
    const langLabel = resolveLangMeta(language).label;

    const base = `Before we wrap up, I have one optional information-gathering question — this is completely separate from your evaluation and has no bearing on your candidacy whatsoever. You're welcome to skip it or simply say "I'd prefer not to answer." Just to note for our records: are you currently authorized to work in the country where this role is based, and do you anticipate needing visa sponsorship at any point in the future?`;

    if (language.startsWith("en")) {
      res.json({ text: base });
      return;
    }
    try {
      const translated = await generateWithAI(
        `Translate the following short interviewer message into ${langLabel}, preserving the warm, professional tone and the exact meaning. Return ONLY the translated text, no quotes, no commentary.\n\n${base}`,
        `You are a professional translator. Output only the translated text in ${langLabel}.`,
        language,
      );
      res.json({ text: (translated || base).trim() });
    } catch {
      res.json({ text: base });
    }
  },
);

/* POST — extract + persist the candidate's free-text answer (never scored). */
router.post(
  "/interviews/:interviewId/work-auth",
  validate({ body: WorkAuthBody }),
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const { answerText = "" } = req.body;

    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Only persist for a real, linked candidate; demo / unlinked sessions are no-ops.
    if (!session.candidateId || session.candidateId === "demo" || !answerText.trim()) {
      res.json({ ok: true, persisted: false });
      return;
    }

    let extracted: any = {};
    try {
      extracted = await generateJSON(
        `A job candidate was asked two lawful work-eligibility logistics questions: (1) whether they are legally authorized to work in the country where the role is based, and (2) whether they will now or in the future require visa sponsorship. Extract ONLY what they explicitly stated.\n\nCandidate's answer: "${answerText}"\n\nReturn JSON ONLY:\n{\n  "workAuthorized": true | false | null,\n  "requiresSponsorship": true | false | null,\n  "sponsorshipCountry": string | null,\n  "sponsorshipNotes": string | null\n}\nUse null for anything not clearly stated. NEVER infer from nationality, name, accent, or any protected characteristic — only explicit statements about legal work authorization and sponsorship.`,
        "You are a precise data-extraction AI. Return only valid JSON, no markdown.",
        "en-US",
        { temperature: 0.1 },
      );
    } catch (e: any) {
      logger.warn(
        { interviewId: req.params.interviewId, err: e?.message },
        "[job-interview] work-auth extraction failed",
      );
      res.json({ ok: true, persisted: false });
      return;
    }

    const waUpdate: Record<string, any> = {};
    if (extracted.workAuthorized === true || extracted.workAuthorized === false)
      waUpdate.workAuthorized = extracted.workAuthorized;
    if (extracted.requiresSponsorship === true || extracted.requiresSponsorship === false)
      waUpdate.requiresSponsorship = extracted.requiresSponsorship;
    if (typeof extracted.sponsorshipCountry === "string" && extracted.sponsorshipCountry.trim())
      waUpdate.sponsorshipCountry = extracted.sponsorshipCountry.trim().slice(0, 120);
    if (typeof extracted.sponsorshipNotes === "string" && extracted.sponsorshipNotes.trim())
      waUpdate.sponsorshipNotes = extracted.sponsorshipNotes.trim().slice(0, 1000);

    if (Object.keys(waUpdate).length === 0) {
      res.json({ ok: true, persisted: false });
      return;
    }

    const [existingWa] = await db
      .select({
        workAuthorized: candidatesTable.workAuthorized,
        requiresSponsorship: candidatesTable.requiresSponsorship,
        screeningCompletedAt: candidatesTable.screeningCompletedAt,
      })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, session.candidateId))
      .limit(1);
    if (!existingWa) {
      res.json({ ok: true, persisted: false });
      return;
    }

    // We only ever ADD explicit answers — never overwrite a prior explicit answer with null.
    const finalAuthorized = waUpdate.workAuthorized ?? existingWa.workAuthorized ?? null;
    const finalSponsorship = waUpdate.requiresSponsorship ?? existingWa.requiresSponsorship ?? null;
    if (finalAuthorized != null && finalSponsorship != null && !existingWa.screeningCompletedAt) {
      waUpdate.screeningCompletedAt = new Date();
    }
    waUpdate.workAuthSource = "job_interview";
    waUpdate.updatedAt = new Date();
    await db
      .update(candidatesTable)
      .set(waUpdate)
      .where(eq(candidatesTable.id, session.candidateId));
    logger.info(
      { candidateId: session.candidateId },
      "[job-interview] Captured work-authorization (non-scored)",
    );
    res.json({ ok: true, persisted: true });
  },
);

/* ── Languages ───────────────────────────────────────────────────────────── */
router.get("/interviews/languages", (_req, res) => {
  const deepgramReady = !!process.env.DEEPGRAM_API_KEY;
  const iflytekReady = !!(
    process.env.IFLYTEK_APP_ID &&
    process.env.IFLYTEK_API_KEY &&
    process.env.IFLYTEK_API_SECRET
  );
  const azureReady = !!(
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  );

  res.json(
    Object.entries(SUPPORTED_LANGUAGES)
      .filter(([, meta]) => !meta.hidden)
      .map(([code, meta]) => ({
        code,
        label: meta.label,
        nativeName: meta.nativeName,
        family: meta.family,
        speechProvider: meta.speechProvider,
        llmProvider: meta.llmProvider,
        region: meta.region,
        ready:
          meta.speechProvider === "deepgram"
            ? deepgramReady
            : code === "zh"
              ? iflytekReady || azureReady /* iFlytek primary; Azure/Whisper lane still serves zh */
              : azureReady,
        deepgramReady,
        iflytekReady,
        azureReady,
      })),
  );
});

router.get("/interviews", async (req: any, res) => {
  /* Never let the browser serve a cached interview list — a wiped/re-seeded
     session would otherwise leave a phantom card linking to a dead id. */
  res.setHeader("Cache-Control", "no-store");
  const { applicationId, candidateId, status } = req.query;

  // Mandatory auth — anonymous callers were previously dropped past the
  // `if (caller && …)` tenant filter and saw every tenant's sessions.
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  /* Staff-only surface. This list enriches every session with the
     interview_summaries verdict (overallScore, recommendation,
     recruiterSummary, strengths, weaknesses) — the exact fields the
     fairness firewall withholds from candidates. A candidate-role user
     has a tenantId too, so tenant scoping alone would hand them the
     whole tenant's interview results. Candidates use /portal/interviews. */
  if (!INTERVIEW_STAFF_ROLES.includes(caller.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  /* Defensive cap (see lib/query-limits.ts) + push tenant scope into SQL so a
     small tenant doesn't get a zero-row slice from a global top-1000 cap. */
  let sessions: any[];
  if (caller.role === "platform_admin") {
    sessions = await db
      .select()
      .from(interviewSessionsTable)
      .orderBy(desc(interviewSessionsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  } else {
    const allowedEarly = await getAllowedTenantIds(caller);
    if (!allowedEarly || allowedEarly.length === 0) {
      res.json([]);
      return;
    }
    sessions = await db
      .select()
      .from(interviewSessionsTable)
      .where(inArray(interviewSessionsTable.tenantId, allowedEarly))
      .orderBy(desc(interviewSessionsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  }

  // Tenant scoping
  if (caller.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(caller);
    if (!allowed || allowed.length === 0) {
      res.json([]);
      return;
    }
    sessions = sessions.filter((s) => allowed.includes(s.tenantId));

    /* recruiter_admin: narrow the tenant ceiling from the full agency subtree
       to the data scope (assigned clients ∪ managed recruiters' job tenants ∪
       own staffed-job tenants). Mirrors GET /jobs. */
    if (caller.role === "recruiter_admin") {
      const dataScope = await getDataScopeTenantIds(caller);
      if (dataScope !== null) {
        if (dataScope.length === 0) {
          res.json([]);
          return;
        }
        const scopeSet = new Set(dataScope);
        sessions = sessions.filter((s) => scopeSet.has(s.tenantId));
      }
    }

    /* Job-level ownership ceilings. Sessions don't store jobId directly —
       resolve via plan_id → plans.job_id, then keep only sessions whose job
       the caller owns. Sessions with no plan/job (e.g. career/baseline flows)
       fail closed for these roles. */
    if (caller.role === "hiring_manager" || caller.role === "recruiter") {
      let myJobIds: Set<string>;
      if (caller.role === "hiring_manager") {
        const myJobs = await db
          .select({ id: jobsTable.id })
          .from(jobsTable)
          .where(eq(jobsTable.assignedHiringManagerId, caller.id));
        myJobIds = new Set(myJobs.map((j) => j.id));
      } else {
        // Plain recruiter: only reqs they're staffed on (primary or roster).
        myJobIds = new Set(await getRecruiterAssignedJobIds(caller as any));
      }
      if (myJobIds.size === 0) {
        res.json([]);
        return;
      }
      const planIds = Array.from(
        new Set(sessions.map((s) => s.planId).filter(Boolean) as string[]),
      );
      const planRows = planIds.length
        ? await db
            .select({ id: interviewPlansTable.id, jobId: interviewPlansTable.jobId })
            .from(interviewPlansTable)
            .where(inArray(interviewPlansTable.id, planIds))
        : [];
      const planJobMap = new Map(planRows.map((p) => [p.id, p.jobId]));
      sessions = sessions.filter((s) => {
        const jobId = s.planId ? planJobMap.get(s.planId) : undefined;
        return jobId ? myJobIds.has(jobId) : false;
      });
    }
  }

  if (applicationId) sessions = sessions.filter((s) => s.applicationId === applicationId);
  if (candidateId) sessions = sessions.filter((s) => s.candidateId === candidateId);
  if (status) sessions = sessions.filter((s) => s.status === (status as string));

  /* Enrich each session with the candidate's name and the work order (job)
     title so the UI can show a human-readable card instead of a raw id.
     Sessions don't store jobId directly — resolve it via plan_id → plans.job_id.

     Tenant safety: even though `sessions` is already tenant-scoped, a poisoned
     session row could reference a candidate/plan/job belonging to another
     tenant. We therefore constrain every enrichment lookup to the caller's
     allowed tenants (platform_admin is intentionally unrestricted). */
  const enrichTenantIds =
    caller.role === "platform_admin" ? null : await getAllowedTenantIds(caller);
  const candIds = Array.from(
    new Set(sessions.map((s) => s.candidateId).filter((id) => id && id !== "demo") as string[]),
  );
  const planIds = Array.from(new Set(sessions.map((s) => s.planId).filter(Boolean) as string[]));

  const candRows = candIds.length
    ? await db
        .select({
          id: candidatesTable.id,
          firstName: candidatesTable.firstName,
          lastName: candidatesTable.lastName,
        })
        .from(candidatesTable)
        .where(
          enrichTenantIds
            ? and(
                inArray(candidatesTable.id, candIds),
                inArray(candidatesTable.tenantId, enrichTenantIds),
              )
            : inArray(candidatesTable.id, candIds),
        )
    : [];
  const candMap = new Map(
    candRows.map((c) => [c.id, `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()]),
  );

  const planRows = planIds.length
    ? await db
        .select({ id: interviewPlansTable.id, jobId: interviewPlansTable.jobId })
        .from(interviewPlansTable)
        .where(
          enrichTenantIds
            ? and(
                inArray(interviewPlansTable.id, planIds),
                inArray(interviewPlansTable.tenantId, enrichTenantIds),
              )
            : inArray(interviewPlansTable.id, planIds),
        )
    : [];
  const planJobMap = new Map(planRows.map((p) => [p.id, p.jobId]));
  const jobIds = Array.from(new Set(planRows.map((p) => p.jobId).filter(Boolean) as string[]));
  const jobRows = jobIds.length
    ? await db
        .select({ id: jobsTable.id, title: jobsTable.title })
        .from(jobsTable)
        .where(
          enrichTenantIds
            ? and(inArray(jobsTable.id, jobIds), inArray(jobsTable.tenantId, enrichTenantIds))
            : inArray(jobsTable.id, jobIds),
        )
    : [];
  const jobTitleMap = new Map(jobRows.map((j) => [j.id, j.title]));

  /* Attach the AI interview assessment (overall score, recommendation,
     recruiter summary, strengths/weaknesses) so downstream consumers — the
     candidate evaluation PDF in particular — can render the interview verdict.
     The raw session row carries only `score`, which is frequently NULL even on
     completed sessions; the real assessment lives in interview_summaries
     (one row per session, keyed by interview_session_id). */
  const sessionIds = sessions.map((s) => s.id);
  const summaryRows = sessionIds.length
    ? await db
        .select({
          interviewSessionId: interviewSummariesTable.interviewSessionId,
          overallScore: interviewSummariesTable.overallScore,
          recommendation: interviewSummariesTable.recommendation,
          recruiterSummary: interviewSummariesTable.recruiterSummary,
          strengths: interviewSummariesTable.strengths,
          weaknesses: interviewSummariesTable.weaknesses,
        })
        .from(interviewSummariesTable)
        .where(inArray(interviewSummariesTable.interviewSessionId, sessionIds))
    : [];
  const summaryMap = new Map(summaryRows.map((r) => [r.interviewSessionId, r]));

  /* Client (tenant) names so the UI can offer a per-client filter — sessions
   * are already tenant-scoped above, so exposing the name leaks nothing. */
  const sessTenantIds = Array.from(
    new Set(sessions.map((s) => s.tenantId).filter(Boolean) as string[]),
  );
  const tenantRows = sessTenantIds.length
    ? await db
        .select({ id: tenantsTable.id, name: tenantsTable.name })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, sessTenantIds))
    : [];
  const tenantNameMap = new Map(tenantRows.map((t) => [t.id, t.name]));

  res.json(
    sessions.map((s) => {
      const jobId = s.planId ? planJobMap.get(s.planId) : undefined;
      const summary = summaryMap.get(s.id);
      return {
        ...s,
        candidateName: (s.candidateId && candMap.get(s.candidateId)) || null,
        jobId: jobId ?? null,
        jobTitle: jobId ? (jobTitleMap.get(jobId) ?? null) : null,
        clientName: (s.tenantId && tenantNameMap.get(s.tenantId)) || null,
        overallScore: summary?.overallScore ?? null,
        recommendation: summary?.recommendation ?? null,
        recruiterSummary: summary?.recruiterSummary ?? null,
        strengths: summary?.strengths ?? [],
        weaknesses: summary?.weaknesses ?? [],
        startedAt: s.startedAt?.toISOString() || null,
        completedAt: s.completedAt?.toISOString() || null,
        createdAt: s.createdAt.toISOString(),
      };
    }),
  );
});

router.post("/interviews/plans", validate({ body: CreatePlanBody }), async (req: any, res) => {
  const { jobId, interviewType = "general", questionCount = 8, language = "en-US" } = req.body;

  /* Mandatory auth + tenant ownership of the target job — replaces the
     hard-coded `tenantId: "acme"` plan insert that let anonymous callers
     manufacture interview plans on someone else's job. */
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [jobRow] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!jobRow) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (caller.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(caller as any);
    if (!allowed || !allowed.includes(jobRow.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  /* Plain-recruiter ceiling: the requisition must be ASSIGNED to the caller. */
  if (!(await recruiterOwnsResource(caller as any, { kind: "jobId", value: jobId }))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const tenantId = jobRow.tenantId as string;

  const langMeta = resolveLangMeta(language);
  const langLabel = langMeta.label;

  const prompt = `Generate ${questionCount} interview questions for a ${interviewType} interview.
Return a JSON array. Each element must have: id (UUID string), text (the question), category ("technical" | "behavioral" | "competency" | "situational"), followUpPrompts (array of 2 follow-up prompts), order (integer starting at 1).
All question text and follow-up prompts must be written in ${langLabel}.`;

  let questions: any[] = [];
  try {
    const aiResponse = await generateWithAI(
      prompt,
      `You are an expert AI interviewer. Generate structured, insightful interview questions. Respond with a valid JSON array only — no markdown fences, no explanation.`,
      language,
    );
    const cleaned = aiResponse
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    questions = Array.isArray(JSON.parse(cleaned)) ? JSON.parse(cleaned) : [];
  } catch {
    questions = [];
  }

  const [plan] = await db
    .insert(interviewPlansTable)
    .values({
      tenantId,
      jobId,
      title: `${interviewType.charAt(0).toUpperCase() + interviewType.slice(1)} Interview — ${langLabel}`,
      interviewType,
      language,
      questions: questions.map((q, i) => ({ ...q, id: q.id || crypto.randomUUID(), order: i + 1 })),
      estimatedDurationMinutes: 30,
    })
    .returning();

  res.status(201).json({ ...plan, createdAt: plan.createdAt.toISOString() });
});

/* Shared auth+job-ownership helper (used by recording, plan reads,
   cultural-config, generate-link). Returns the matched job on success;
   responds with 401/404 and returns null otherwise. */
async function gateJobForInterview(
  req: any,
  res: any,
  jobId: string,
  opts?: { requireApproved?: boolean },
): Promise<any | null> {
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
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (caller.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(caller as any);
    if (!allowed || !allowed.includes(job.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
  }
  /* Plain-recruiter ceiling: the requisition must be ASSIGNED to the caller. */
  if (!(await recruiterOwnsResource(caller as any, { kind: "jobId", value: jobId }))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  /* Approval gate: a recruiter-created work order in `pending_approval` (or sent
     back to `draft`/`rejected`) must NOT be interviewable until a recruiter_admin
     approves it. platform_admin is exempt for support/debugging. */
  if (
    opts?.requireApproved &&
    caller.role !== "platform_admin" &&
    !isJobApprovedForInterview(job.status)
  ) {
    logger.warn(
      { jobId, status: job.status, userId },
      "[interview-gate] blocked — work order not approved",
    );
    res.status(403).json({ error: JOB_NOT_APPROVED_MESSAGE, status: job.status });
    return null;
  }
  return { caller, job };
}

/* Session-level approval gate for the candidate-facing execution endpoints
   (begin / consent), which are public (no caller identity — the candidate is not
   logged in). Resolves session→plan→job and blocks running an interview whose
   work order isn't approved yet. Sessions with no job (null jobId — candidate
   baseline / self-practice) are intentionally allowed. Returns true to proceed,
   or responds 403/404 and returns false. */
async function assertSessionJobApproved(res: any, interviewId: string): Promise<boolean> {
  const [session] = await db
    .select({ planId: interviewSessionsTable.planId })
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, interviewId))
    .limit(1);
  if (!session?.planId) return true;
  const [plan] = await db
    .select({ jobId: interviewPlansTable.jobId })
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, session.planId))
    .limit(1);
  if (!plan?.jobId) return true;
  const [job] = await db
    .select({ status: jobsTable.status })
    .from(jobsTable)
    .where(eq(jobsTable.id, plan.jobId))
    .limit(1);
  if (job && !isJobApprovedForInterview(job.status)) {
    logger.warn(
      { interviewId, jobId: plan.jobId, status: job.status },
      "[interview-session-gate] blocked — work order not approved",
    );
    res.status(403).json({ error: JOB_NOT_APPROVED_MESSAGE, status: job.status });
    return false;
  }
  return true;
}

router.get("/interviews/plans", async (req: any, res) => {
  /* Mandatory auth + tenant scoping — previously this returned every
     tenant's interview plans to anonymous callers. */
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { jobId } = req.query;
  /* Defensive cap (see lib/query-limits.ts) + push tenant scope into SQL so a
     small tenant doesn't get a zero-row slice from a global top-1000 cap. */
  let plans: any[];
  if (caller.role === "platform_admin") {
    plans = await db
      .select()
      .from(interviewPlansTable)
      .orderBy(desc(interviewPlansTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  } else {
    const allowedEarly = await getAllowedTenantIds(caller as any);
    if (!allowedEarly || allowedEarly.length === 0) {
      res.json([]);
      return;
    }
    plans = await db
      .select()
      .from(interviewPlansTable)
      .where(inArray(interviewPlansTable.tenantId, allowedEarly))
      .orderBy(desc(interviewPlansTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  }
  if (caller.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(caller as any);
    if (!allowed || allowed.length === 0) {
      res.json([]);
      return;
    }
    plans = plans.filter((p) => allowed.includes(p.tenantId ?? ""));
  }
  /* Plain-recruiter ceiling: only plans for an ASSIGNED requisition. */
  if (caller.role === "recruiter") {
    const assigned = new Set(await getRecruiterAssignedJobIds(caller as any));
    plans = assigned.size === 0 ? [] : plans.filter((p) => p.jobId && assigned.has(p.jobId));
  }
  if (jobId) plans = plans.filter((p) => p.jobId === jobId);
  res.json(plans.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })));
});

router.patch(
  "/interviews/:interviewId/recording",
  validate({ body: PatchRecordingBody }),
  async (req: any, res) => {
    const { objectPath } = req.body;
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    /* Mandatory auth + tenant gate — recording URLs were previously writable
     by anonymous callers, allowing arbitrary recording-pointer overwrite. */
    const userId = getAuthUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [caller] = await controlDb
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (caller.role !== "platform_admin") {
      const allowed = await getAllowedTenantIds(caller as any);
      if (!allowed || !allowed.includes(session.tenantId ?? "")) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
    }
    /* Pointer-write hardening (IDOR seal, mirrors GET /storage/objects/*):
     * a tenant caller could otherwise point recording_url at ANY /objects/*
     * path and read it through the recording fallback. Require the target to
     * (a) exist and be A/V media, and (b) not already be claimed by another
     * session — recordings bind one-to-one to sessions. */
    try {
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const svc = new ObjectStorageService();
      const objectFile = await svc.getObjectEntityFile(objectPath);
      if (!/^(video|audio)\//i.test(objectFile.contentType ?? "")) {
        res.status(400).json({ error: "objectPath is not an A/V recording object" });
        return;
      }
    } catch {
      res.status(400).json({ error: "objectPath does not resolve to a stored object" });
      return;
    }
    const [claimed] = await db
      .select({ id: interviewSessionsTable.id })
      .from(interviewSessionsTable)
      .where(
        and(
          eq(interviewSessionsTable.recordingUrl, objectPath),
          sql`${interviewSessionsTable.id} <> ${req.params.interviewId}`,
        ),
      )
      .limit(1);
    if (claimed) {
      res.status(409).json({ error: "Recording object is already attached to another session" });
      return;
    }
    await db
      .update(interviewSessionsTable)
      .set({ recordingUrl: objectPath })
      .where(eq(interviewSessionsTable.id, req.params.interviewId));
    res.json({ ok: true, recordingUrl: objectPath });
  },
);

router.get("/interviews/plans/:planId", async (req: any, res) => {
  const [plan] = await db
    .select()
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, req.params.planId))
    .limit(1);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  /* Mandatory auth + tenant gate — anonymous callers could read any plan. */
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (caller.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(caller as any);
    if (!allowed || !allowed.includes(plan.tenantId ?? "")) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
  }
  /* Plain-recruiter ceiling: the plan's requisition must be ASSIGNED to caller. */
  if (!(await recruiterOwnsResource(caller as any, { kind: "jobId", value: plan.jobId ?? "" }))) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  res.json({ ...plan, createdAt: plan.createdAt.toISOString() });
});

/* ── Cultural config in-memory store (per job) ───────────────────────────── */
const culturalConfigStore: Record<string, { culturalDoc: string; customQuestions: string[] }> = {};

router.get("/interviews/cultural-config/:jobId", async (req, res) => {
  if (!(await gateJobForInterview(req, res, req.params.jobId))) return;
  const cfg = culturalConfigStore[req.params.jobId] ?? { culturalDoc: "", customQuestions: [] };
  res.json(cfg);
});

router.post(
  "/interviews/cultural-config/:jobId",
  validate({ body: CulturalConfigBody }),
  async (req, res) => {
    if (!(await gateJobForInterview(req, res, req.params.jobId))) return;
    const { culturalDoc = "", customQuestions = [] } = req.body;
    culturalConfigStore[req.params.jobId] = { culturalDoc, customQuestions };
    res.json({ ok: true });
  },
);

/* ── Build type-specific prompt ──────────────────────────────────────────── */
function buildCandidateJobContext(candidateProfile?: string, jobDescription?: string): string {
  if (!candidateProfile && !jobDescription) return "";
  const parts: string[] = [
    "---",
    "CONTEXT — use this to tailor every question to this specific person and role:",
  ];
  if (candidateProfile) parts.push(`Candidate Profile:\n${candidateProfile}`);
  if (jobDescription) parts.push(`Job Description:\n${jobDescription}`);
  parts.push(
    "---",
    "Reference specific skills, past experience, or job requirements in your questions. Do NOT ask generic questions — every question must feel like it was written specifically for this person applying to this role.",
  );
  return "\n\n" + parts.join("\n\n");
}

/* Recruiter-direction sections shared across ALL interview types.
 *   focusDirective   — free-form "what to test for". Reframed as a JOB-RELEVANT
 *                      competency so a soft trait ("bubbliness") can't become a
 *                      proxy for a protected characteristic (LL144 / bias).
 *   customQuestions  — recruiter-authored questions, included verbatim.
 * Returns the prompt fragments plus how many AI questions to generate (we leave
 * room in the requested count for the verbatim custom questions). */
function buildRecruiterDirection(
  questionCount: number,
  customQuestions?: string[],
  focusDirective?: string,
): { focusUser: string; focusSystem: string; aiCount: number; customCount: number } {
  const cleanCustom = (customQuestions ?? []).map((q) => (q ?? "").trim()).filter(Boolean);
  const focus = (focusDirective ?? "").trim();

  const focusUser = focus
    ? `\n\nRECRUITER FOCUS — the recruiter wants this interview to specifically assess: "${focus}". Treat this as a JOB-RELEVANT competency (e.g. "charisma / bubbliness" → ability to build rapport, communicate with energy, and engage stakeholders). Make sure several questions create natural opportunities to observe this competency in the context of the role. Never turn it into a question about personality labels or any protected characteristic.`
    : "";
  const focusSystem = focus
    ? ` The recruiter has asked you to focus on assessing this job-relevant competency: "${focus}". Weave opportunities to observe it into your questions, but keep every question fair, role-relevant, and free of any protected-characteristic proxy.`
    : "";
  // Leave room in the requested count for the verbatim custom questions, which
  // are merged deterministically server-side (never via the model).
  const aiCount = Math.max(1, questionCount - cleanCustom.length);
  return { focusUser, focusSystem, aiCount, customCount: cleanCustom.length };
}

function buildInterviewPrompt(
  interviewType: string,
  questionCount: number,
  roleContext: string,
  langLabel: string,
  culturalDoc?: string,
  customQuestions?: string[],
  difficulty?: string,
  candidateProfile?: string,
  jobDescription?: string,
  focusDirective?: string,
): { userPrompt: string; systemPrompt: string } {
  const role = roleContext || " software engineering";
  const ctx = buildCandidateJobContext(candidateProfile, jobDescription);
  const dir = buildRecruiterDirection(questionCount, customQuestions, focusDirective);
  /* Only the recruiter FOCUS is injected into the prompt. Custom questions are
     merged deterministically server-side (see generate-link) so the model can
     never drop, reorder, or duplicate them. */
  const directionUser = dir.focusUser;
  const isCustomField = "";
  const includeCustom = "";

  switch (interviewType) {
    case "behavioral":
      return {
        userPrompt: `Generate ${dir.aiCount} behavioral interview questions${roleContext} using the STAR method framework (Situation, Task, Action, Result). Focus on: past situations, conflict resolution, leadership, collaboration, adaptability, and professional growth.${directionUser}\n\nReturn a JSON array.${includeCustom} Each element: id (UUID), text (question), category ("behavioral"), followUpPrompts (2 STAR follow-up prompts), order (int)${isCustomField}. All text in ${langLabel}.${ctx}`,
        systemPrompt: `You are an expert behavioral interviewer. Design questions that reveal real past experiences and character. Use STAR framework. Tailor questions to the candidate's specific background and the role requirements provided.${dir.focusSystem} Respond with a valid JSON array only.`,
      };

    case "cultural":
      const docSection = culturalDoc
        ? `\n\nCompany values and culture document:\n${culturalDoc}`
        : "";
      return {
        userPrompt: `Generate ${dir.aiCount} cultural-fit interview questions${roleContext} that assess alignment with the company culture and values.${docSection}${directionUser}\n\nReturn a JSON array.${includeCustom} Each element: id (UUID), text (question), category ("cultural"), followUpPrompts (2 strings exploring cultural alignment), order (int)${isCustomField}. All text in ${langLabel}.${ctx}`,
        systemPrompt: `You are an expert cultural-fit interviewer. Base questions on the provided company culture document and values. Tailor generated questions to this specific candidate's background.${dir.focusSystem} Respond with a valid JSON array only.`,
      };

    case "technical":
      return {
        userPrompt: `Generate ${dir.aiCount} deep technical interview questions${roleContext}. Cover: system design, architecture decisions, trade-offs, debugging methodology, performance optimization, code quality, and domain-specific technical depth. Questions should challenge senior engineers and reveal true technical expertise.${directionUser}\n\nReturn a JSON array.${includeCustom} Each element: id (UUID), text (question), category ("technical"), followUpPrompts (2 technical deep-dive follow-ups), order (int)${isCustomField}. All text in ${langLabel}.${ctx}`,
        systemPrompt: `You are a senior technical interviewer. Create questions that distinguish genuine experts from those with surface knowledge. Focus on depth, not trivia. Tailor questions to the specific technologies, skills, and experience mentioned in the candidate profile and job description.${dir.focusSystem} Respond with a valid JSON array only.`,
      };

    case "programming":
      const difficultyLabel = difficulty ?? "medium";
      return {
        userPrompt: `Generate ${dir.aiCount} programming/coding challenge questions${roleContext} at ${difficultyLabel} difficulty. Each challenge must be a real algorithmic or engineering problem relevant to the role and candidate background.${directionUser}\n\nReturn a JSON array.${includeCustom} Each element: id (UUID), title (short challenge name), description (full problem statement with constraints), examples (array of {input, output, explanation}), constraints (array of constraint strings), starterCode ({javascript: string, python: string, typescript: string}), category ("programming"), difficulty ("${difficultyLabel}"), order (int), estimatedMinutes (int 10-30)${isCustomField}. All text in ${langLabel}.${ctx}`,
        systemPrompt: `You are an expert coding interview designer. Create real, solvable programming challenges appropriate for the role and aligned with the candidate's stated skills. Include clear examples and starter code in JavaScript, Python, and TypeScript.${dir.focusSystem} Respond with a valid JSON array only.`,
      };

    default:
      return {
        userPrompt: `Generate ${dir.aiCount} interview questions${roleContext} covering a mix of behavioral, competency, and situational topics.${directionUser}\n\nReturn a JSON array.${includeCustom} Each element: id (UUID), text (question), category ("behavioral"|"competency"|"situational"), followUpPrompts (2 strings), order (int)${isCustomField}. All text in ${langLabel}.${ctx}`,
        systemPrompt: `You are an expert AI interviewer. Tailor every question to the candidate's background and the role requirements provided.${dir.focusSystem} Respond with a valid JSON array only.`,
      };
  }
}

/* ── Idempotent interview-link mint helpers ─────────────────────────────────
   generate-link must be safe to double-fire (recruiter double-click, two tabs,
   a retried request). The unique identity of a "live" interview link is
   (tenant, candidate, plan.jobId, plan.interviewType) — note jobId + type live
   on interview_plans, NOT interview_sessions, so a partial unique index on the
   sessions table can't express it. We instead guard with an app-level check
   plus a transaction advisory lock (see the mint transaction in the route). */

/* A session is "live" (re-usable) until it reaches a terminal state. flagged /
   reviewed are post-completion recruiter states and are therefore terminal too
   (the interview already happened). */
const LIVE_SESSION_STATUSES = [
  "scheduled",
  "in_progress",
  "invited",
  "opened",
  "verified",
  "active",
  "paused",
  "resumed",
] as const;

/** Live interview sessions for a (tenant, candidate, job, type), newest first.
 *  `exec` is either `db` or a transaction handle — both expose the same query
 *  builder. Joined to interview_plans because job + type live there. */
function findLiveInterviewSessions(
  exec: any,
  tenantId: string,
  candidateId: string,
  jobId: string,
  interviewType: string,
): Promise<Array<{ session: any; plan: any }>> {
  return exec
    .select({ session: interviewSessionsTable, plan: interviewPlansTable })
    .from(interviewSessionsTable)
    .innerJoin(interviewPlansTable, eq(interviewSessionsTable.planId, interviewPlansTable.id))
    .where(
      and(
        eq(interviewSessionsTable.tenantId, tenantId),
        eq(interviewSessionsTable.candidateId, candidateId),
        eq(interviewPlansTable.jobId, jobId),
        eq(interviewPlansTable.interviewType, interviewType as any),
        inArray(interviewSessionsTable.status, LIVE_SESSION_STATUSES as any),
      ),
    )
    .orderBy(desc(interviewSessionsTable.createdAt));
}

/** Map a mint identity to a signed 64-bit int for pg_advisory_xact_lock. Hash
 *  → first 8 bytes → signed bigint (same technique as public.ts lockKeyForUser).
 *  Namespaced so it can't collide with other advisory-lock users. */
function interviewMintLockKey(
  tenantId: string,
  candidateId: string,
  jobId: string,
  interviewType: string,
): bigint {
  const h = nodeCrypto
    .createHash("sha256")
    .update(`interview_mint:${tenantId}:${candidateId}:${jobId}:${interviewType}`)
    .digest();
  return h.readBigInt64BE(0);
}

/** Single source of truth for the generate-link response body, so the fresh-mint
 *  path and the idempotent-reuse path return an identical shape. */
function buildGenerateLinkResponse(
  session: any,
  plan: any,
  opts: { emailSent: boolean; emailedTo: string | null; langLabel: string; reused: boolean },
) {
  return {
    sessionId: session.id,
    planId: plan.id,
    planTitle: plan.title,
    questionCount: (plan.questions as any[]).length,
    estimatedMinutes: plan.estimatedDurationMinutes,
    emailSent: opts.emailSent,
    emailedTo: opts.emailedTo,
    language: plan.language,
    langLabel: opts.langLabel,
    interviewType: plan.interviewType,
    questions: (plan.questions as any[]).map((q: any) => ({
      id: q.id,
      text: q.text,
      title: q.title,
      category: q.category,
      order: q.order,
      difficulty: q.difficulty,
      estimatedMinutes: q.estimatedMinutes,
    })),
    createdAt: session.createdAt.toISOString(),
    reused: opts.reused,
  };
}

router.post(
  "/interviews/generate-link",
  validate({ body: GenerateLinkBody }),
  async (req: any, res) => {
    const {
      jobId,
      candidateId = "demo",
      interviewType = "general",
      questionCount = 8,
      language = "en-US",
      applicationId,
      roleTitle,
      culturalDoc,
      customQuestions,
      focusDirective,
      difficulty,
      regenerate = false,
    } = req.body;

    if (!jobId) {
      res.status(400).json({ error: "jobId is required" });
      return;
    }

    /* Mandatory auth + tenant ownership of jobId — replaces the
     `jobRow?.tenantId || "acme"` fallback that let anonymous callers create
     interviews on someone else's job. */
    const gate = await gateJobForInterview(req, res, jobId, { requireApproved: true });
    if (!gate) return;
    const caller = gate.caller;
    const jobRow = gate.job;

    const langMeta = resolveLangMeta(language);
    const langLabel = langMeta.label;

    const resolvedRoleTitle = roleTitle || jobRow?.title || "";
    const roleContext = resolvedRoleTitle ? ` for a ${resolvedRoleTitle} role` : "";

    let jobDescription: string | undefined;
    if (jobRow) {
      jobDescription = `Title: ${jobRow.title}${jobRow.department ? `\nDepartment: ${jobRow.department}` : ""}${jobRow.location ? `\nLocation: ${jobRow.location}` : ""}${jobRow.employmentType ? `\nType: ${jobRow.employmentType}` : ""}\n\n${jobRow.description}`;
    }

    let candidateProfile: string | undefined;
    if (candidateId && candidateId !== "demo") {
      const [candidate] = await db
        .select()
        .from(candidatesTable)
        .where(eq(candidatesTable.id, candidateId))
        .limit(1);
      if (candidate) {
        /* Tenant-scope the recruiter-supplied candidateId: a candidate from another
         tenant must never be linked into this session or fed into LLM prompts.
         Sourced candidates get a per-tenant row, so allowed-tenant membership is
         the correct gate (mirrors getAllowedTenantIds used everywhere else). */
        if (caller.role !== "platform_admin") {
          const allowedTenants = await getAllowedTenantIds(caller as any);
          if (!allowedTenants || !allowedTenants.includes(candidate.tenantId ?? "")) {
            res.status(404).json({ error: "Not found" });
            return;
          }
        }
        const parts = [
          `Name: ${candidate.firstName} ${candidate.lastName}`,
          candidate.currentTitle ? `Current Title: ${candidate.currentTitle}` : null,
          candidate.currentCompany ? `Current Company: ${candidate.currentCompany}` : null,
          candidate.location ? `Location: ${candidate.location}` : null,
          candidate.skills?.length ? `Skills: ${candidate.skills.join(", ")}` : null,
        ].filter(Boolean);
        candidateProfile = parts.join("\n");
      }
    }

    /* Tenant-scope a recruiter-supplied applicationId too. It's persisted on the
     session and later used by lookupCandidateEmail() to decide who receives the
     auto-invite email, so an unvalidated foreign applicationId would let a caller
     email another tenant's candidate. Mirror the candidateId gate above. */
    if (
      applicationId &&
      !["direct", "pipeline"].includes(applicationId) &&
      caller.role !== "platform_admin"
    ) {
      const [appRow] = await db
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.id, applicationId))
        .limit(1);
      if (appRow) {
        const allowedTenants = await getAllowedTenantIds(caller as any);
        if (!allowedTenants || !allowedTenants.includes(appRow.tenantId ?? "")) {
          res.status(404).json({ error: "Not found" });
          return;
        }
      }
    }

    /* ── Idempotent-mint fast path (double-click / two-tabs guard) ────────────
     A recruiter double-clicking "Generate link" must not mint a second
     plan+session and must not double-record an interview credit. When a LIVE
     session already exists for this (tenant, candidate, job, type) we return it
     unchanged — cheaply, BEFORE the expensive AI question generation. The
     `regenerate` flag opts out (expire + mint anew, handled in the mint txn).
     The anonymous "demo" placeholder is exempt: its links are throwaway and
     intentionally non-unique. The true concurrent race (both requests pass this
     check before either inserts) is caught by the advisory lock in the mint
     transaction further down. */
    const isRealCandidate = !!candidateId && candidateId !== "demo";
    if (isRealCandidate && !regenerate) {
      const [existing] = await findLiveInterviewSessions(
        db,
        jobRow.tenantId as string,
        candidateId,
        jobId,
        interviewType,
      );
      if (existing) {
        res.status(200).json(
          buildGenerateLinkResponse(existing.session, existing.plan, {
            emailSent: false,
            emailedTo: null,
            langLabel,
            reused: true,
          }),
        );
        return;
      }
    }

    /* Recruiter direction. Custom questions + culture doc are available for ALL
     interview types now (previously cultural-only). For cultural, fall back to
     the saved per-job config when nothing was passed in. */
    let resolvedCulturalDoc = culturalDoc;
    let resolvedCustomQuestions = customQuestions;
    if (interviewType === "cultural" && !culturalDoc) {
      const saved = culturalConfigStore[jobId];
      if (saved) {
        resolvedCulturalDoc = saved.culturalDoc;
        resolvedCustomQuestions = resolvedCustomQuestions?.length
          ? resolvedCustomQuestions
          : saved.customQuestions;
      }
    }
    const resolvedFocusDirective = (focusDirective ?? "").trim() || null;

    const { userPrompt, systemPrompt } = buildInterviewPrompt(
      interviewType,
      questionCount,
      roleContext,
      langLabel,
      resolvedCulturalDoc,
      resolvedCustomQuestions,
      difficulty,
      candidateProfile,
      jobDescription,
      resolvedFocusDirective ?? undefined,
    );

    let questions: any[] = [];
    try {
      const aiResponse = await generateWithAI(userPrompt, systemPrompt, language);
      const cleaned = aiResponse
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      questions = Array.isArray(parsed) ? parsed : [];
    } catch {
      if (interviewType === "programming") {
        questions = Array.from({ length: questionCount }, (_, i) => ({
          id: crypto.randomUUID(),
          title: `Coding Challenge ${i + 1}`,
          description: `Implement a function${roleTitle ? ` relevant to a ${roleTitle} role` : ""}.`,
          examples: [
            { input: "example input", output: "example output", explanation: "explanation" },
          ],
          constraints: ["1 ≤ n ≤ 10^5"],
          starterCode: {
            javascript: `function solution(input) {\n  // your code here\n}`,
            python: `def solution(input):\n    pass`,
            typescript: `function solution(input: any): any {\n  // your code here\n}`,
          },
          category: "programming",
          difficulty: difficulty ?? "medium",
          order: i + 1,
          estimatedMinutes: 20,
        }));
      } else {
        questions = Array.from({ length: questionCount }, (_, i) => ({
          id: crypto.randomUUID(),
          text:
            interviewType === "behavioral"
              ? "Tell me about a time you overcame a significant challenge at work. Use the STAR method."
              : interviewType === "technical"
                ? `Describe your experience with the core technical stack${roleTitle ? ` for a ${roleTitle} role` : ""}.`
                : interviewType === "cultural"
                  ? "How do you align with collaborative, innovative team environments?"
                  : "Tell me about your professional background.",
          category: interviewType === "technical" ? "technical" : "behavioral",
          followUpPrompts: ["Can you elaborate on that?", "What was the outcome?"],
          order: i + 1,
        }));
      }
    }

    /* Deterministically guarantee recruiter custom questions appear — never rely
     on the model to echo them. Custom questions go FIRST so they're always kept
     even when customCount >= questionCount; AI questions fill the remainder up
     to max(questionCount, customCount). Order is normalized after the merge. */
    const cleanCustomQuestions = (resolvedCustomQuestions ?? [])
      .map((q) => (q ?? "").trim())
      .filter(Boolean);
    if (cleanCustomQuestions.length) {
      const customObjs = cleanCustomQuestions.map((text) =>
        interviewType === "programming"
          ? {
              id: crypto.randomUUID(),
              title: text.length > 60 ? `${text.slice(0, 57)}...` : text,
              description: text,
              examples: [],
              constraints: [],
              starterCode: { javascript: "", python: "", typescript: "" },
              category: "programming",
              difficulty: difficulty ?? "medium",
              order: 0,
              estimatedMinutes: 20,
              isCustom: true,
            }
          : {
              id: crypto.randomUUID(),
              text,
              category: interviewType === "general" ? "behavioral" : interviewType,
              followUpPrompts: ["Can you elaborate on that?", "What was the outcome?"],
              order: 0,
              isCustom: true,
            },
      );
      const total = Math.max(questionCount, cleanCustomQuestions.length);
      questions = [...customObjs, ...questions].slice(0, total);
    }
    questions = questions.map((q, i) => ({ ...q, order: i + 1 }));

    const typeLabel = interviewType.charAt(0).toUpperCase() + interviewType.slice(1);
    const title = roleTitle
      ? `${roleTitle} — ${typeLabel} Interview`
      : `${typeLabel} Interview — ${langLabel}`;

    /* The plan's culturalConfig doubles as the recruiter custom-questions bag for
     ALL interview types — the live interviewer (/converse) reads
     plan.culturalConfig.customQuestions regardless of type. Persist it whenever
     there are custom questions (or for cultural, which also carries the doc) so
     the generate-link path stays consistent with the pipeline auto-interview
     path (interview-reply.ts ensurePlan). */
    const culturalConfig =
      interviewType === "cultural" || (resolvedCustomQuestions?.length ?? 0) > 0
        ? {
            culturalDoc: interviewType === "cultural" ? (resolvedCulturalDoc ?? "") : "",
            customQuestions: resolvedCustomQuestions ?? [],
          }
        : null;

    /* Tenant is always derived from the gated job — never hard-coded "acme". */
    const resolvedTenantId = jobRow.tenantId as string;

    // ── Plan-limit gate ─────────────────────────────────────────────────────
    // Check before creating either the plan or the session so we don't leave
    // an orphaned interview_plans row if the tenant is over its session quota.
    const sessionCheck = await checkInterviewCreationAllowed(resolvedTenantId);
    if (!sessionCheck.allowed) {
      res.status(402).json(buildLimitExceededBody(sessionCheck));
      return;
    }

    // ── Atomic mint (advisory-locked idempotency) ───────────────────────────
    // The fast path above already returns for a plain double-click. This closes
    // the true race: two concurrent requests that both passed that check before
    // either inserted. A per-(tenant,candidate,job,type) transaction advisory
    // lock serializes them — the first mints; the second blocks on the lock, then
    // re-checks INSIDE it, finds the freshly-committed session, and reuses it.
    // Result: one plan, one session, one credit row. `regenerate` expires any
    // live session first and always mints anew (a deliberate fresh credit).
    const mint = await db.transaction(
      async (tx): Promise<{ plan: any; session: any; reused: boolean }> => {
        if (isRealCandidate) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${interviewMintLockKey(resolvedTenantId, candidateId, jobId, interviewType)})`,
          );
          if (regenerate) {
            const live = await findLiveInterviewSessions(
              tx,
              resolvedTenantId,
              candidateId,
              jobId,
              interviewType,
            );
            if (live.length) {
              await tx
                .update(interviewSessionsTable)
                .set({ status: "expired", expiredAt: new Date() })
                .where(
                  inArray(
                    interviewSessionsTable.id,
                    live.map((r: any) => r.session.id),
                  ),
                );
            }
          } else {
            const [existing] = await findLiveInterviewSessions(
              tx,
              resolvedTenantId,
              candidateId,
              jobId,
              interviewType,
            );
            if (existing) return { plan: existing.plan, session: existing.session, reused: true };
          }
        }

        const [p] = await tx
          .insert(interviewPlansTable)
          .values({
            tenantId: resolvedTenantId,
            jobId,
            title,
            interviewType,
            language,
            questions: questions.map((q, i) => ({
              ...q,
              id: q.id || crypto.randomUUID(),
              order: i + 1,
            })),
            culturalConfig,
            focusDirective: resolvedFocusDirective,
            estimatedDurationMinutes:
              interviewType === "programming" ? questionCount * 20 : questionCount * 8,
          } as any)
          .returning();

        const [s] = await tx
          .insert(interviewSessionsTable)
          .values({
            tenantId: resolvedTenantId,
            applicationId: applicationId || "direct",
            planId: p.id,
            candidateId,
            language: p.language ?? "en-US",
            status: "scheduled",
            currentQuestionIndex: 0,
            totalQuestions: questions.length,
            startedAt: null,
            answers: [],
          } as any)
          .returning();

        return { plan: p, session: s, reused: false };
      },
    );

    const plan = mint.plan;
    const session = mint.session;

    // A race that resolved to an already-live session: no new plan, no new credit,
    // no duplicate invite email — just return the existing link (matches the fast
    // path above).
    if (mint.reused) {
      res.status(200).json(
        buildGenerateLinkResponse(session, plan, {
          emailSent: false,
          emailedTo: null,
          langLabel,
          reused: true,
        }),
      );
      return;
    }

    // Record credit usage AFTER a successful NEW mint only. Best-effort (logged,
    // never rolls back the user-visible interview); gated on the fast-path +
    // advisory-lock reuse checks above so a double-click / concurrent race can
    // never double-charge the aggregate ledger. (Phantom-credit prevention.)
    try {
      await recordCreditEvent({
        tenantId: resolvedTenantId,
        kind: "interview",
        refId: session.id,
        metadata: { interviewType, source: "generate-link" },
      });
    } catch (err) {
      logger.error(
        { err, sessionId: session.id, tenantId: resolvedTenantId },
        "[interviews] credit-event write failed (non-fatal)",
      );
    }

    // Notify the candidate's original recruiter when a hiring manager schedules an interview
    if (caller?.role === "hiring_manager" && candidateId && candidateId !== "demo") {
      try {
        const [cand] = await db
          .select()
          .from(candidatesTable)
          .where(eq(candidatesTable.id, candidateId))
          .limit(1);
        if (cand?.createdById && cand.createdById !== caller.id) {
          const candidateName = `${cand.firstName} ${cand.lastName}`.trim();
          const hmName = caller.name || caller.email;
          await db.insert(userNotificationsTable).values({
            tenantId: resolvedTenantId,
            userId: cand.createdById,
            type: "interview_scheduled_by_hm",
            title: "Hiring manager scheduled an interview",
            message: `${hmName} scheduled an ${interviewType} interview with ${candidateName}${jobRow?.title ? ` for ${jobRow.title}` : ""}.`,
            actionUrl: `/interviews/${session.id}`,
          });
          const { recordAudit } = await import("../lib/audit.js");
          void recordAudit({
            tenantId: resolvedTenantId,
            actorType: "user",
            actorId: caller.id,
            actorLabel: hmName,
            subjectType: "user",
            subjectId: cand.createdById,
            subjectLabel: candidateName,
            channel: "in_app",
            direction: "outbound",
            action: "notification.user.interview_scheduled_by_hm",
            title: "Hiring manager scheduled an interview",
            body: `${hmName} scheduled an ${interviewType} interview with ${candidateName}.`,
            metadata: { sessionId: session.id, jobId: jobRow?.id, interviewType },
          });
        }
      } catch (err) {
        logger.error({ err }, "Failed to create HM-scheduled interview notification");
      }
    }

    /* Auto-email the interview link to the candidate so the recruiter doesn't
     have to copy/paste and send it themselves. Best-effort: a failed (or
     skipped) send never blocks link creation — the recruiter still gets the
     copyable link in the response below. emailSent reflects a REAL delivery
     only (a dev "simulated" send counts as not sent so the UI stays honest). */
    let candidateEmailSent = false;
    let candidateEmailedTo: string | null = null;
    try {
      const { email: candEmail, firstName: candFirst } = await lookupCandidateEmail(session);
      if (candEmail) {
        const roomUrl = `${process.env.APP_BASE_URL || "https://app.l3xy.ai"}/interviews/${session.id}/room`;
        const greet = candFirst || "there";
        const roleLine = jobRow?.title ? ` for the ${jobRow.title} role` : "";
        const subject = `You're invited to an interview${jobRow?.title ? ` — ${jobRow.title}` : ""}`;
        const body = `Hi ${greet},

Thank you again for your time.

The next step involves an AI-powered video interview${roleLine} via our internal system, L3xy. This has become a standard part of our process and helps both us and the client gain a clearer understanding of your skills and communication style. It's a session you can take whenever you're ready — no account or sign-up required.

Start your interview here:
${roomUrl}

This link is personal to you, so please don't share it.

${interviewInviteTips(plan.estimatedDurationMinutes)}

— Lexy AI Hiring Platform`;
        const result = await sendEmail({
          to: candEmail,
          subject,
          text: body,
          html: inviteEmailHtml(body),
          audit: {
            tenantId: resolvedTenantId,
            actorLabel: "Interview Engine",
            subjectType: "candidate",
            subjectId: candidateId,
            action: "interview.invite.sent",
            metadata: {
              sessionId: session.id,
              jobId: jobRow?.id,
              jobTitle: jobRow?.title,
              interviewType,
            },
          },
        });
        candidateEmailSent = !!(result.ok && !result.simulated);
        if (candidateEmailSent) candidateEmailedTo = candEmail;
      }
    } catch (err) {
      logger.error(
        { err, sessionId: session.id },
        "[interviews] candidate invite email failed (non-fatal)",
      );
    }

    res.status(201).json(
      buildGenerateLinkResponse(session, plan, {
        emailSent: candidateEmailSent,
        emailedTo: candidateEmailedTo,
        langLabel,
        reused: false,
      }),
    );
  },
);

/* ── Code submission for programming interviews ─────────────────────────── */
router.post(
  "/interviews/:interviewId/submit-code",
  validate({ body: SubmitCodeBody }),
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const { questionId, code, language: codeLang = "javascript" } = req.body;
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const [plan] = await db
      .select()
      .from(interviewPlansTable)
      .where(eq(interviewPlansTable.id, session.planId))
      .limit(1);

    const questions = (plan?.questions as any[]) ?? [];
    const question = questions.find((q) => q.id === questionId);

    /* AI evaluation of the submitted code */
    let evaluation: any = { score: 0, feedback: "Unable to evaluate", passed: false };
    try {
      const evalPrompt = `You are a code reviewer. Evaluate this code submission for the following programming challenge.

Challenge: ${question?.title ?? "Coding challenge"}
Problem: ${question?.description ?? "Implement a solution"}
Expected: ${JSON.stringify(question?.examples ?? [])}

Candidate's ${codeLang} code:
\`\`\`${codeLang}
${code}
\`\`\`

Respond with a JSON object: { score: 0-100, feedback: "detailed feedback", correctness: "correct|partial|incorrect", timeComplexity: "O(?)", spaceComplexity: "O(?)", codeQuality: "excellent|good|fair|poor", passed: boolean, suggestions: ["improvement 1", "improvement 2"] }

IMPORTANT: the "feedback" and "suggestions" fields are shown to the CANDIDATE mid-interview as iteration guidance. They must describe what works and what to improve in the code, and must NOT contain any numeric rating, grade, ranking, hiring recommendation, or overall verdict — keep all grading strictly in the score/correctness/codeQuality fields.`;

      const resp = await generateWithAI(
        evalPrompt,
        `You are a senior software engineer evaluating code quality, correctness, and efficiency. Be concise but specific. Respond with valid JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
      );
      const cleaned = resp
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      evaluation = JSON.parse(cleaned);
    } catch {
      /* keep default */
    }

    /* Save submission to session */
    const existing = (session.codeSubmissions as any[]) ?? [];
    const submission = {
      id: crypto.randomUUID(),
      questionId,
      code,
      language: codeLang,
      evaluation,
      submittedAt: new Date().toISOString(),
    };
    await db
      .update(interviewSessionsTable)
      .set({ codeSubmissions: [...existing, submission] } as any)
      .where(eq(interviewSessionsTable.id, session.id));

    /* Fairness firewall: the candidate gets ITERATION feedback only (did it
     * pass, what to improve) — never the recruiter-facing grade (score,
     * codeQuality, correctness) that is persisted above for the hiring team. */
    const { evaluation: _fullEval, ...submissionEcho } = submission;
    res.json({ submission: submissionEcho, evaluation: sanitizeCodeEvalForCandidate(evaluation) });
  },
);

/* Exported for the score-firewall seal test: what the candidate may see of a
 * code evaluation mid-interview. Allowlist — never spread the raw object.
 * Free-text fields are additionally scrubbed of rating phrases as a backstop
 * against the model restating the recruiter grade in prose. */
const GRADE_PROSE_RE =
  /\b(?:\d{1,3}\s*(?:\/|out of)\s*(?:10|100)|score[sd]?\s*(?:of|:|is|was)?\s*\d{1,3}|(?:rated?|rating|grade[sd]?)\s*(?:of|:|is|was|at)?\s*\d{1,3})\b/gi;
function scrubGradeProse(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return text.replace(GRADE_PROSE_RE, "[withheld]");
}
export function sanitizeCodeEvalForCandidate(ev: any) {
  return {
    passed: ev?.passed === true,
    feedback: scrubGradeProse(ev?.feedback),
    suggestions: Array.isArray(ev?.suggestions)
      ? ev.suggestions
          .map((s: unknown) => scrubGradeProse(s))
          .filter((s: string | null): s is string => s != null)
      : [],
    timeComplexity: ev?.timeComplexity ?? null,
    spaceComplexity: ev?.spaceComplexity ?? null,
  };
}

router.post("/interviews/start", validate({ body: StartInterviewBody }), async (req, res) => {
  const { applicationId, planId } = req.body;
  const [plan] = await db
    .select()
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, planId))
    .limit(1);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  /* Approval gate: block starting a job-bound interview whose work order isn't
     approved yet (defense-in-depth alongside generate-link + the invite agent).
     Plans with no jobId (e.g. candidate baseline/self-practice) are unaffected. */
  if (plan.jobId) {
    const [planJob] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, plan.jobId))
      .limit(1);
    if (planJob && !isJobApprovedForInterview(planJob.status)) {
      logger.warn(
        { planId, jobId: plan.jobId, status: planJob.status },
        "[interviews/start] blocked — work order not approved",
      );
      res.status(403).json({ error: JOB_NOT_APPROVED_MESSAGE, status: planJob.status });
      return;
    }
  }

  // ── Plan-limit gate ─────────────────────────────────────────────────────
  const sessionCheck = await checkInterviewCreationAllowed(plan.tenantId);
  if (!sessionCheck.allowed) {
    res.status(402).json(buildLimitExceededBody(sessionCheck));
    return;
  }

  const questions = plan.questions as any[];
  const [session] = await db
    .insert(interviewSessionsTable)
    .values({
      tenantId: plan.tenantId,
      applicationId,
      planId,
      candidateId: req.body.candidateId || "default",
      language: plan.language ?? "en-US",
      status: "in_progress",
      currentQuestionIndex: 0,
      totalQuestions: questions.length,
      startedAt: new Date(),
      answers: [],
    })
    .returning();
  try {
    await recordCreditEvent({
      tenantId: plan.tenantId,
      kind: "interview",
      refId: session.id,
      metadata: { source: "interviews/start" },
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, tenantId: plan.tenantId },
      "[interviews] credit-event write failed (non-fatal)",
    );
  }

  void logCandidateEvent({
    candidateId: session.candidateId,
    jobId: plan.jobId ?? null,
    tenantId: session.tenantId ?? "",
    applicationId:
      session.applicationId && !["direct", "pipeline"].includes(session.applicationId)
        ? session.applicationId
        : null,
    eventType: "INTERVIEW_STARTED",
    actorType: "candidate",
    source: "interview_agent",
    metadata: {
      sessionId: session.id,
      planId: session.planId,
      interviewType: (plan as any).interviewType,
    },
  });

  res.status(201).json({
    ...session,
    startedAt: session.startedAt?.toISOString() || null,
    completedAt: null,
    createdAt: session.createdAt.toISOString(),
  });
});

router.post(
  "/interviews/:interviewId/begin",
  beginIpLimit,
  beginInterviewLimit,
  requireSameOriginPost,
  async (req, res) => {
    /* /begin is the only candidate-facing route the cookie middleware does NOT
     gate — it is what mints the cookie. It both starts a brand-new session
     and resumes an in-flight one (rotating the nonce so the new tab wins). */
    /* Approval gate: never run an interview for a job-bound session whose work
     order isn't approved (e.g. a pre-existing session whose job was later sent
     back to draft/rejected). Checked before binding the cookie / starting. */
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;

    const result = await bindOrResumeOnBegin(req, res, req.params.interviewId);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }

    /* ── Illinois AIVI Act / EU AI Act consent gate ────────────────────────
     * Before we let the AI conduct an interview against a real candidate,
     * confirm they consented to the current disclosure version. Demo /
     * default sessions are exempt (hasActiveAiConsent returns true for
     * those). Returns 412 with a structured code so the candidate UI can
     * route to the consent page and POST back here once consent is given.
     * ──────────────────────────────────────────────────────────────────── */
    const { hasActiveAiConsent, CURRENT_AI_CONSENT_VERSION } = await import("../lib/ai-consent.js");
    const [preCheck] = await db
      .select({ candidateId: interviewSessionsTable.candidateId })
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    const ok = await hasActiveAiConsent(preCheck?.candidateId);
    if (!ok) {
      res.status(412).json({
        error: "AI_CONSENT_REQUIRED",
        message:
          "Candidate has not consented to the current AI interview + biometric disclosure. The interview room surfaces the consent gate inline (GET/POST /interviews/:id/consent) before any capture begins.",
        consentVersion: CURRENT_AI_CONSENT_VERSION,
      });
      return;
    }

    /* Do NOT overwrite `status` here — bindOrResumeOnBegin has already set it
     * to the correct lifecycle state ("active" on first open, "resumed" on
     * resume). Forcing legacy "in_progress" would collapse the new 11-state
     * machine and erase claimedAt/resumedAt bookkeeping. We only set
     * startedAt on first open (idempotent: keep the original timestamp on
     * resumes so analytics still see the true session start). */
    const startedAtUpdate: Record<string, unknown> = {};
    if (result.firstOpen) startedAtUpdate.startedAt = new Date();
    const [updated] =
      Object.keys(startedAtUpdate).length > 0
        ? await db
            .update(interviewSessionsTable)
            .set(startedAtUpdate as any)
            .where(eq(interviewSessionsTable.id, req.params.interviewId))
            .returning()
        : await db
            .select()
            .from(interviewSessionsTable)
            .where(eq(interviewSessionsTable.id, req.params.interviewId))
            .limit(1);
    const [plan] = await db
      .select()
      .from(interviewPlansTable)
      .where(eq(interviewPlansTable.id, updated.planId))
      .limit(1);
    const questions = (plan?.questions as any[]) ?? [];
    res.json({
      ...updated,
      startedAt: updated.startedAt?.toISOString() || null,
      completedAt: null,
      createdAt: updated.createdAt.toISOString(),
      firstQuestion: questions[0] ?? null,
      /* Resumability metadata for the candidate-facing UI: shows the 24h
       countdown banner and lets the client decide whether to render a
       "you're resuming" toast vs the welcome screen. */
      expiresAt: result.expiresAt.toISOString(),
      durationHours: INTERVIEW_SESSION_TTL_HOURS,
      resumed: !result.firstOpen,
    });
  },
);

/* ── Session-scoped AI + biometric (BIPA) consent ──────────────────────────
 * The recruiter-sent interview link (/interviews/:id/room) is a PUBLIC page —
 * the candidate is not logged into the portal, so the portal consent endpoints
 * (which resolve the candidate from a portal session) can't be used here.
 * These two routes resolve the candidate from the interview session itself so
 * the candidate can read the disclosure and grant consent BEFORE any webcam /
 * recording starts. They intentionally do NOT require the interview cookie
 * (that is only minted at /begin, which happens AFTER consent).
 * ──────────────────────────────────────────────────────────────────────── */
router.get("/interviews/:interviewId/consent-status", async (req, res) => {
  if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
  const [session] = await db
    .select({ candidateId: interviewSessionsTable.candidateId })
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, req.params.interviewId))
    .limit(1);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { hasActiveAiConsent, getCurrentDisclosure, CURRENT_AI_CONSENT_VERSION } =
    await import("../lib/ai-consent.js");
  const active = await hasActiveAiConsent(session.candidateId);
  res.json({
    active,
    required: !active,
    currentVersion: CURRENT_AI_CONSENT_VERSION,
    disclosure: getCurrentDisclosure(),
  });
});

const SessionConsentBody = z
  .object({
    consent: z.literal(true), // AI interview disclosure affirmation
    biometricConsent: z.literal(true), // separate BIPA written biometric release
  })
  .strict();

router.post(
  "/interviews/:interviewId/consent",
  beginIpLimit,
  requireSameOriginPost,
  validate({ body: SessionConsentBody }),
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const [session] = await db
      .select({ candidateId: interviewSessionsTable.candidateId })
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    /* Fail closed on sentinel / missing candidate — we must have a real
     candidate row to attach the consent + biometric release to. */
    if (
      !session.candidateId ||
      session.candidateId === "demo" ||
      session.candidateId === "default"
    ) {
      res.status(400).json({ error: "no_candidate" });
      return;
    }
    const aiConsent = await import("../lib/ai-consent.js");
    const disclosure = aiConsent.getCurrentDisclosure();
    const [row] = await db
      .insert(candidateAiConsentTable)
      .values({
        candidateId: session.candidateId,
        consentVersion: aiConsent.CURRENT_AI_CONSENT_VERSION,
        disclosureSnapshot: disclosure,
        captureContext: {
          ua: (req.headers["user-agent"] as string)?.slice(0, 300) ?? null,
          ip:
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
            (req as any).ip ??
            null,
          biometricConsent: req.body.biometricConsent === true,
          viaInterviewSession: req.params.interviewId,
        },
      })
      .returning();
    res.json({ ok: true, consent: row });
  },
);

/* ── Step-up verification (email OTP) ─────────────────────────────────────
   When the cookie middleware sees a fingerprint mismatch (different
   browser/device, or a takeover attempt) it flips `stepUpRequired` and
   returns 401 {stepUp:true}. The candidate UI then walks them through:
     1. POST /interviews/:id/step-up/start  — emails a 6-digit code
     2. POST /interviews/:id/step-up/verify — { otp } rebinds and resumes
   These two routes do NOT use the cookie middleware (the candidate by
   definition can't satisfy it yet). They're rate-limited and lock after
   STEP_UP_MAX_ATTEMPTS to make brute force pointless. */
async function lookupCandidateEmail(
  session: any,
): Promise<{ email: string | null; firstName: string | null }> {
  if (session.candidateId && session.candidateId !== "demo" && session.candidateId !== "default") {
    const [cand] = await db
      .select()
      .from(candidatesTable)
      .where(eq(candidatesTable.id, session.candidateId))
      .limit(1);
    if (cand?.email) return { email: cand.email, firstName: cand.firstName ?? null };
  }
  if (session.applicationId && !["direct", "pipeline"].includes(session.applicationId)) {
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, session.applicationId))
      .limit(1);
    if (app?.candidateId) {
      const [cand] = await db
        .select()
        .from(candidatesTable)
        .where(eq(candidatesTable.id, app.candidateId))
        .limit(1);
      if (cand?.email) return { email: cand.email, firstName: cand.firstName ?? null };
    }
  }
  return { email: null, firstName: null };
}

/* Step-up dual limiters: the previous version keyed on `interviewId` only,
 * which meant an attacker with a leaked session ID could spam OTP requests
 * from one IP unbounded (the per-session bucket is one bucket per session,
 * which is exactly what the attacker wants — they're focused on one). The
 * per-IP layer below catches the spammer; the per-session layer still
 * protects a single victim from being OTP-emailed many times by a botnet. */
router.post(
  "/interviews/:interviewId/step-up/start",
  rateLimit({ windowMs: 60_000, max: 10, scope: "stepup-start-ip" }), // per IP
  rateLimit({
    windowMs: 60_000,
    max: 3,
    scope: "stepup-start-id",
    keyFn: (req) => `stepup-start:${req.params.interviewId}`,
  }), // per session
  async (req, res) => {
    const sid = req.params.interviewId;
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, sid))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (session.status === "completed" || session.completedAt) {
      res.status(410).json({ error: "session_completed" });
      return;
    }
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: "session_expired" });
      return;
    }
    if ((session.stepUpAttempts ?? 0) >= STEP_UP_MAX_ATTEMPTS) {
      res.status(429).json({
        error: "step_up_locked",
        message: "Too many failed attempts — please contact the recruiter.",
      });
      return;
    }

    const { email, firstName } = await lookupCandidateEmail(session);
    if (!email) {
      res.status(409).json({
        error: "no_candidate_email",
        message: "We don't have an email on file for this candidate. Please contact the recruiter.",
      });
      return;
    }

    const otp = generateOtp();
    await db
      .update(interviewSessionsTable)
      .set({
        stepUpOtpHash: hashOtp(otp),
        stepUpOtpExpiresAt: new Date(Date.now() + STEP_UP_OTP_TTL_MIN * 60_000),
      } as any)
      .where(eq(interviewSessionsTable.id, sid));

    if (isEmailConfigured()) {
      const greet = firstName || "there";
      const subject = `Your interview verification code: ${otp}`;
      const body = `Hi ${greet},\n\nWe noticed you're opening your interview from a different device or browser. To keep your session secure, please enter this verification code in the interview window:\n\n   ${otp}\n\nThe code expires in ${STEP_UP_OTP_TTL_MIN} minutes. If you didn't try to resume an interview, please contact the recruiter — someone may be attempting to access your session.\n\n— Lexy AI Hiring Platform`;
      void sendEmail({
        to: email,
        subject,
        text: body,
        html: plainToHtml(body),
        audit: {
          actorLabel: "Interview Engine",
          subjectType: "candidate",
          subjectId: session.candidateId,
          action: "interview.step_up.otp_sent",
          metadata: { sessionId: sid },
        },
      }).catch((err) => logger.error({ err, sid }, "Failed to send step-up OTP email"));
    } else {
      /* In dev with no email backend, log the code so the developer can
       test the flow end-to-end. NEVER do this in prod. */
      logger.warn({ sid, otp }, "[interview-step-up] dev OTP (no email configured)");
    }

    /* Always return success to avoid leaking whether the email exists. */
    res.json({
      ok: true,
      sentTo: email.replace(/(.).+(@.+)/, "$1***$2"),
      expiresInMinutes: STEP_UP_OTP_TTL_MIN,
    });
  },
);

router.post(
  "/interviews/:interviewId/step-up/verify",
  rateLimit({ windowMs: 60_000, max: 20, scope: "stepup-verify-ip" }), // per IP
  rateLimit({
    windowMs: 60_000,
    max: 10,
    scope: "stepup-verify-id",
    keyFn: (req) => `stepup-verify:${req.params.interviewId}`,
  }), // per session
  validate({ body: StepUpVerifyBody }),
  async (req, res) => {
    const sid = req.params.interviewId;
    const otp = String(req.body?.otp ?? "").trim();
    if (!/^\d{6}$/.test(otp)) {
      res.status(400).json({ error: "invalid_otp_format" });
      return;
    }

    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, sid))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (session.status === "completed" || session.completedAt) {
      res.status(410).json({ error: "session_completed" });
      return;
    }
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: "session_expired" });
      return;
    }
    if ((session.stepUpAttempts ?? 0) >= STEP_UP_MAX_ATTEMPTS) {
      res.status(429).json({ error: "step_up_locked" });
      return;
    }
    if (
      !session.stepUpOtpHash ||
      !session.stepUpOtpExpiresAt ||
      session.stepUpOtpExpiresAt.getTime() < Date.now()
    ) {
      res.status(400).json({ error: "otp_expired", message: "Code expired — request a new one." });
      return;
    }

    const expected = session.stepUpOtpHash;
    const provided = hashOtp(otp);
    const match =
      expected.length === provided.length &&
      nodeCrypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));

    if (!match) {
      const attempts = (session.stepUpAttempts ?? 0) + 1;
      const events = ((session.suspiciousEvents as any[]) ?? []).slice(-49);
      events.push({
        kind: "step_up_otp_failed",
        detail: { attempts, ip: req.ip },
        ts: new Date().toISOString(),
      });
      await db
        .update(interviewSessionsTable)
        .set({ stepUpAttempts: attempts, suspiciousEvents: events } as any)
        .where(eq(interviewSessionsTable.id, sid));
      logger.warn({ sid, attempts, ip: req.ip }, "[interview-step-up] OTP verification failed");
      /* Normalised trust event so it shows up in the recruiter integrity view. */
      void recordTrustEvent({
        sessionId: sid,
        tenantId: session.tenantId,
        candidateId: session.candidateId,
        eventType: TrustEventType.OTP_FAILED,
        severity: attempts >= STEP_UP_MAX_ATTEMPTS ? "high" : "medium",
        scoreImpact: -5,
        metadata: { attempts, attemptsRemaining: Math.max(0, STEP_UP_MAX_ATTEMPTS - attempts) },
      });
      res.status(401).json({
        error: "otp_incorrect",
        attemptsRemaining: Math.max(0, STEP_UP_MAX_ATTEMPTS - attempts),
      });
      return;
    }

    /* Success — rebind fingerprint to the current device, rotate the cookie
     nonce (kicks out the previously bound device), reset attempts and clear
     the step-up flag. The candidate is now resumed. */
    const { fp, ua, ipPrefix } = fingerprintFor(req);
    const nonce = newNonce();
    const verifiedNow = new Date();
    await db
      .update(interviewSessionsTable)
      .set({
        bindFingerprint: fp,
        bindUserAgent: ua.slice(0, 500),
        bindIpPrefix: ipPrefix,
        cookieNonce: nonce,
        stepUpRequired: false,
        verificationRequired: false,
        stepUpOtpHash: null,
        stepUpOtpExpiresAt: null,
        stepUpAttempts: 0,
        /* State-machine: candidate just re-proved identity → "verified". */
        status: "verified" as any,
        verifiedAt: verifiedNow,
        lastActiveAt: verifiedNow,
      } as any)
      .where(eq(interviewSessionsTable.id, sid));
    setSessionCookie(
      res,
      sid,
      nonce,
      session.expiresAt ?? new Date(Date.now() + INTERVIEW_SESSION_TTL_HOURS * 3600_000),
    );
    void recordTrustEvent({
      sessionId: sid,
      tenantId: session.tenantId,
      candidateId: session.candidateId,
      eventType: TrustEventType.OTP_VERIFIED,
      severity: "info",
      scoreImpact: 0,
      metadata: { ip: req.ip, fpPrefix: fp.slice(0, 12) },
    });

    res.json({ ok: true, expiresAt: session.expiresAt?.toISOString() ?? null });
  },
);

/* Read-access gate for GET /interviews/:interviewId.
 *
 * Two very different callers hit this endpoint:
 *   1. The CANDIDATE taking the interview — authenticated via the per-session
 *      HTTP-only cookie (requireInterviewSessionCookie). That middleware
 *      intentionally 410s a completed/expired session because the candidate
 *      must not resume it.
 *   2. The RECRUITER viewing the completed report from the dashboard — they
 *      have a normal auth token + tenant, NOT the candidate cookie. The cookie
 *      middleware would 410 them the moment the interview is done, which is
 *      exactly why a just-completed interview card showed "Interview not found".
 *
 * So: if the caller is an authenticated user who owns the session's tenant
 * (or a platform_admin), let them read it directly. Otherwise fall through to
 * the candidate-cookie middleware. */
/* Staff roles allowed to read interview results via a bearer token. A
 * `candidate`-role portal user ALSO carries a tenantId (users.tenant_id is
 * NOT NULL for candidates), so getAllowedTenantIds alone is NOT a staff
 * gate — without the explicit role allowlist a logged-in candidate could
 * fetch ANY interview session in their tenant subtree by id and read the
 * AI score / per-question grades / proctoring signals the fairness
 * firewall withholds from candidates. Candidates fall through to the
 * interview-session-cookie path, which only authorizes their own active
 * (pre-completion) session. */
const INTERVIEW_STAFF_ROLES = [
  "platform_admin",
  "tenant_admin",
  "recruiter",
  "recruiter_admin",
  "hiring_manager",
  "interviewer",
];

/* Role-based session read scope — the single rule for every staff by-id
 * interview read (detail, summary, proctor report, recruiter comments).
 * Mirrors the GET /interviews list scoping exactly:
 *   platform_admin  → everything
 *   tenant_admin / interviewer → tenant subtree
 *   recruiter_admin → data scope (assigned clients ∪ managed recruiters' job
 *                     tenants ∪ own staffed-job tenants)
 *   recruiter       → only sessions whose plan→job they're staffed on
 *   hiring_manager  → only sessions whose plan→job is assigned to them
 * Sessions with no plan/job fail closed for recruiter & hiring_manager. */
async function staffCanReadInterviewSession(caller: any, session: any): Promise<boolean> {
  if (caller.role === "platform_admin") return true;
  const allowed = await getAllowedTenantIds(caller);
  if (!allowed || !allowed.includes(session.tenantId ?? "")) return false;
  if (caller.role === "recruiter_admin") {
    const scope = await getDataScopeTenantIds(caller);
    return scope === null || scope.includes(session.tenantId ?? "");
  }
  if (caller.role === "recruiter" || caller.role === "hiring_manager") {
    const planId = (session as any).planId as string | null;
    if (!planId) return false;
    const [plan] = await db
      .select({ jobId: interviewPlansTable.jobId })
      .from(interviewPlansTable)
      .where(eq(interviewPlansTable.id, planId))
      .limit(1);
    const jobId = plan?.jobId ?? null;
    if (!jobId) return false;
    if (caller.role === "recruiter") {
      const assigned = await getRecruiterAssignedJobIds(caller);
      return assigned.includes(jobId);
    }
    const [job] = await db
      .select({ hm: jobsTable.assignedHiringManagerId })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);
    return job?.hm === caller.id;
  }
  return true; // tenant_admin, interviewer — subtree scope already enforced
}

async function gateInterviewRead(req: any, res: any, next: any): Promise<void> {
  try {
    const userId = getAuthUserId(req);
    if (userId) {
      const [caller] = await controlDb
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      if (caller && INTERVIEW_STAFF_ROLES.includes(caller.role)) {
        const [session] = await db
          .select()
          .from(interviewSessionsTable)
          .where(eq(interviewSessionsTable.id, req.params.interviewId))
          .limit(1);
        if (!session) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        if (await staffCanReadInterviewSession(caller, session)) {
          req.interviewSession = session;
          req.interviewStaffRead = true;
          next();
          return;
        }
      }
    }
  } catch {
    /* fall through to candidate-cookie auth */
  }
  return requireInterviewSessionCookie(req, res, next);
}

/* Walk a tenant up its parent chain (job's client tenant → staffing-agency
   parent). Capped + cycle-guarded so a bad parent_id can never loop forever. */
async function collectTenantChain(tenantId: string | null): Promise<string[]> {
  const chain: string[] = [];
  let current = tenantId;
  let guard = 0;
  while (current && guard < 12 && !chain.includes(current)) {
    chain.push(current);
    const [t] = await db
      .select({ parentId: tenantsTable.parentId })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, current))
      .limit(1);
    current = t?.parentId ?? null;
    guard++;
  }
  return chain;
}

/* GET /interviews/:interviewId/intro — the recruiter "smooth handover" intro.
   Returns { mode: "video" | "fallback", video_url, fallback_image_url, ... } so
   the candidate room can play the recruiter's recorded greeting before Lexy
   takes over.

   Deliberately NOT cookie-gated: this is fetched on the start screen BEFORE
   /begin mints the session cookie, so requireInterviewSessionCookie would 401
   ({needsBegin:true}) — exactly the state this feature must support. The
   interview link's session id in the URL is itself the candidate's credential
   (same trust level as the interview link), and the only thing exposed is the
   recruiter's own recorded intro video + its script. Never blocks: any missing
   piece (no session/plan/job/recruiter/video) degrades to the Lexy fallback. */
router.get("/interviews/:interviewId/intro", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const lexyFallback = {
    mode: "fallback" as const,
    video_url: null,
    fallback_image_url: null,
    can_skip: true,
    next_action: "start_lexy_interview" as const,
    script_text: null,
  };
  try {
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const planId = (session as any).planId as string | null;
    const [plan] = planId
      ? await db
          .select()
          .from(interviewPlansTable)
          .where(eq(interviewPlansTable.id, planId))
          .limit(1)
      : [];
    const jobId = (plan?.jobId as string | null) ?? null;
    if (!jobId) {
      res.json(lexyFallback);
      return;
    }

    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job) {
      res.json(lexyFallback);
      return;
    }

    const language = (session as any).language ?? "en-US";
    const preferredRecruiterUserId =
      (job as any).assignedRecruiterId ?? (job as any).createdById ?? null;
    const tenantIds = await collectTenantChain((job as any).tenantId ?? session.tenantId ?? null);

    const resp = await resolveCandidateIntro({
      jobId,
      language,
      tenantIds,
      preferredRecruiterUserId,
    });

    /* The <video> element cannot attach a Bearer token, and this start screen
     * renders BEFORE /begin mints the interview cookie — so a video_url that
     * points at the auth-gated streaming proxy (/api/storage/objects/…) always
     * 401s and the player shows a black frame. Swap proxy paths for short-lived
     * presigned S3 GET URLs; the session id in the link is the credential here
     * (same trust level as the rest of this deliberately public route), and the
     * only objects reachable are the recruiter's own intro MP4/photo. Any
     * presign failure degrades to the Lexy fallback rather than blocking. */
    const presignIntroAsset = async (
      url: string | null,
      allowed: RegExp,
    ): Promise<string | null> => {
      if (!url || !url.startsWith("/api/storage/objects/")) return url;
      /* Blast-radius guard: this public route must only ever sign recruiter
       * intro assets. If the resolver ever hands back a path outside the
       * expected namespace (data pollution), refuse to presign rather than
       * mint a public URL for an arbitrary private object. Intro MP4s live
       * under recruiter-intros/; the recruiter's photo (poster frame) is a
       * generic /objects/uploads/ entity referenced by the avatar profile. */
      if (!allowed.test(url)) {
        throw new Error(`intro asset outside allowed namespace: ${url}`);
      }
      const objectPath = url.slice("/api/storage".length);
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { s3Client } = await import("../lib/s3");
      const objectFile = await new ObjectStorageService().getObjectEntityFile(objectPath);
      return getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: objectFile.bucket, Key: objectFile.key }),
        { expiresIn: 900 },
      );
    };

    try {
      resp.video_url = await presignIntroAsset(
        resp.video_url,
        /^\/api\/storage\/objects\/recruiter-intros\//,
      );
      /* Poster image is cosmetic — if its path is unexpected, drop it rather
       * than degrading the whole intro to the Lexy fallback. */
      resp.fallback_image_url = await presignIntroAsset(
        resp.fallback_image_url,
        /^\/api\/storage\/objects\/(recruiter-intros|uploads)\//,
      ).catch(() => null);
    } catch (err) {
      logger.warn(
        { err, interviewId: req.params.interviewId },
        "[recruiter-intro] intro asset presign failed — degrading to fallback",
      );
      res.json(lexyFallback);
      return;
    }

    res.json(resp);
  } catch (err) {
    logger.warn(
      { err, interviewId: req.params.interviewId },
      "[recruiter-intro] candidate intro resolve failed (non-fatal)",
    );
    res.json(lexyFallback);
  }
});

router.get("/interviews/:interviewId", gateInterviewRead, async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const session =
    req.interviewSession ??
    (
      await db
        .select()
        .from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.id, req.params.interviewId))
        .limit(1)
    )[0];
  if (!session) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  let candidateName: string | null = null;
  let candidateEmail: string | null = null;
  let candidateTitle: string | null = null;
  if (session.candidateId && session.candidateId !== "demo" && session.candidateId !== "default") {
    const [cand] = await db
      .select()
      .from(candidatesTable)
      .where(eq(candidatesTable.id, session.candidateId))
      .limit(1);
    if (cand) {
      candidateName = `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() || null;
      candidateEmail = cand.email ?? null;
      candidateTitle = cand.currentTitle ?? null;
    }
  }

  /* Verify the recording actually exists in object storage before returning
   * the URL — avoids the browser showing a blank video player for stale refs. */
  let verifiedRecordingUrl: string | null = session.recordingUrl ?? null;
  if (verifiedRecordingUrl) {
    try {
      const { ObjectStorageService, ObjectNotFoundError } = await import("../lib/objectStorage");
      const svc = new ObjectStorageService();
      await svc.getObjectEntityFile(verifiedRecordingUrl);
    } catch {
      verifiedRecordingUrl = null;
    }
  }

  /* Never echo the session-binding secret material back to ANY caller —
   * bindSecret/cookieNonce/stepUpOtpHash are the credentials the cookie
   * middleware authenticates with, so returning them would let a reader
   * of this response forge a valid session cookie. */
  const {
    bindSecret: _bs,
    bindFingerprint: _bf,
    bindUserAgent: _bua,
    bindIpPrefix: _bip,
    cookieNonce: _cn,
    stepUpOtpHash: _oh,
    ...safeSession
  } = session as any;

  /* Fairness firewall: when the caller is the CANDIDATE (interview-cookie
   * auth, not a staff bearer token), withhold the AI assessment and
   * integrity/proctoring internals. The room UI only needs the session
   * shell (status, planId, question index, language, recording). Scores
   * are graded at /end (after which the cookie is burned), but stripping
   * here keeps the guarantee data-layer even if grading timing changes. */
  const isStaffRead = req.interviewStaffRead === true;
  const payload = isStaffRead
    ? safeSession
    : (() => {
        const {
          score: _s,
          answers: _a,
          codeSubmissions: _c,
          proctoring_events: _p,
          suspiciousEvents: _se,
          trustScore: _t,
          suspiciousEventCount: _sc,
          ...candidateSafe
        } = safeSession;
        return {
          ...candidateSafe,
          currentQuestionIndex: safeSession.currentQuestionIndex,
          totalQuestions: safeSession.totalQuestions,
        };
      })();

  res.json({
    ...payload,
    recordingUrl: verifiedRecordingUrl,
    candidateName,
    candidateEmail,
    candidateTitle,
    startedAt: session.startedAt?.toISOString() || null,
    completedAt: session.completedAt?.toISOString() || null,
    createdAt: session.createdAt.toISOString(),
  });
});

router.post(
  "/interviews/:interviewId/answer",
  validate({ body: AnswerBody }),
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const { questionId, answerText } = req.body;
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const [plan] = await db
      .select()
      .from(interviewPlansTable)
      .where(eq(interviewPlansTable.id, session.planId))
      .limit(1);
    const questions = (plan?.questions as any[]) || [];
    const answers = (session.answers as any[]) || [];
    const language = session.language ?? "en-US";

    // Calibrated grading — kept in lockstep with the /end per-question grader so a
    // non-answer ("next question", "skip", "I don't know") scores very low instead
    // of defaulting to a flattering 70. An empty answer is a real, low signal → 0.
    // On a grading error we leave the score null (never fabricate a number).
    let answerScore: number | null = null;
    const trimmedAnswer = (answerText ?? "").toString().trim();
    if (!trimmedAnswer) {
      answerScore = 0;
      answers.push({ questionId, answer: answerText, score: 0 });
    } else {
      try {
        const langLabel = resolveLangMeta(language).label;
        const question = questions.find((q: any) => q.id === questionId);
        const scoreResult = await generateJSON<{ score: number; feedback: string }>(
          `Rate this interview answer from 0 to 100 on relevance, depth, specificity and clarity of CONTENT. A non-answer, refusal, joke, or off-topic remark (e.g. "I'm just testing", "I don't know", "no comment") MUST score very low (under 20). Reserve 80+ ONLY for answers containing verifiable specifics: concrete numbers, named tools or decisions, and measurable or verifiable outcomes. A well-structured answer (e.g. STAR-formatted) whose claims are generic and unverifiable is average at best (50-70) — structure is not substance. Judge substance, not format: a narrative or conversational answer rich in verifiable specifics deserves the same score as a formally structured one. Do NOT penalize accent, grammar, fluency, or interview-answer style and format (e.g. absence of STAR structure or corporate interview coaching) unless it genuinely prevents understanding.\nQuestion: ${question?.text ?? ""}\nAnswer: ${answerText}\nReturn JSON: { "score": number, "feedback": string (1 honest sentence in ${langLabel}) }`,
          `You are a rigorous interviewer grading a single answer. Be honest and calibrated — never inflate a weak or non-serious answer. Respond with valid JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
          language,
        );
        answerScore = Math.min(100, Math.max(0, Math.round(scoreResult.score ?? 0)));
        answers.push({
          questionId,
          answer: answerText,
          score: answerScore,
          feedback: scoreResult.feedback,
        });
      } catch {
        answers.push({ questionId, answer: answerText, score: null });
      }
    }

    const nextIndex = session.currentQuestionIndex + 1;
    const isComplete = nextIndex >= session.totalQuestions;

    // Average only over answers that were actually scored (numeric); null grades
    // are excluded rather than counted as a flattering 70.
    const scoredAnswers = answers.filter((a: any) => typeof a.score === "number");
    const avgScore = scoredAnswers.length
      ? scoredAnswers.reduce((sum: number, a: any) => sum + a.score, 0) / scoredAnswers.length
      : null;

    await db
      .update(interviewSessionsTable)
      .set({
        answers,
        currentQuestionIndex: nextIndex,
        status: isComplete ? "completed" : "in_progress",
        completedAt: isComplete ? new Date() : null,
        score: isComplete ? avgScore : null,
      })
      .where(eq(interviewSessionsTable.id, req.params.interviewId));

    const nextQuestion = !isComplete ? questions[nextIndex] : null;
    const thisAnswer = answers[answers.length - 1];

    // When the session completes, asynchronously feed scores into the intelligence engine
    if (isComplete && session.candidateId && plan?.jobId) {
      setImmediate(() => {
        upsertIntelligenceFromInterviewSession(session.id, {
          tenantId: session.tenantId ?? "demo",
          jobId: plan.jobId,
          candidateId: session.candidateId,
          answers: answers.map((a: any) => ({
            questionId: a.questionId,
            answer: a.answer,
            score: a.score ?? null,
            feedback: a.feedback,
          })),
          overallScore: Math.round(avgScore ?? 0),
        }).catch(() => {});
      });
    }

    /* Fairness firewall: this is a candidate-cookie route on a RECRUITER-run
     * interview — the per-answer AI grade is persisted for the hiring team but
     * must never be echoed back to the candidate mid-interview. */
    void thisAnswer;
    res.json({ nextQuestion: nextQuestion || null, isComplete });
  },
);

// ── POST /interviews/:id/proctor-event ────────────────────────────────────────
// Log a proctoring event (tab-switch, copy, paste, no-face, multi-face, etc.)
router.post(
  "/interviews/:interviewId/proctor-event",
  validate({ body: ProctorEventBody }),
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const { type, detail, snapshotBase64 } = req.body;

    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const event: Record<string, any> = {
      type,
      detail: detail ?? null,
      ts: new Date().toISOString(),
    };

    // Optional: analyze snapshot with OpenAI Vision if provided
    if (snapshotBase64 && type === "snapshot") {
      try {
        const openai = new OpenAI({
          apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
          baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
        });
        const visionRes = await openai.chat.completions.create({
          model: "gpt-4o",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Analyze this interview webcam snapshot. Reply with JSON only: { "faceCount": number, "faceVisible": boolean, "suspiciousActivity": string|null, "notes": string }. Check: is exactly one face visible? Is the person looking at the screen? Any suspicious activity?`,
                },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${snapshotBase64}` },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
        });
        const analysis = JSON.parse(visionRes.choices[0]?.message?.content || "{}");
        event.faceCount = analysis.faceCount ?? null;
        event.faceVisible = analysis.faceVisible ?? null;
        event.suspiciousActivity = analysis.suspiciousActivity ?? null;
        event.visionNotes = analysis.notes ?? null;
      } catch {
        event.visionError = "Vision analysis unavailable";
      }
    }

    const existing = (session.proctoring_events as any[]) ?? [];
    await db
      .update(interviewSessionsTable)
      .set({ proctoring_events: [...existing, event] } as any)
      .where(eq(interviewSessionsTable.id, req.params.interviewId));

    logger.info({ interviewId: req.params.interviewId, type }, "[proctor] Event logged");
    res.json({ logged: true, event });
  },
);

// ── GET /interviews/:id/proctor-report ────────────────────────────────────────
router.get("/interviews/:interviewId/proctor-report", async (req: any, res) => {
  /* Staff-only — proctoring data must not leak across tenants. */
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  /* Staff-role allowlist BEFORE the tenant check — candidate-role users also
     carry a tenantId, so tenant scoping alone would let a logged-in candidate
     read proctoring internals for any session in their tenant. */
  if (!INTERVIEW_STAFF_ROLES.includes(caller.role)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [session] = await db
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, req.params.interviewId))
    .limit(1);
  if (!session) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await staffCanReadInterviewSession(caller, session))) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const events = (session.proctoring_events as any[]) ?? [];
  const tabSwitches = events.filter((e) => e.type === "tab_switch").length;
  const copyEvents = events.filter((e) => e.type === "copy").length;
  const pasteEvents = events.filter((e) => e.type === "paste").length;
  const noFaceEvents = events.filter(
    (e) => e.type === "snapshot" && e.faceVisible === false,
  ).length;
  const multiFace = events.filter((e) => e.type === "snapshot" && (e.faceCount ?? 0) > 1).length;
  const suspicious = events.filter((e) => e.type === "snapshot" && e.suspiciousActivity).length;

  // Integrity score: start at 100, deduct for violations
  let integrityScore = 100;
  integrityScore -= tabSwitches * 10;
  integrityScore -= copyEvents * 5;
  integrityScore -= pasteEvents * 8;
  integrityScore -= noFaceEvents * 5;
  integrityScore -= multiFace * 15;
  integrityScore -= suspicious * 12;
  integrityScore = Math.max(0, Math.min(100, integrityScore));

  const violations: string[] = [];
  if (tabSwitches) violations.push(`${tabSwitches} tab switch${tabSwitches > 1 ? "es" : ""}`);
  if (copyEvents) violations.push(`${copyEvents} copy attempt${copyEvents > 1 ? "s" : ""}`);
  if (pasteEvents) violations.push(`${pasteEvents} paste attempt${pasteEvents > 1 ? "s" : ""}`);
  if (noFaceEvents)
    violations.push(`${noFaceEvents} snapshot${noFaceEvents > 1 ? "s" : ""} with no face`);
  if (multiFace)
    violations.push(`${multiFace} snapshot${multiFace > 1 ? "s" : ""} with multiple faces`);
  if (suspicious)
    violations.push(`${suspicious} suspicious activity detection${suspicious > 1 ? "s" : ""}`);

  /* Pull the last 200 normalised trust_events for the recruiter timeline.
     This is the spec §9 "integrity view" payload — combines proctoring
     signals (above) with session-level integrity (below). */
  const trustEvents = await db
    .select()
    .from(trustEventsTable)
    .where(eq(trustEventsTable.sessionId, session.id))
    .orderBy(desc(trustEventsTable.createdAt))
    .limit(200);

  /* Combine the proctoring integrityScore (computed above) with the
     session's persisted trustScore (driven by trust_events). The lower of
     the two is the candidate's effective trust — this means a candidate
     can be flagged for either in-room behaviour OR session-binding risk. */
  const sessionTrustScore = session.trustScore ?? 100;
  const effectiveTrustScore = Math.min(integrityScore, sessionTrustScore);
  const trustLevel =
    effectiveTrustScore >= 85 ? "high" : effectiveTrustScore >= 60 ? "medium" : "low";

  /* Group integrity events by type for the dashboard summary cards. */
  const eventsByType: Record<string, number> = {};
  for (const e of trustEvents) eventsByType[e.eventType] = (eventsByType[e.eventType] ?? 0) + 1;

  res.json({
    sessionId: session.id,
    integrityScore,
    sessionTrustScore,
    trustScore: effectiveTrustScore,
    totalEvents: events.length,
    tabSwitches,
    copyEvents,
    pasteEvents,
    noFaceEvents,
    multiFace,
    suspicious,
    violations,
    events,
    trustLevel,
    /* Spec §9 fields. */
    resumeCount: session.resumeCount ?? 0,
    suspiciousEventCount: session.suspiciousEventCount ?? 0,
    deviceConsistency: (session.suspiciousEventCount ?? 0) === 0 ? "consistent" : "changed",
    completionTimeline: {
      claimedAt: session.claimedAt ?? null,
      verifiedAt: session.verifiedAt ?? null,
      lastActiveAt: session.lastActiveAt ?? null,
      completedAt: session.completedAt ?? null,
      flaggedAt: session.flaggedAt ?? null,
      expiredAt: session.expiredAt ?? null,
    },
    flagReason:
      session.status === "flagged"
        ? "Critical integrity event triggered an automatic flag — review trust events below."
        : null,
    trustEvents: trustEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      severity: e.severity,
      scoreImpact: e.scoreImpact,
      metadata: e.metadata,
      createdAt: e.createdAt,
    })),
    trustEventsByType: eventsByType,
  });
});

/* ── POST /interviews/:interviewId/upload-token ────────────────────────────
 * Issues a short-lived JWT that the browser can use as a Bearer token for
 * the recording upload to /storage/uploads/recording.
 *
 * Why this exists: the interview session cookie is path-scoped to
 * /api/interviews/:id and is cleared by /end, so it never reaches the
 * storage route. Candidate portal users have no localStorage JWT token,
 * so the upload arrives unauthenticated (401). This endpoint is called
 * BEFORE stopAndUpload() fires (while the cookie is still valid) and
 * returns a token the client stores in a ref for the upload request.
 * ─────────────────────────────────────────────────────────────────────── */
router.post(
  "/interviews/:interviewId/upload-token",
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    if (!(await assertSessionJobApproved(res, req.params.interviewId))) return;
    const session = (req as any).interviewSession;
    const candidateId = session?.candidateId;
    if (!candidateId) return res.status(400).json({ error: "No candidate on session" });

    const [cand] = await db
      .select({ userId: candidatesTable.userId, tenantId: candidatesTable.tenantId })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    if (!cand?.userId) {
      return res.status(403).json({ error: "Candidate has no portal account" });
    }

    const uploadToken = issueToken({
      userId: cand.userId,
      role: "candidate",
      tenantId: cand.tenantId ?? null,
    });
    return res.json({ uploadToken });
  },
);

router.post(
  "/interviews/:interviewId/end",
  requireSameOriginPost,
  requireInterviewSessionCookie,
  requireActiveAiConsent,
  async (req, res) => {
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    /* Burn the resumable cookie + nonce now — once the interview is finished it
     should never be replayable. */
    await clearOnComplete(req.params.interviewId, res);

    /* Track whether THIS request is the one that transitioned the session to
     * completed. Subsequent /end calls will see status==='completed' already
     * and skip the recruiter notification to avoid spam. */
    const wasAlreadyCompleted = session.status === "completed";

    const completedAt = new Date();
    await db
      .update(interviewSessionsTable)
      .set({ status: "completed", completedAt, lastActiveAt: completedAt } as any)
      .where(eq(interviewSessionsTable.id, req.params.interviewId));
    if (!wasAlreadyCompleted) {
      /* Resolve jobId for event (planId → plan.jobId) — best-effort, skip if unavailable. */
      const _planForEvent = session.planId
        ? await db
            .select({ jobId: interviewPlansTable.jobId })
            .from(interviewPlansTable)
            .where(eq(interviewPlansTable.id, session.planId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : null;
      void logCandidateEvent({
        candidateId: session.candidateId,
        jobId: _planForEvent?.jobId ?? null,
        tenantId: session.tenantId ?? "",
        applicationId:
          session.applicationId && !["direct", "pipeline"].includes(session.applicationId)
            ? session.applicationId
            : null,
        eventType: "INTERVIEW_COMPLETED",
        actorType: "candidate",
        source: "interview_agent",
        metadata: { sessionId: session.id, trustScore: (session as any).trustScore },
      });
    }
    if (!wasAlreadyCompleted) {
      void recordTrustEvent({
        sessionId: req.params.interviewId,
        tenantId: session.tenantId,
        candidateId: session.candidateId,
        eventType: TrustEventType.SESSION_COMPLETED,
        severity: "info",
        scoreImpact: 0,
        metadata: { resumeCount: session.resumeCount, trustScore: session.trustScore },
      });
    }

    /* Auto-advance to the new "interview_completed" stage so the recruiter
     * Kanban surfaces freshly-finished interviews in their own column
     * (between Scheduled and Offer). Two write paths because the platform
     * tracks candidates in two places:
     *   1. Real applications (table `applications`, column `stage`)
     *   2. Sourced candidates (table `sourced_candidates`, stage lives in
     *      `raw_data.stage` — used for pipeline-only candidates with no
     *      formal application yet). When a session's applicationId is the
     *      "pipeline" placeholder, candidateId points at the sourced row. */
    const PRE_COMPLETION = [
      "sourced",
      "applied",
      "screening",
      "verification",
      "shortlisted",
      "phone_screen",
      "assessment",
      "interview_scheduled",
      "interview",
    ];

    /* Connection Engine context resolved while we walk the pipeline links below.
     * We only record a `completed_interview` engagement signal for recruiter /
     * pipeline interviews (a real application or a sourced row) — never for
     * candidate self-practice (mock/baseline) sessions, which would wrongly
     * inflate the employer-side connection score. */
    let connRecruiterLinked = false;
    let connCandidateId: string | null = null;
    let connJobId: string | null = null;

    if (session.applicationId && !["direct", "pipeline"].includes(session.applicationId)) {
      const [app] = await db
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.id, session.applicationId))
        .limit(1);
      if (app) {
        connRecruiterLinked = true;
        connCandidateId = app.candidateId;
        connJobId = app.jobId ?? null;
      }
      if (app && PRE_COMPLETION.includes(app.stage)) {
        if (app.candidateId && app.jobId) {
          await changeCandidateStage({
            tenantId: app.tenantId ?? session.tenantId ?? "",
            candidateId: app.candidateId,
            jobId: app.jobId,
            to: "interview_completed",
            from: app.stage,
            actor: { type: "system", role: null, id: session.id },
            source: "interview_end",
            applicationId: app.id,
            metadata: { sessionId: session.id },
          });
        } else {
          // stage-write-exempt: application missing candidateId/jobId cannot key STAGE_CHANGED
          await db
            .update(applicationsTable)
            .set({ stage: "interview_completed", updatedAt: new Date() })
            .where(eq(applicationsTable.id, session.applicationId));
        }
      }
    } else if (session.candidateId) {
      /* Placeholder applicationId ("pipeline"/"direct"): the session was not
       * threaded to a specific application id at creation time. The candidate
       * may STILL have a real `applications` row (e.g. the interview was
       * launched from the pipeline board, which doesn't pass applicationId).
       * Prefer advancing that real application so the recruiter Kanban moves
       * the card from "Interview Scheduled" to "Interview Done"; only fall back
       * to the sourced_candidates pipeline row when no advanceable application
       * exists. */
      // Resolve this session's job (plan_id → plans.job_id) so we target the
      // right application when the candidate has applied to more than one job.
      // NB: we match on candidate + job, NOT tenant. A session is stamped with
      // the JOB's tenant, but the candidate's application row can live under a
      // different tenant (candidate-owned vs job-owning tenant), so a strict
      // tenant-equality filter would miss the real application.
      let sessionJobId: string | null = null;
      if (session.planId) {
        const [plan] = await db
          .select({ jobId: interviewPlansTable.jobId })
          .from(interviewPlansTable)
          .where(eq(interviewPlansTable.id, session.planId))
          .limit(1);
        sessionJobId = plan?.jobId ?? null;
      }
      const candidateApps = await db
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.candidateId, session.candidateId));
      /* Identify the ONE application this interview belongs to. Prefer the
       * application for the session's job (the strongest link); if the job can't
       * be resolved, only accept a single unambiguous application. We never
       * advance a DIFFERENT job's application for this candidate, even if it
       * happens to be in a pre-completion stage. */
      const targetApp = sessionJobId
        ? candidateApps.find((a) => a.jobId === sessionJobId)
        : candidateApps.length === 1
          ? candidateApps[0]
          : undefined;

      if (targetApp) {
        connRecruiterLinked = true;
        connCandidateId = targetApp.candidateId;
        connJobId = targetApp.jobId ?? null;
        /* Real applicant for this job. Advance only if still pre-completion;
         * an already-completed/terminal stage is left untouched. Either way we
         * do NOT fall through to the sourced path — a real application owns the
         * pipeline stage for this candidate+job. */
        if (PRE_COMPLETION.includes(targetApp.stage)) {
          if (targetApp.candidateId && targetApp.jobId) {
            await changeCandidateStage({
              tenantId: targetApp.tenantId ?? session.tenantId ?? "",
              candidateId: targetApp.candidateId,
              jobId: targetApp.jobId,
              to: "interview_completed",
              from: targetApp.stage,
              actor: { type: "system", role: null, id: session.id },
              source: "interview_end",
              applicationId: targetApp.id,
              metadata: { sessionId: session.id },
            });
          } else {
            // stage-write-exempt: application missing candidateId/jobId cannot key STAGE_CHANGED
            await db
              .update(applicationsTable)
              .set({ stage: "interview_completed", updatedAt: new Date() })
              .where(eq(applicationsTable.id, targetApp.id));
          }
        }
      } else {
        /* No application for this job — sourced-pipeline path. session.candidateId may
         * point at EITHER:
         *   (a) sourced_candidates.id (the sourced row itself), OR
         *   (b) candidates.id (the canonical record), in which case the sourced
         *       row is linked via sourced_candidates.normalized_candidate_id.
         * Match on either column so the auto-advance works regardless of which
         * shape was stored on the session. */
        const [sourced] = await db
          .select()
          .from(sourcedCandidatesTable)
          .where(
            or(
              eq(sourcedCandidatesTable.id, session.candidateId),
              eq(sourcedCandidatesTable.normalizedCandidateId, session.candidateId),
            )!,
          )
          .limit(1);
        if (sourced) {
          connRecruiterLinked = true;
          connCandidateId = sourced.normalizedCandidateId ?? null;
          connJobId = sessionJobId;
          const raw = (sourced.rawData as any) || {};
          const currentStage = raw.stage || "sourced";
          if (PRE_COMPLETION.includes(currentStage)) {
            if (sourced.normalizedCandidateId && sessionJobId) {
              await changeCandidateStage({
                tenantId: sourced.tenantId ?? session.tenantId ?? "",
                candidateId: sourced.normalizedCandidateId,
                jobId: sessionJobId,
                to: "interview_completed",
                from: currentStage,
                actor: { type: "system", role: null, id: session.id },
                source: "interview_end",
                sourcedId: sourced.id,
                sourcedRawDataPatch: { interviewCompletedAt: new Date().toISOString() },
                metadata: { sessionId: session.id },
              });
            } else {
              // stage-write-exempt: sourced row has no canonical candidateId (or session job) to key the STAGE_CHANGED event/audit rows
              await db
                .update(sourcedCandidatesTable)
                .set({
                  rawData: {
                    ...raw,
                    stage: "interview_completed",
                    interviewCompletedAt: new Date().toISOString(),
                  },
                })
                .where(eq(sourcedCandidatesTable.id, sourced.id));
            }
          }
        }
      }
    }

    /* ── Connection Engine: record a `completed_interview` engagement signal ──
     * Employer-side score only. Fires once per session completion
     * (`!wasAlreadyCompleted` dedups repeated /end calls) and only for
     * recruiter/pipeline interviews — `connRecruiterLinked` is false for
     * candidate self-practice (mock/baseline) sessions, which must never lift
     * the employer-side connection score. Best-effort: a failure here never
     * aborts the interview-end response. */
    if (!wasAlreadyCompleted && connRecruiterLinked && connCandidateId) {
      try {
        const { recordConnectionEvent, recalculateConnectionScore } =
          await import("../lib/connectionEngine.js");
        await recordConnectionEvent({
          candidateId: connCandidateId,
          eventType: "completed_interview",
          jobId: connJobId,
          employerId: session.tenantId ?? null,
        });
        await recalculateConnectionScore(connCandidateId, connJobId, session.tenantId ?? null);
      } catch (err: any) {
        logger.error(
          { err: err?.message },
          "[interviews] Connection Engine completed_interview update failed",
        );
      }
    }

    /* ── Verification Agent: auto-run after interview completes ──────────────
     * The UI banner says "Digital identity checks run automatically after the
     * interview stage" — but previously the check only fired when a recruiter
     * manually dragged the kanban card into the Verification column. This
     * block closes the gap: any time a real recruiter/pipeline interview ends
     * we fire runCandidateVerification() in the background so the Verification
     * tab is populated without any recruiter action.
     *
     * Guards:
     *  - !wasAlreadyCompleted  — dedup: /end can be called more than once
     *  - connRecruiterLinked   — skip mock/baseline self-practice sessions
     *  - connCandidateId       — must have a resolved normalized candidate
     *
     * Best-effort: errors are logged but never surface to the candidate or
     * block the interview-end response. */
    if (!wasAlreadyCompleted && connRecruiterLinked && connCandidateId) {
      const verifyTenantId = session.tenantId ?? null;
      if (verifyTenantId) {
        import("../lib/run-verification.js")
          .then(({ runCandidateVerification }) =>
            runCandidateVerification({ candidateId: connCandidateId!, tenantId: verifyTenantId }),
          )
          .then((result) => {
            if (result) {
              logger.info(
                { candidateId: connCandidateId, status: result.verificationStatus },
                "[interviews] Post-interview verification complete",
              );
            }
          })
          .catch((err) => {
            logger.error(
              { err: err?.message, candidateId: connCandidateId },
              "[interviews] Post-interview verification failed (non-fatal)",
            );
          });
      }
    }

    /* Notify the candidate's owning recruiter that an interview just
     * finished, and email the candidate a thank-you.
     *
     * "Owning recruiter" = the user who uploaded/owns this candidate. The
     * hiring manager only gets pinged here when they uploaded the candidate
     * themselves — they "become the recruiter" for that candidate. The
     * recruiter→HM hand-off is a separate flow.
     *
     * Resolution order (most authoritative first):
     *   1. candidates.createdById — set when a recruiter (or HM) uploaded
     *      the candidate directly.
     *   2. jobs.assignedRecruiterId — default job owner.
     *   3. jobs.assignedHiringManagerId — last resort when no recruiter
     *      is assigned to the job.
     *
     * Best-effort and wrapped in try/catch so a failed insert/email never
     * aborts the interview-end response. */
    try {
      let recipientId: string | null = null;
      let candidateName = "A candidate";
      let candidateEmail: string | null = null;
      let candidateFirstName: string | null = null;
      let jobTitle: string | null = null;
      let tenantId = session.tenantId;

      if (session.applicationId && !["direct", "pipeline"].includes(session.applicationId)) {
        const [app] = await db
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.id, session.applicationId))
          .limit(1);
        if (app) {
          const [cand] = await db
            .select()
            .from(candidatesTable)
            .where(eq(candidatesTable.id, app.candidateId))
            .limit(1);
          const [job] = await db
            .select()
            .from(jobsTable)
            .where(eq(jobsTable.id, app.jobId))
            .limit(1);
          recipientId =
            cand?.createdById ?? job?.assignedRecruiterId ?? job?.assignedHiringManagerId ?? null;
          if (cand) {
            candidateName =
              `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() ||
              cand.email ||
              candidateName;
            candidateEmail = cand.email ?? null;
            candidateFirstName = cand.firstName ?? null;
          }
          jobTitle = job?.title ?? null;
          tenantId = app.tenantId ?? tenantId;
        }
      } else if (session.candidateId) {
        /* Sourced-pipeline sessions: session.candidateId points at the
         * normalized `candidates` row (not the sourced row directly). The
         * sourced row carries `jobId` in raw_data, and links back via
         * `normalized_candidate_id`. Try the direct id first (legacy),
         * then fall back to the normalized link. */
        let [sourced] = await db
          .select()
          .from(sourcedCandidatesTable)
          .where(eq(sourcedCandidatesTable.id, session.candidateId))
          .limit(1);
        if (!sourced) {
          [sourced] = await db
            .select()
            .from(sourcedCandidatesTable)
            .where(eq(sourcedCandidatesTable.normalizedCandidateId, session.candidateId))
            .limit(1);
        }
        const raw = (sourced?.rawData as any) || {};
        /* Prefer the canonical `candidates` row when available, since sourced
         * raw_data can be stale or partially populated. */
        const [cand] = await db
          .select()
          .from(candidatesTable)
          .where(eq(candidatesTable.id, session.candidateId))
          .limit(1);
        candidateName = cand
          ? `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() || cand.email || candidateName
          : `${raw.firstName ?? ""} ${raw.lastName ?? ""}`.trim() ||
            raw.name ||
            raw.email ||
            candidateName;
        candidateEmail = cand?.email ?? raw.email ?? null;
        candidateFirstName = cand?.firstName ?? raw.firstName ?? null;
        const jobId = raw.jobId ?? null;
        let job: any = null;
        if (jobId) {
          [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
          jobTitle = job?.title ?? null;
          tenantId = job?.tenantId ?? tenantId;
        }
        /* Sourced rows don't have a createdById field today, so we look at
         * the canonical candidates row for an uploader signal first. If
         * neither is set, fall back to the job's assigned recruiter (or HM
         * if no recruiter). */
        recipientId =
          cand?.createdById ??
          raw.createdById ??
          raw.uploadedById ??
          raw.sourcedById ??
          null ??
          job?.assignedRecruiterId ??
          job?.assignedHiringManagerId ??
          null;
      }

      /* Single owning-recruiter notification (in-app + email). Only fire once
       * per session: subsequent /end calls (e.g. retries) see
       * status==='completed' already and skip notification to avoid spam. */
      if (recipientId && !wasAlreadyCompleted) {
        const { recordAudit } = await import("../lib/audit.js");
        await db.insert(userNotificationsTable).values({
          tenantId,
          userId: recipientId,
          type: "interview_completed",
          title: "Candidate completed interview",
          message: `${candidateName} just finished their interview${jobTitle ? ` for ${jobTitle}` : ""}. Review the recording and decide next steps.`,
          actionUrl: `/interviews/${session.id}`,
        });
        void recordAudit({
          tenantId,
          actorType: "system",
          actorLabel: "Interview Engine",
          subjectType: "user",
          subjectId: recipientId,
          subjectLabel: candidateName,
          channel: "in_app",
          direction: "outbound",
          action: "notification.user.interview_completed",
          title: "Candidate completed interview",
          body: `${candidateName} finished their interview${jobTitle ? ` for ${jobTitle}` : ""}.`,
          metadata: { sessionId: session.id, jobTitle },
        });

        /* Email the owning recruiter so they get notified outside the app
         * too. Best-effort: log and continue if the user has no email or
         * the send fails. The deep link points at the interview review
         * page so they can act in one click. */
        try {
          const [recipUser] = await controlDb
            .select()
            .from(usersTable)
            .where(eq(usersTable.id, recipientId))
            .limit(1);
          if (recipUser?.email) {
            const { sendEmail, plainToHtml, isEmailConfigured } = await import("../lib/email.js");
            if (isEmailConfigured()) {
              const recruiterFirst = (recipUser.name ?? "").split(" ")[0] || "there";
              const reviewUrl = `${process.env.APP_BASE_URL || "https://app.l3xy.ai"}/interviews/${session.id}`;
              const subject = `${candidateName} completed their interview${jobTitle ? ` for ${jobTitle}` : ""}`;
              const body = `Hi ${recruiterFirst},

${candidateName} just finished their interview${jobTitle ? ` for the ${jobTitle} role` : ""}. The recording and AI summary are ready for your review.

Review the interview here:
${reviewUrl}

— Lexy AI Hiring Platform`;
              void sendEmail({
                to: recipUser.email,
                subject,
                text: body,
                html: plainToHtml(body),
                audit: {
                  tenantId,
                  actorLabel: "Interview Engine",
                  subjectType: "user",
                  subjectId: recipientId,
                  subjectLabel: recipUser.name ?? recipUser.email,
                  action: "interview.completed.recruiter_email",
                  metadata: { sessionId: session.id, jobTitle, candidateName },
                },
              }).catch((err) =>
                logger.error({ err }, "Failed to send recruiter interview-completed email"),
              );
            }
          }
        } catch (err) {
          logger.error({ err }, "Failed to look up recruiter for interview-completed email");
        }
      }

      /* Candidate thank-you email. Only fire on the transition (not retries)
       * and only when we have an email + the email service is configured.
       * Localized to the session language (Arabic vs everything else). */
      if (candidateEmail && !wasAlreadyCompleted) {
        const { sendEmail, plainToHtml, isEmailConfigured } = await import("../lib/email.js");
        if (isEmailConfigured()) {
          const lang = (session.language ?? "en").toLowerCase();
          const isArabic = lang.startsWith("ar");
          const greetingName =
            candidateFirstName || candidateName.split(" ")[0] || (isArabic ? "" : "there");
          const subject = isArabic
            ? `شكرًا لمشاركتك في المقابلة${jobTitle ? ` لوظيفة ${jobTitle}` : ""}`
            : `Thank you for interviewing${jobTitle ? ` for ${jobTitle}` : ""}`;
          const body = isArabic
            ? `مرحبًا ${greetingName},\n\nشكرًا جزيلًا لإكمال المقابلة${jobTitle ? ` لوظيفة ${jobTitle}` : ""}. نقدّر الوقت والجهد الذي خصصته لمشاركة خبرتك معنا.\n\nسيقوم فريق التوظيف بمراجعة مقابلتك خلال الأيام القليلة القادمة وسنتواصل معك بالخطوات التالية في أقرب وقت ممكن.\n\nنتمنى لك التوفيق،\nفريق التوظيف`
            : `Hi ${greetingName},\n\nThank you for completing your interview${jobTitle ? ` for the ${jobTitle} role` : ""}. We really appreciate the time and thought you put into sharing your experience with us.\n\nOur hiring team will review your interview over the next few days and follow up with you on next steps as soon as possible.\n\nWishing you all the best,\nThe Hiring Team`;
          void sendEmail({
            to: candidateEmail,
            subject,
            text: body,
            html: plainToHtml(body),
            audit: {
              tenantId,
              actorLabel: "Interview Engine",
              subjectType: "candidate",
              subjectId: session.candidateId,
              subjectLabel: candidateName,
              action: "interview.thank_you.sent",
              metadata: { sessionId: session.id, jobTitle, language: lang },
            },
          }).catch((err) => logger.error({ err }, "Failed to send candidate thank-you email"));
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to create interview-completed notifications");
    }

    /* ── Post-interview AI is now asynchronous ─────────────────────────────────
     All expensive AI work (per-answer grading, the recruiter summary + AEDT
     audit log, candidate-intelligence enrichment, and match rescoring) used to
     run INLINE here, blocking the candidate's /end request for many seconds and
     scaling poorly under concurrency. It now runs in the Postgres-backed AI job
     queue (lib/ai-queue), drained by a worker with retries/backoff/timeouts.

     We enqueue a single `summarize_interview` job; its handler grades the
     answers, writes the summary + AEDT log, then CHAINS the insights + match
     jobs (so they never run before the summary exists). The dedupe key makes a
     retried /end a no-op rather than a duplicate enqueue.

     Idempotent fast-path: if a summary already exists (e.g. a repeat /end after
     the worker finished), return it directly. Otherwise return immediately with
     a `processing` status — the recruiter-facing summary is fetched later via
     GET /interviews/:id/summary, which already polls. */
    const [existingSummary] = await db
      .select()
      .from(interviewSummariesTable)
      .where(eq(interviewSummariesTable.interviewSessionId, session.id))
      .orderBy(desc(interviewSummariesTable.createdAt))
      .limit(1);
    if (existingSummary) {
      res.json({ ...existingSummary, createdAt: existingSummary.createdAt.toISOString() });
      return;
    }

    /* enqueueAiJob is best-effort and returns null (never throws) on DB failure.
     A null here means the summary job was NOT persisted, so reporting
     `processing` would be a lie — surface a real 500 so the client can retry. */
    const queued = await enqueueAiJob({
      type: "summarize_interview",
      payload: { sessionId: session.id },
      tenantId: session.tenantId,
      interviewSessionId: session.id,
      dedupeKey: `summarize:${session.id}`,
      priority: 10,
    }).catch((err: any) => {
      logger.error(
        { sessionId: session.id, err: err?.message },
        "[ai-queue] failed to enqueue summarize_interview",
      );
      return null;
    });
    if (!queued) {
      res.status(500).json({ error: "Failed to queue interview evaluation" });
      return;
    }

    res.json({ status: "processing", sessionId: session.id });
  },
);

router.get("/interviews/:interviewId/summary", async (req: any, res) => {
  /* Staff-only — recruiter-facing AI assessment of the candidate. Gated by
     resolving the underlying session's tenant; cross-tenant returns 404. */
  res.setHeader("Cache-Control", "no-store");
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  /* Staff-only read. `users.tenantId` is NOT NULL for every account — including
     candidate-role users — so getAllowedTenantIds alone would let a tenant-scoped
     candidate read the recruiter AI assessment + recruiterComments. Gate on an
     explicit staff allowlist first (mirrors the recruiter-comments PATCH). */
  if (!INTERVIEW_STAFF_ROLES.includes(caller.role)) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  const [session] = await db
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, req.params.interviewId))
    .limit(1);
  if (!session) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  if (!(await staffCanReadInterviewSession(caller, session))) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  const [summary] = await db
    .select()
    .from(interviewSummariesTable)
    .where(eq(interviewSummariesTable.interviewSessionId, req.params.interviewId))
    .orderBy(desc(interviewSummariesTable.createdAt))
    .limit(1);
  if (!summary) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  res.json({ ...summary, createdAt: summary.createdAt.toISOString() });
});

router.patch(
  "/interviews/:interviewId/recruiter-comments",
  validate({ body: RecruiterCommentsBody }),
  async (req: any, res) => {
    /* Staff-only — recruiter annotates the AI assessment for the client-facing
     report. Tenant-scoped exactly like the summary GET: resolve the session's
     tenant and reject cross-tenant callers with 404. */
    const userId = getAuthUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [caller] = await controlDb
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    /* Staff-only write. `users.tenantId` is NOT NULL for every account — including
     candidate-role users — so getAllowedTenantIds alone would let a tenant-scoped
     candidate edit recruiter comments. Gate on an explicit staff allowlist first. */
    if (!INTERVIEW_STAFF_ROLES.includes(caller.role)) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    const [session] = await db
      .select()
      .from(interviewSessionsTable)
      .where(eq(interviewSessionsTable.id, req.params.interviewId))
      .limit(1);
    if (!session) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    if (!(await staffCanReadInterviewSession(caller, session))) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    const comments = (req.body.comments ?? "").trim();
    const [updated] = await db
      .update(interviewSummariesTable)
      .set({ recruiterComments: comments.length ? comments : null })
      .where(eq(interviewSummariesTable.interviewSessionId, req.params.interviewId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
  },
);

router.get("/coordinator/schedules", async (req: any, res) => {
  /* Staff-only — schedule data is tenant-scoped recruiter information. */
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let allowedTenants: string[] | null = null;
  if (caller.role !== "platform_admin") {
    allowedTenants = await getAllowedTenantIds(caller as any);
    if (!allowedTenants || allowedTenants.length === 0) {
      res.json([]);
      return;
    }
  }

  const { applicationId: filterAppId } = req.query;

  const rows = await db
    .select({
      schedule: interviewSchedulesTable,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
      candidateEmail: candidatesTable.email,
      jobTitle: jobsTable.title,
    })
    .from(interviewSchedulesTable)
    .leftJoin(applicationsTable, eq(interviewSchedulesTable.applicationId, applicationsTable.id))
    .leftJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
    .leftJoin(jobsTable, eq(applicationsTable.jobId, jobsTable.id))
    .orderBy(desc(interviewSchedulesTable.scheduledAt));

  const schedules = rows
    .filter((r) => !filterAppId || r.schedule.applicationId === filterAppId)
    .filter((r) => !allowedTenants || allowedTenants.includes(r.schedule.tenantId ?? ""))
    .map((r) => {
      const first = r.firstName ?? "";
      const last = r.lastName ?? "";
      const candidateName = [first, last].filter(Boolean).join(" ") || "Unknown Candidate";
      return {
        ...r.schedule,
        scheduledAt: r.schedule.scheduledAt.toISOString(),
        createdAt: r.schedule.createdAt.toISOString(),
        candidateName,
        candidateEmail: r.candidateEmail ?? null,
        jobTitle: r.jobTitle ?? "Open Role",
      };
    });

  res.json(schedules);
});

router.post(
  "/coordinator/schedules",
  validate({ body: CreateScheduleBody }),
  async (req: any, res) => {
    const {
      applicationId,
      interviewerId,
      interviewerName,
      location,
      scheduledAt,
      durationMinutes,
      type,
      notes,
    } = req.body;
    /* Staff-only — and tenant is derived from the application's tenant rather
     than the previous hard-coded "acme" insert that corrupted multi-tenant
     reporting and bypassed authz. */
    const userId = getAuthUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [caller] = await controlDb
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [appRow] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applicationId))
      .limit(1);
    if (!appRow) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    if (caller.role !== "platform_admin") {
      const allowed = await getAllowedTenantIds(caller as any);
      if (!allowed || !allowed.includes(appRow.tenantId ?? "")) {
        res.status(404).json({ error: "Application not found" });
        return;
      }
    }
    const [sched] = await db
      .insert(interviewSchedulesTable)
      .values({
        tenantId: appRow.tenantId as string,
        applicationId,
        interviewerId: interviewerId ?? null,
        interviewerName: interviewerName ?? null,
        location: location ?? null,
        scheduledAt: new Date(scheduledAt),
        durationMinutes: durationMinutes ?? 60,
        type,
        notes: notes ?? null,
        status: "pending",
      })
      .returning();
    res.status(201).json({
      ...sched,
      scheduledAt: sched.scheduledAt.toISOString(),
      createdAt: sched.createdAt.toISOString(),
    });
  },
);

router.put(
  "/coordinator/schedules/:scheduleId",
  validate({ body: UpdateScheduleBody }),
  async (req: any, res) => {
    /* Staff-only — schedule mutations affect interviewer calendars and must
     be tenant-scoped. */
    const userId = getAuthUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [caller] = await controlDb
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [existing] = await db
      .select()
      .from(interviewSchedulesTable)
      .where(eq(interviewSchedulesTable.id, req.params.scheduleId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (caller.role !== "platform_admin") {
      const allowed = await getAllowedTenantIds(caller as any);
      if (!allowed || !allowed.includes(existing.tenantId ?? "")) {
        res.status(404).json({ error: "Not found" });
        return;
      }
    }
    const update: any = { ...req.body };
    if (update.scheduledAt) update.scheduledAt = new Date(update.scheduledAt);
    /* Don't allow tenantId reassignment via PUT body. */
    delete update.tenantId;
    const [sched] = await db
      .update(interviewSchedulesTable)
      .set(update)
      .where(eq(interviewSchedulesTable.id, req.params.scheduleId))
      .returning();
    if (!sched) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      ...sched,
      scheduledAt: sched.scheduledAt.toISOString(),
      createdAt: sched.createdAt.toISOString(),
    });
  },
);

/* ── POST /interviews/:id/feedback ── interviewer submits feedback ────────── */
router.post(
  "/interviews/:scheduleId/feedback",
  validate({ body: FeedbackBody }),
  resolveUser,
  async (req, res) => {
    try {
      const { rating, notes } = req.body as { rating?: number; notes?: string };
      if (!rating || rating < 1 || rating > 5) {
        res.status(400).json({ error: "rating must be 1–5" });
        return;
      }
      const [sched] = await db
        .update(interviewSchedulesTable)
        .set({ feedbackRating: rating, feedbackNotes: notes ?? null })
        .where(eq(interviewSchedulesTable.id, req.params.scheduleId))
        .returning();
      if (!sched) {
        res.status(404).json({ error: "Interview not found" });
        return;
      }
      res.json({
        id: sched.id,
        feedbackRating: sched.feedbackRating,
        feedbackNotes: sched.feedbackNotes,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  },
);

export default router;
