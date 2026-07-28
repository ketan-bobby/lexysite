/**
 * lib/recruiter-intro-video.ts — Recruiter intro video orchestration (Phase 1)
 *
 * Ties together: recruiter avatar profile → HeyGen talking-photo → auto-generated
 * (language-native) intro script → HeyGen render → our object storage, with a
 * hard Lexy fallback that NEVER blocks the interview.
 *
 * All DB access uses dbAdmin with EXPLICIT tenant filters (these tables carry no
 * RLS policy yet), mirroring routes/ai-jobs.ts. Cross-tenant access is gated by
 * the caller's getAllowedTenantIds subtree in the route layer before calling in.
 *
 * HeyGen output urls expire, so a completed render is downloaded and persisted to
 * object storage; the stored MP4 is the source of truth thereafter.
 */
import {
  dbAdmin,
  recruiterAvatarProfilesTable,
  recruiterAvatarVideoJobsTable,
  recruiterIntroScriptsTable,
} from "@workspace/db";
import { and, eq, ne, or, desc, inArray } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { createHeyGenClient, heygenEnabled, type HeyGenClient } from "./heygen";
import { resolveVoiceId } from "./heygen-voices";
import { generateIntroScript } from "./recruiter-intro-script";
import {
  computeVideoCacheKey,
  decideIntroMode,
  hashScriptContext,
  type IntroModeDecision,
  type IntroScriptContext,
} from "./recruiter-intro-core";
import { logCandidateEvent } from "./candidate-event-logger";
import { logger } from "./logger";

export interface IntroVideoDeps {
  client?: HeyGenClient;
  storage?: ObjectStorageService;
}

type ProfileRow = typeof recruiterAvatarProfilesTable.$inferSelect;
type VideoJobRow = typeof recruiterAvatarVideoJobsTable.$inferSelect;

async function loadProfile(recruiterUserId: string): Promise<ProfileRow | null> {
  const [row] = await dbAdmin
    .select()
    .from(recruiterAvatarProfilesTable)
    .where(eq(recruiterAvatarProfilesTable.recruiterUserId, recruiterUserId))
    .limit(1);
  return row ?? null;
}

/** Ensure the profile has a HeyGen talking_photo id, lazily uploading the stored
 *  recruiter photo to HeyGen on first use. Returns null if no photo is on file. */
async function ensureTalkingPhoto(
  profile: ProfileRow,
  client: HeyGenClient,
  storage: ObjectStorageService,
): Promise<string | null> {
  if (profile.heygenTalkingPhotoId) return profile.heygenTalkingPhotoId;
  if (!profile.avatarImageObjectPath) return null;

  let buf: Buffer;
  let contentType = "image/jpeg";
  try {
    const ref = await storage.getObjectEntityFile(profile.avatarImageObjectPath);
    contentType = ref.contentType ?? contentType;
    const resp = await storage.downloadObject(ref);
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    logger.warn({ err, profileId: profile.id }, "[recruiter-intro] failed to read avatar image from storage");
    return null;
  }

  const id = await client.uploadTalkingPhoto(buf, contentType);
  await dbAdmin
    .update(recruiterAvatarProfilesTable)
    .set({ heygenTalkingPhotoId: id, updatedAt: new Date() })
    .where(eq(recruiterAvatarProfilesTable.id, profile.id));
  return id;
}

/** Reuse a cached script for the render context, else generate + persist one. */
async function ensureScript(
  profile: ProfileRow,
  ctx: IntroScriptContext,
  jobId: string | null,
): Promise<{ scriptText: string; scriptHash: string }> {
  const scriptHash = hashScriptContext(ctx, profile.id, jobId);
  const [cached] = await dbAdmin
    .select()
    .from(recruiterIntroScriptsTable)
    .where(eq(recruiterIntroScriptsTable.scriptHash, scriptHash))
    .limit(1);
  if (cached) return { scriptText: cached.scriptText, scriptHash };

  const gen = await generateIntroScript(ctx, profile.id, jobId);
  try {
    await dbAdmin.insert(recruiterIntroScriptsTable).values({
      recruiterAvatarProfileId: profile.id,
      tenantId: profile.tenantId,
      jobId,
      sourceLanguage: gen.sourceLanguage,
      language: gen.language,
      tone: ctx.tone ?? "warm_professional",
      scriptText: gen.scriptText,
      scriptHash,
    });
  } catch (err: any) {
    if (err?.code !== "23505") {
      logger.warn({ err }, "[recruiter-intro] script cache insert failed (non-fatal)");
    }
  }
  return { scriptText: gen.scriptText, scriptHash };
}

