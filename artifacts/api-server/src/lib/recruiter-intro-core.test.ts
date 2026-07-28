/**
 * recruiter-intro-core.test.ts — Phase 1 recruiter intro video unit tests
 *
 * DB-free: covers the HeyGen client (with a fake fetch), pure decision/cache
 * helpers, the end-to-end render utility (success / failure / timeout), script
 * generation (LLM + template fallback), and voice resolution.
 *
 * Run: pnpm --filter @workspace/api-server run test:heygen
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeyGenClient, type HeyGenClient } from "./heygen";
import {
  buildIntroScriptTemplate,
  hashScriptContext,
  computeVideoCacheKey,
  decideIntroMode,
  storageServingUrl,
  renderIntroVideo,
  type IntroScriptContext,
} from "./recruiter-intro-core";
import { generateIntroScript } from "./recruiter-intro-script";
import { resolveVoiceId, __resetVoiceCache } from "./heygen-voices";

const CTX: IntroScriptContext = {
  recruiterName: "Dana Lopez",
  recruiterTitle: "Talent Partner",
  companyName: "Acme",
  roleTitle: "Backend Engineer",
  language: "es-ES",
  tone: "warm_professional",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/* ── HeyGen client ─────────────────────────────────────────────────────────── */

test("HeyGen generateVideo success returns video_id", async () => {
  const client = createHeyGenClient({
    apiKey: "k",
    fetchImpl: async () => jsonResponse({ data: { video_id: "vid_123" } }),
  });
  const id = await client.generateVideo({ talkingPhotoId: "tp_1", voiceId: "v1", scriptText: "hi" });
  assert.equal(id, "vid_123");
});

test("HeyGen generateVideo non-2xx throws", async () => {
  const client = createHeyGenClient({
    apiKey: "k",
    fetchImpl: async () => jsonResponse({ error: "quota" }, 429),
  });
  await assert.rejects(() => client.generateVideo({ talkingPhotoId: "tp", scriptText: "x" }), /generate failed: 429/);
});

test("HeyGen generateVideo missing video_id throws", async () => {
  const client = createHeyGenClient({
    apiKey: "k",
    fetchImpl: async () => jsonResponse({ data: {} }),
  });
  await assert.rejects(() => client.generateVideo({ talkingPhotoId: "tp", scriptText: "x" }), /no video_id/);
});

test("HeyGen uploadTalkingPhoto returns id", async () => {
  const client = createHeyGenClient({
    apiKey: "k",
    fetchImpl: async () => jsonResponse({ data: { talking_photo_id: "tp_9" } }),
  });
  const id = await client.uploadTalkingPhoto(Buffer.from("img"), "image/png");
  assert.equal(id, "tp_9");
});

test("HeyGen getVideoStatus maps completed + url", async () => {
  const client = createHeyGenClient({
    apiKey: "k",
    fetchImpl: async () => jsonResponse({ data: { status: "completed", video_url: "https://h/v.mp4" } }),
  });
  const st = await client.getVideoStatus("vid");
  assert.equal(st.status, "completed");
  assert.equal(st.videoUrl, "https://h/v.mp4");
});

/* ── Pure helpers ──────────────────────────────────────────────────────────── */

test("buildIntroScriptTemplate hands off to Lexy and names recruiter", () => {
  const s = buildIntroScriptTemplate(CTX);
  assert.match(s, /Dana Lopez/);
  assert.match(s, /Lexy/);
});

