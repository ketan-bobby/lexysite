/**
 * lib/recruiter-intro-core.ts — Pure helpers for the recruiter intro video
 *
 * Everything here is dependency-light (crypto + HeyGen types only) and free of
 * DB / network access, so it is fully unit-testable. The DB orchestration in
 * recruiter-intro-video.ts composes these.
 */
import crypto from "crypto";
import type { HeyGenClient, HeyGenGenerateInput } from "./heygen";

export const INTRO_SCRIPT_TEMPLATE_VERSION = "v2";

export interface IntroScriptContext {
  recruiterName: string;
  recruiterTitle?: string | null;
  companyName: string;
  roleTitle?: string | null;
  /** Target BCP-47 language the script must be written in. */
  language: string;
  tone?: string;
}

export interface GeneratedIntroScript {
  scriptText: string;
  scriptHash: string;
  language: string;
  sourceLanguage: string;
}

/**
 * Deterministic English base template — the safety net when the LLM is
 * unavailable. ~20-30s when spoken. Always ends by handing off to Lexy.
 */
export function buildIntroScriptTemplate(ctx: IntroScriptContext): string {
  const who = ctx.recruiterTitle
    ? `${ctx.recruiterName}, ${ctx.recruiterTitle} at ${ctx.companyName}`
    : `${ctx.recruiterName} from ${ctx.companyName}`;
  const role = ctx.roleTitle ? ` for the ${ctx.roleTitle} role` : "";
  return [
    `Hi, I'm ${who}.`,
    `Thank you so much for connecting with me and for taking the time to speak with us today${role}.`,
    `This is a relaxed conversation to help us get to know you — there are no trick questions, so take your time and just be yourself.`,
    `My colleague Lexy will take it from here, and I really appreciate you spending this time talking with her. Whenever you're ready, she'll begin.`,
  ].join(" ");
}

/**
 * Cache identity for a script: a matching hash reuses the existing script row.
 * Includes the template version so a wording change invalidates old caches.
 */
export function hashScriptContext(ctx: IntroScriptContext, profileId: string, jobId: string | null): string {
  const canonical = JSON.stringify({
    v: INTRO_SCRIPT_TEMPLATE_VERSION,
    profileId,
    jobId: jobId ?? null,
    recruiterName: ctx.recruiterName,
    recruiterTitle: ctx.recruiterTitle ?? null,
    companyName: ctx.companyName,
    roleTitle: ctx.roleTitle ?? null,
    language: ctx.language,
    tone: ctx.tone ?? "warm_professional",
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Dedupe identity for a rendered video. Same inputs → reuse the same MP4. */
export function computeVideoCacheKey(p: {
  profileId: string;
  talkingPhotoId: string;
  voiceId: string | null;
  language: string;
  scriptHash: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        profileId: p.profileId,
        talkingPhotoId: p.talkingPhotoId,
        voiceId: p.voiceId ?? null,
        language: p.language,
        scriptHash: p.scriptHash,
      }),
    )
    .digest("hex");
}

/** Build the relative URL the frontend uses to stream a stored object. */
export function storageServingUrl(objectPath: string): string {
  if (!objectPath) return objectPath;
  if (/^https?:\/\//.test(objectPath)) return objectPath;
  return `/api/storage${objectPath.startsWith("/") ? "" : "/"}${objectPath}`;
}

export interface IntroModeDecisionInput {
  heygenEnabled: boolean;
  profile: { status: string; consentConfirmed: boolean; avatarImageObjectPath: string | null } | null;
  completedVideoObjectPath: string | null;
  canSkip?: boolean;
}

export interface IntroModeDecision {
  mode: "video" | "fallback";
  video_url: string | null;
  fallback_image_url: string | null;
  can_skip: boolean;
  next_action: "start_lexy_interview";
}

/**
 * The candidate-experience contract decision. Pure: given what we know, decide
 * whether to play the recruiter video or fall straight through to Lexy. The
 * fallback path NEVER blocks the interview — next_action is always to start Lexy.
 */
export function decideIntroMode(input: IntroModeDecisionInput): IntroModeDecision {
  const can_skip = input.canSkip ?? true;
  const next_action = "start_lexy_interview" as const;
  const fallback_image_url = input.profile?.avatarImageObjectPath
    ? storageServingUrl(input.profile.avatarImageObjectPath)
    : null;

  const eligible =
    input.heygenEnabled &&
    !!input.profile &&
    input.profile.status === "ready" &&
    input.profile.consentConfirmed &&
    !!input.completedVideoObjectPath;

  if (eligible) {
    return {
      mode: "video",
      video_url: storageServingUrl(input.completedVideoObjectPath!),
      fallback_image_url,
      can_skip,
      next_action,
    };
  }
  return { mode: "fallback", video_url: null, fallback_image_url, can_skip, next_action };
}

export interface RenderDeps {
  downloadToBuffer: (url: string) => Promise<Buffer>;
  storeBuffer: (buf: Buffer, contentType: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

export interface RenderResult {
  videoId: string;
  objectPath: string;
  externalUrl: string;
}

/**
 * Full happy-path render: submit → poll → download → persist. Used as the
 * conceptual end-to-end utility (and exercised directly by tests). The route
 * flow splits this into create + poll so it never blocks on a multi-minute
 * render, but both share computeVideoCacheKey for dedupe.
 */
export async function renderIntroVideo(
  client: HeyGenClient,
  input: HeyGenGenerateInput,
  deps: RenderDeps,
): Promise<RenderResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 5000;
  const maxPolls = deps.maxPolls ?? 60;

  const videoId = await client.generateVideo(input);
  for (let i = 0; i < maxPolls; i++) {
    const st = await client.getVideoStatus(videoId);
    if (st.status === "completed" && st.videoUrl) {
      const buf = await deps.downloadToBuffer(st.videoUrl);
      const objectPath = await deps.storeBuffer(buf, "video/mp4");
      return { videoId, objectPath, externalUrl: st.videoUrl };
    }
    if (st.status === "failed") {
      throw new Error(`HeyGen render failed: ${st.error ?? "unknown"}`);
    }
    await sleep(pollMs);
  }
  throw new Error("HeyGen render timed out");
}