export interface EnsureVideoArgs {
  recruiterUserId: string;
  candidateId?: string | null;
  interviewId?: string | null;
  jobId?: string | null;
  language: string;
  voiceId?: string | null;
  /** Live voice-gender selection from the request. Preferred over the saved
   *  profile so a changed voice actually alters the dedupe cacheKey (mirrors how
   *  language/tone flow from the request). */
  voiceGender?: string | null;
  ctx: IntroScriptContext;
}

export type EnsureVideoResult =
  | { ok: true; job: VideoJobRow }
  | { ok: false; reason: "disabled" | "no_profile" | "no_avatar" | "generation_failed" };

/**
 * Ensure a (cached or freshly submitted) HeyGen render exists for the inputs.
 * Idempotent via the cacheKey unique index — concurrent callers converge on one
 * row and a completed render is reused forever. Never throws to the caller for an
 * expected failure; returns { ok: false } so the interview can fall back to Lexy.
 */
export async function ensureIntroVideoJob(args: EnsureVideoArgs, deps: IntroVideoDeps = {}): Promise<EnsureVideoResult> {
  // Hard guarantee: this NEVER throws. Any unexpected failure degrades to a Lexy
  // fallback ({ ok: false }) so the interview is never blocked.
  try {
    return await ensureIntroVideoJobInner(args, deps);
  } catch (err) {
    logger.warn({ err, recruiterUserId: args.recruiterUserId }, "[recruiter-intro] ensureIntroVideoJob failed (non-fatal)");
    return { ok: false, reason: "generation_failed" };
  }
}

async function ensureIntroVideoJobInner(args: EnsureVideoArgs, deps: IntroVideoDeps): Promise<EnsureVideoResult> {
  if (!heygenEnabled()) return { ok: false, reason: "disabled" };

  const profile = await loadProfile(args.recruiterUserId);
  if (!profile || profile.status !== "ready" || !profile.consentConfirmed) {
    return { ok: false, reason: "no_profile" };
  }

  const client = deps.client ?? createHeyGenClient();
  const storage = deps.storage ?? new ObjectStorageService();

  const talkingPhotoId = await ensureTalkingPhoto(profile, client, storage);
  if (!talkingPhotoId) return { ok: false, reason: "no_avatar" };

  // Resolve the voice, preferring the live request gender over the saved profile
  // so a recruiter who switches voice and regenerates gets a different voiceId
  // (→ new cacheKey → a fresh render) instead of the deduped old video. An
  // explicit voiceId (or a persisted selectedVoiceId) still takes precedence.
  const voiceId =
    args.voiceId ??
    profile.selectedVoiceId ??
    (await resolveVoiceId(client, {
      language: args.language,
      gender: args.voiceGender ?? profile.voiceGender,
      override: null,
    }));

  const { scriptText, scriptHash } = await ensureScript(profile, args.ctx, args.jobId ?? null);
  const cacheKey = computeVideoCacheKey({
    profileId: profile.id,
    talkingPhotoId,
    voiceId,
    language: args.language,
    scriptHash,
  });

  const findLive = async (): Promise<VideoJobRow | null> => {
    const [row] = await dbAdmin
      .select()
      .from(recruiterAvatarVideoJobsTable)
      .where(and(eq(recruiterAvatarVideoJobsTable.cacheKey, cacheKey), ne(recruiterAvatarVideoJobsTable.status, "failed")))
      .orderBy(desc(recruiterAvatarVideoJobsTable.createdAt))
      .limit(1);
    return row ?? null;
  };

  const existing = await findLive();
  if (existing) return { ok: true, job: existing };

  let job: VideoJobRow;
  try {
    [job] = await dbAdmin
      .insert(recruiterAvatarVideoJobsTable)
      .values({
        recruiterAvatarProfileId: profile.id,
        tenantId: profile.tenantId,
        candidateId: args.candidateId ?? null,
        interviewId: args.interviewId ?? null,
        jobId: args.jobId ?? null,
        language: args.language,
        scriptText,
        scriptHash,
        voiceId,
        heygenTalkingPhotoId: talkingPhotoId,
        status: "pending",
        cacheKey,
      })
      .returning();
  } catch (err: any) {
    if (err?.code === "23505") {
      const raced = await findLive();
      if (raced) return { ok: true, job: raced };
    }
    throw err;
  }

  try {
    const videoId = await client.generateVideo({ talkingPhotoId, voiceId, scriptText });
    [job] = await dbAdmin
      .update(recruiterAvatarVideoJobsTable)
      .set({ heygenVideoId: videoId, status: "processing", updatedAt: new Date() })
      .where(eq(recruiterAvatarVideoJobsTable.id, job.id))
      .returning();
  } catch (err: any) {
    await dbAdmin
      .update(recruiterAvatarVideoJobsTable)
      .set({ status: "failed", errorMessage: String(err?.message ?? err).slice(0, 1000), updatedAt: new Date() })
      .where(eq(recruiterAvatarVideoJobsTable.id, job.id));
    if (args.candidateId && args.jobId) {
      await logCandidateEvent({
        candidateId: args.candidateId,
        jobId: args.jobId,
        tenantId: profile.tenantId,
        eventType: "INTRO_VIDEO_GENERATION_FAILED",
        actorType: "system",
        source: "interview_agent",
        metadata: { error: String(err?.message ?? err) },
      });
    }
    return { ok: false, reason: "generation_failed" };
  }

  return { ok: true, job };
}