test("hashScriptContext is deterministic and language-sensitive", () => {
  const a = hashScriptContext(CTX, "p1", "j1");
  const b = hashScriptContext(CTX, "p1", "j1");
  const c = hashScriptContext({ ...CTX, language: "en-US" }, "p1", "j1");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("computeVideoCacheKey differs by voice and language", () => {
  const base = { profileId: "p", talkingPhotoId: "tp", voiceId: "v1", language: "es-ES", scriptHash: "h" };
  assert.notEqual(computeVideoCacheKey(base), computeVideoCacheKey({ ...base, voiceId: "v2" }));
  assert.notEqual(computeVideoCacheKey(base), computeVideoCacheKey({ ...base, language: "en-US" }));
  assert.equal(computeVideoCacheKey(base), computeVideoCacheKey({ ...base }));
});

test("storageServingUrl builds /api/storage path and passes through http", () => {
  assert.equal(storageServingUrl("/objects/recruiter-intros/abc"), "/api/storage/objects/recruiter-intros/abc");
  assert.equal(storageServingUrl("https://x/y.mp4"), "https://x/y.mp4");
});

/* ── decideIntroMode (fallback never blocks) ───────────────────────────────── */

test("decideIntroMode: heygen disabled → fallback", () => {
  const d = decideIntroMode({
    heygenEnabled: false,
    profile: { status: "ready", consentConfirmed: true, avatarImageObjectPath: "/objects/p.jpg" },
    completedVideoObjectPath: "/objects/v.mp4",
  });
  assert.equal(d.mode, "fallback");
  assert.equal(d.next_action, "start_lexy_interview");
});

test("decideIntroMode: no profile → fallback with no image", () => {
  const d = decideIntroMode({ heygenEnabled: true, profile: null, completedVideoObjectPath: null });
  assert.equal(d.mode, "fallback");
  assert.equal(d.fallback_image_url, null);
});

test("decideIntroMode: ready + consent + completed → video", () => {
  const d = decideIntroMode({
    heygenEnabled: true,
    profile: { status: "ready", consentConfirmed: true, avatarImageObjectPath: "/objects/p.jpg" },
    completedVideoObjectPath: "/objects/v.mp4",
  });
  assert.equal(d.mode, "video");
  assert.equal(d.video_url, "/api/storage/objects/v.mp4");
  assert.equal(d.fallback_image_url, "/api/storage/objects/p.jpg");
});

test("decideIntroMode: profile but no completed video → fallback (missing avatar render)", () => {
  const d = decideIntroMode({
    heygenEnabled: true,
    profile: { status: "ready", consentConfirmed: true, avatarImageObjectPath: "/objects/p.jpg" },
    completedVideoObjectPath: null,
  });
  assert.equal(d.mode, "fallback");
  assert.equal(d.fallback_image_url, "/api/storage/objects/p.jpg");
});

test("decideIntroMode: not ready → fallback", () => {
  const d = decideIntroMode({
    heygenEnabled: true,
    profile: { status: "draft", consentConfirmed: true, avatarImageObjectPath: "/objects/p.jpg" },
    completedVideoObjectPath: "/objects/v.mp4",
  });
  assert.equal(d.mode, "fallback");
});

/* ── renderIntroVideo (end-to-end utility) ─────────────────────────────────── */

function fakeClient(over: Partial<HeyGenClient> = {}): HeyGenClient {
  return {
    isEnabled: () => true,
    uploadTalkingPhoto: async () => "tp",
    generateVideo: async () => "vid",
    getVideoStatus: async () => ({ status: "completed", videoUrl: "https://h/v.mp4" }),
    listVoices: async () => [],
    ...over,
  };
}

test("renderIntroVideo: success downloads and stores", async () => {
  let polls = 0;
  const client = fakeClient({
    getVideoStatus: async () => {
      polls++;
      return polls < 2 ? { status: "processing" } : { status: "completed", videoUrl: "https://h/v.mp4" };
    },
  });
  let stored: { ct: string } | null = null;
  const res = await renderIntroVideo(
    client,
    { talkingPhotoId: "tp", voiceId: "v", scriptText: "hi" },
    {
      downloadToBuffer: async () => Buffer.from("mp4bytes"),
      storeBuffer: async (_b, ct) => { stored = { ct }; return "/objects/recruiter-intros/x"; },
      sleep: async () => {},
      pollMs: 1,
      maxPolls: 5,
    },
  );
  assert.equal(res.objectPath, "/objects/recruiter-intros/x");
  assert.equal(stored!.ct, "video/mp4");
});

test("renderIntroVideo: HeyGen failure throws", async () => {
  const client = fakeClient({ getVideoStatus: async () => ({ status: "failed", error: "bad photo" }) });
  await assert.rejects(
    () =>
      renderIntroVideo(client, { talkingPhotoId: "tp", scriptText: "hi" }, {
        downloadToBuffer: async () => Buffer.from(""),
        storeBuffer: async () => "/objects/x",
        sleep: async () => {},
        pollMs: 1,
        maxPolls: 5,
      }),
    /render failed: bad photo/,
  );
});

test("renderIntroVideo: timeout throws", async () => {
  const client = fakeClient({ getVideoStatus: async () => ({ status: "processing" }) });
  await assert.rejects(
    () =>
      renderIntroVideo(client, { talkingPhotoId: "tp", scriptText: "hi" }, {
        downloadToBuffer: async () => Buffer.from(""),
        storeBuffer: async () => "/objects/x",
        sleep: async () => {},
        pollMs: 1,
        maxPolls: 3,
      }),
    /timed out/,
  );
});

/* ── Script generation ─────────────────────────────────────────────────────── */

test("generateIntroScript uses LLM output when available", async () => {
  const out = await generateIntroScript(CTX, "p1", "j1", {
    generate: async () => "Hola, soy Dana. Lexy continuará.",
  });
  assert.match(out.scriptText, /Hola/);
  assert.equal(out.language, "es-ES");
  assert.equal(out.scriptHash, hashScriptContext(CTX, "p1", "j1"));
});

test("generateIntroScript falls back to template when LLM throws", async () => {
  const out = await generateIntroScript(CTX, "p1", "j1", {
    generate: async () => { throw new Error("no key"); },
  });
  assert.match(out.scriptText, /Lexy/);
  assert.match(out.scriptText, /Dana Lopez/);
});

/* ── Voice resolution ──────────────────────────────────────────────────────── */

test("resolveVoiceId returns the override verbatim", async () => {
  __resetVoiceCache();
  const id = await resolveVoiceId(fakeClient(), { language: "es-ES", override: "voice_override" });
  assert.equal(id, "voice_override");
});

test("resolveVoiceId matches language + gender from live voices", async () => {
  __resetVoiceCache();
  const client = fakeClient({
    listVoices: async () => [
      { voiceId: "en_f", language: "English", gender: "Female" },
      { voiceId: "es_m", language: "Spanish", gender: "Male" },
      { voiceId: "es_f", language: "Spanish", gender: "Female" },
    ],
  });
  const id = await resolveVoiceId(client, { language: "es-ES", gender: "female" });
  assert.equal(id, "es_f");
});

test("resolveVoiceId returns null when listVoices fails", async () => {
  __resetVoiceCache();
  const client = fakeClient({ listVoices: async () => { throw new Error("down"); } });
  const id = await resolveVoiceId(client, { language: "fr-FR", gender: "female" });
  assert.equal(id, null);
});