/**
 * Advance a processing job: ask HeyGen for status, and on completion download the
 * MP4 and persist it to object storage. Best-effort — a transient poll error
 * leaves the job processing so a later poll can finish it.
 */
export async function pollIntroVideoJob(jobId: string, deps: IntroVideoDeps = {}): Promise<VideoJobRow | null> {
  const [job] = await dbAdmin
    .select()
    .from(recruiterAvatarVideoJobsTable)
    .where(eq(recruiterAvatarVideoJobsTable.id, jobId))
    .limit(1);
  if (!job) return null;
  if (job.status === "completed" || job.status === "failed") return job;
  if (!job.heygenVideoId) return job;

  const client = deps.client ?? createHeyGenClient();
  const storage = deps.storage ?? new ObjectStorageService();

  try {
    const st = await client.getVideoStatus(job.heygenVideoId);
    if (st.status === "completed" && st.videoUrl) {
      const resp = await fetch(st.videoUrl);
      if (!resp.ok) {
        // Upstream URL not actually downloadable — leave the job processing so a
        // later poll can retry rather than storing a broken artifact.
        logger.warn({ jobId: job.id, status: resp.status }, "[recruiter-intro] HeyGen video download not ok; will retry");
        return job;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) {
        logger.warn({ jobId: job.id }, "[recruiter-intro] HeyGen video download empty; will retry");
        return job;
      }
      const objectPath = await storage.uploadBuffer(buf, "video/mp4", "recruiter-intros");
      const [updated] = await dbAdmin
        .update(recruiterAvatarVideoJobsTable)
        .set({
          status: "completed",
          outputVideoObjectPath: objectPath,
          outputVideoUrlExternal: st.videoUrl,
          updatedAt: new Date(),
        })
        .where(eq(recruiterAvatarVideoJobsTable.id, job.id))
        .returning();
      if (job.candidateId && job.jobId) {
        await logCandidateEvent({
          candidateId: job.candidateId,
          jobId: job.jobId,
          tenantId: job.tenantId,
          eventType: "INTRO_VIDEO_GENERATED",
          actorType: "system",
          source: "interview_agent",
          metadata: { videoJobId: job.id },
        });
      }
      return updated;
    }
    if (st.status === "failed") {
      const [updated] = await dbAdmin
        .update(recruiterAvatarVideoJobsTable)
        .set({ status: "failed", errorMessage: st.error ?? "HeyGen render failed", updatedAt: new Date() })
        .where(eq(recruiterAvatarVideoJobsTable.id, job.id))
        .returning();
      if (job.candidateId && job.jobId) {
        await logCandidateEvent({
          candidateId: job.candidateId,
          jobId: job.jobId,
          tenantId: job.tenantId,
          eventType: "INTRO_VIDEO_GENERATION_FAILED",
          actorType: "system",
          source: "interview_agent",
          metadata: { error: st.error },
        });
      }
      return updated;
    }
  } catch (err) {
    logger.warn({ err, jobId: job.id }, "[recruiter-intro] poll failed (non-fatal)");
  }
  return job;
}

export interface CandidateIntroArgs {
  recruiterUserId: string;
  jobId: string;
  language: string;
}

export interface CandidateIntroResponse extends IntroModeDecision {
  script_text: string | null;
}

/**
 * The candidate-experience contract: returns whether to play a recruiter video
 * or fall back to Lexy. Reads only — playback/transition wiring is Phase 3.
 */
export async function getCandidateIntro(args: CandidateIntroArgs): Promise<CandidateIntroResponse> {
  const profile = await loadProfile(args.recruiterUserId);
  let completedPath: string | null = null;
  let scriptText: string | null = null;

  if (profile) {
    const [vid] = await dbAdmin
      .select()
      .from(recruiterAvatarVideoJobsTable)
      .where(
        and(
          eq(recruiterAvatarVideoJobsTable.recruiterAvatarProfileId, profile.id),
          eq(recruiterAvatarVideoJobsTable.language, args.language),
          eq(recruiterAvatarVideoJobsTable.status, "completed"),
        ),
      )
      .orderBy(desc(recruiterAvatarVideoJobsTable.updatedAt))
      .limit(1);
    if (vid) {
      completedPath = vid.outputVideoObjectPath;
      scriptText = vid.scriptText;
    }
  }

  const decision = decideIntroMode({
    heygenEnabled: heygenEnabled(),
    profile: profile
      ? {
          status: profile.status,
          consentConfirmed: profile.consentConfirmed,
          avatarImageObjectPath: profile.avatarImageObjectPath,
        }
      : null,
    completedVideoObjectPath: completedPath,
    canSkip: true,
  });

  return { ...decision, script_text: scriptText };
}

export interface ResolveCandidateIntroArgs {
  jobId: string;
  language: string;
  /** The job's tenant plus its ancestor tenants (staffing-agency parent chain). */
  tenantIds: string[];
  /** Recruiter resolved from the job (assigned, else creator), if any. */
  preferredRecruiterUserId?: string | null;
}

/**
 * Candidate-facing intro resolution that does NOT require the caller to already
 * know the recruiter (the candidate doesn't). Resolution order for "whose video
 * to play":
 *   1. the recruiter assigned to / who created the job (preferredRecruiterUserId)
 *   2. any ready, consented avatar profile in the job's tenant or an ancestor
 *      (staffing-agency parent) tenant — covers the common case where the job
 *      lives in a client child tenant but the recorded intro belongs to the
 *      parent agency recruiter.
 * Among the matching profiles it prefers a completed video in the requested
 * language, then the preferred recruiter's, then any completed video — falling
 * back to Lexy when none exists. Never throws: always returns a decision so the
 * interview is never blocked.
 */
export async function resolveCandidateIntro(args: ResolveCandidateIntroArgs): Promise<CandidateIntroResponse> {
  const fallback = (profile: ProfileRow | null): CandidateIntroResponse => ({
    ...decideIntroMode({
      heygenEnabled: heygenEnabled(),
      profile: profile
        ? { status: profile.status, consentConfirmed: profile.consentConfirmed, avatarImageObjectPath: profile.avatarImageObjectPath }
        : null,
      completedVideoObjectPath: null,
      canSkip: true,
    }),
    script_text: null,
  });

  const orConds: any[] = [];
  if (args.preferredRecruiterUserId) {
    orConds.push(eq(recruiterAvatarProfilesTable.recruiterUserId, args.preferredRecruiterUserId));
  }
  if (args.tenantIds.length) {
    orConds.push(inArray(recruiterAvatarProfilesTable.tenantId, args.tenantIds));
  }
  if (orConds.length === 0) return fallback(null);

  const profiles = await dbAdmin
    .select()
    .from(recruiterAvatarProfilesTable)
    .where(
      and(
        eq(recruiterAvatarProfilesTable.status, "ready"),
        eq(recruiterAvatarProfilesTable.consentConfirmed, true),
        orConds.length === 1 ? orConds[0] : or(...orConds),
      ),
    );
  if (profiles.length === 0) return fallback(null);

  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  const profileIds = profiles.map((p) => p.id);

  const vids = await dbAdmin
    .select()
    .from(recruiterAvatarVideoJobsTable)
    .where(
      and(
        inArray(recruiterAvatarVideoJobsTable.recruiterAvatarProfileId, profileIds),
        eq(recruiterAvatarVideoJobsTable.status, "completed"),
      ),
    )
    .orderBy(desc(recruiterAvatarVideoJobsTable.updatedAt));

  const isPreferred = (v: VideoJobRow) =>
    !!args.preferredRecruiterUserId &&
    byProfile.get(v.recruiterAvatarProfileId)?.recruiterUserId === args.preferredRecruiterUserId;

  const pick =
    vids.find((v) => v.outputVideoObjectPath && v.language === args.language && isPreferred(v)) ??
    vids.find((v) => v.outputVideoObjectPath && v.language === args.language) ??
    vids.find((v) => v.outputVideoObjectPath && isPreferred(v)) ??
    vids.find((v) => v.outputVideoObjectPath) ??
    null;

  const chosen = (pick ? byProfile.get(pick.recruiterAvatarProfileId) : null) ?? profiles[0];

  return {
    ...decideIntroMode({
      heygenEnabled: heygenEnabled(),
      profile: { status: chosen.status, consentConfirmed: chosen.consentConfirmed, avatarImageObjectPath: chosen.avatarImageObjectPath },
      completedVideoObjectPath: pick?.outputVideoObjectPath ?? null,
      canSkip: true,
    }),
    script_text: pick?.scriptText ?? null,
  };
}
