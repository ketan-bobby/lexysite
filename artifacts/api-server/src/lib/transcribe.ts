/**
 * transcribe.ts — Speech-to-Text core (format routing + provider fallback)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * The decision logic behind POST /interviews/transcribe, extracted out of the
 * Express route so it can be unit-tested without a live HTTP server, database,
 * or real Azure / OpenAI credentials.
 *
 * Mobile interview listening depends entirely on routing each phone's audio
 * format to a provider that can decode it:
 *   - Android / Chrome send audio/webm (opus)  → Azure Speech (primary)
 *   - iOS Safari sends   audio/mp4  (AAC)       → Whisper fallback (Azure can't
 *                                                 decode mp4/aac, so we skip the
 *                                                 guaranteed-fail round-trip)
 *
 * transcribeAudio() is dependency-injectable: callers (and tests) can replace
 * the Azure fetch and the Whisper client. The production route passes no deps,
 * so it uses the real implementations.
 *
 * cleanWhisperOutput() strips known Whisper hallucinations and script-mismatch
 * garbage; it lives here too since it is part of the transcription pipeline.
 */
import OpenAI from "openai";
import nodeCrypto from "node:crypto";
import { resolveLangMeta, azureSpeechConfigured } from "./ai";
import { logger } from "./logger";
import type { SttProvider } from "./stt-metrics";
import { getSttAccounts, pickAccount, noteSuccess, noteFailure } from "./azure-pool";

/* ── Whisper hallucination / script-mismatch filter ─────────────────────────
 * Strips known Whisper model hallucinations ("Thanks for watching!", CJK /
 * Indic copy-paste garbage) that appear when audio is short, silent, or in an
 * unexpected language, plus a mixed-script detector and a script-mismatch
 * check for expected-non-Latin languages. */
export function cleanWhisperOutput(text: string, expectedLang: string): string {
  if (!text) return "";

  /* Known hallucination phrases in various languages */
  const HALLUCINATIONS = [
    /thank you for watching/i, /thanks for watching/i,
    /please subscribe/i, /like and subscribe/i, /copyright/i,
    /subtitles by/i, /element animation/i,
    /^\s*you\s*$/i, /^\s*[\.\s\!\?]+\s*$/,
    /* Japanese */
    /ご視聴ありがとう/, /ありがとうございました/, /チャンネル登録/,
    /* Korean */
    /영상 봐주셔서/, /봐주셔서 감사/, /구독/,
    /* Chinese */
    /谢谢观看/, /感谢观看/, /订阅/,
    /* Ukrainian/Russian "Thank you for watching" */
    /Дякую за перегляд/i, /Спасибо за просмотр/i,
    /* Arabic */
    /شكرًا على المشاهدة/, /شكرا للمشاهدة/,
    /* Spanish/Portuguese "Subtitles by the Amara.org community" (classic silence hallucination) */
    /amara\.org/i, /subt[ií]tulos realizados/i, /legendas pela comunidade/i,
    /* Generic multilingual garbage patterns from screenshot */
    /Marakeria/i, /nih seluar/i,
  ];
  if (HALLUCINATIONS.some(re => re.test(text))) return "";

  /* Mixed-script detector: Whisper hallucinations almost always mix 3+ scripts */
  const scriptHits = [
    /[\u0600-\u06FF]/,          /* Arabic */
    /[\u3040-\u30FF]/,          /* Japanese kana */
    /[\u4E00-\u9FFF]/,          /* CJK */
    /[\uAC00-\uD7AF]/,          /* Korean hangul */
    /[\u0400-\u04FF]/,          /* Cyrillic */
    /[\u0B80-\u0BFF]/,          /* Tamil */
    /[\u0C00-\u0C7F]/,          /* Telugu */
    /[\u0980-\u09FF]/,          /* Bengali */
    /[\u0D00-\u0D7F]/,          /* Malayalam */
    /[\u0A80-\u0AFF]/,          /* Gujarati */
    /[\u0900-\u097F]/,          /* Devanagari */
  ].filter(re => re.test(text)).length;
  if (scriptHits >= 3) return ""; /* 3+ different non-Latin scripts = hallucination */

  /* Script-mismatch: expected an Indic/non-Latin language but got mostly Latin */
  const EXPECTS_NON_LATIN: Record<string, RegExp> = {
    gu: /[\u0A80-\u0AFF]/,  ta: /[\u0B80-\u0BFF]/,  te: /[\u0C00-\u0C7F]/,
    hi: /[\u0900-\u097F]/,  bn: /[\u0980-\u09FF]/,  ml: /[\u0D00-\u0D7F]/,
    kn: /[\u0C80-\u0CFF]/,  mr: /[\u0900-\u097F]/,  pa: /[\u0A00-\u0A7F]/,
    ar: /[\u0600-\u06FF]/,  ur: /[\u0600-\u06FF]/,
  };
  const base = expectedLang.split("-")[0].toLowerCase();
  const expectedScript = EXPECTS_NON_LATIN[base];
  if (expectedScript && !expectedScript.test(text)) {
    /* Expected script not found — only discard if output is mostly Latin */
    const latinRatio = (text.match(/[a-zA-Z]/g) || []).length / Math.max(1, text.replace(/\s/g, "").length);
    if (latinRatio > 0.65) return "";
  }

  /* ── Long-phrase loop collapse (script-agnostic) ───────────────────────────
   * Runs BEFORE the repetition/diversity guards below: Sarvam/Whisper produce
   * SENTENCE-length loops on noisy or repetitive audio (seen live in Gujarati:
   * one ~13-word sentence echoed 6× inside a single result). A real speaker
   * never repeats a long sentence verbatim back-to-back, so collapse
   * consecutive duplicates of any 5–15-word phrase to a single occurrence.
   * Collapsing first preserves the genuine part of the answer — otherwise the
   * low-diversity guard (c) would discard the WHOLE text, real sentence
   * included. */
  {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    if (toks.length >= 10) {
      const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      let changed = false;
      for (let n = 15; n >= 5; n--) {
        for (let i = 0; i + 2 * n <= toks.length; ) {
          const a = toks.slice(i, i + n).map(key).join(" ");
          const b = toks.slice(i + n, i + 2 * n).map(key).join(" ");
          if (a.replace(/\s/g, "") && a === b) { toks.splice(i + n, n); changed = true; }
          else i++;
        }
      }
      if (changed) {
        /* If the remnant after collapsing is still low-diversity babble, the
           whole thing was a loop with no genuine content — discard it (matches
           the pre-collapse behavior of the diversity guard). A genuine answer
           followed by a loop leaves a high-diversity remnant and is kept —
           text that BOTH contained a back-to-back long-phrase loop AND has
           <40% unique words left is something a real speaker never produces. */
        const keys = toks.map(key).filter(Boolean);
        const uniqRatio = keys.length ? new Set(keys).size / keys.length : 0;
        if (uniqRatio < 0.4) return "";
        text = toks.join(" ");
      }
    }
  }

  /* ── Repetition / low-diversity loop guard (script-agnostic) ──────────────
   * Whisper's signature hallucination on short, quiet or hesitant audio is a
   * loop: the same word or short phrase repeated over and over, or a tiny
   * vocabulary stretched across a long output. The script checks above only
   * catch NON-Latin garbage, so Latin-script languages (Portuguese, Spanish,
   * French…) sail through as fluent-but-meaningless text. This guard catches
   * those without semantic analysis. It is tuned to be very conservative — it
   * only fires on patterns a genuine spoken answer effectively never produces
   * (six identical words in a row, a phrase repeated four times back-to-back,
   * or <25% unique words over a long answer). */
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 6) {
    const norm = words.map(w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    if (norm.length >= 6) {
      /* (a) one token repeated many times consecutively */
      let maxRun = 1, run = 1;
      for (let i = 1; i < norm.length; i++) {
        if (norm[i] === norm[i - 1]) { run += 1; if (run > maxRun) maxRun = run; }
        else run = 1;
      }
      if (maxRun >= 6) return "";

      /* (b) a short n-gram repeated back-to-back several times */
      for (let n = 2; n <= 4; n++) {
        let reps = 1;
        for (let i = n; i + n <= norm.length; i += n) {
          const a = norm.slice(i - n, i).join(" ");
          const b = norm.slice(i, i + n).join(" ");
          if (a && a === b) { reps += 1; if (reps >= 4) return ""; }
          else reps = 1;
        }
      }

      /* (c) very low lexical diversity over a long output = loop/babble */
      if (norm.length >= 12) {
        const uniq = new Set(norm).size;
        if (uniq / norm.length < 0.25) return "";
      }
    }
  }

  return text;
}

/* Azure's conversation REST endpoint only accepts opus (webm/ogg) and wav.
   iOS Safari produces audio/mp4 (AAC), which Azure rejects — for those go
   straight to Whisper (which handles mp4/m4a/aac). */
export function azureAcceptsFormat(ctBase: string): boolean {
  return (
    ctBase === "audio/webm" || ctBase === "audio/ogg" ||
    ctBase === "audio/wav"  || ctBase === "audio/x-wav"
  );
}

/* Name the Whisper upload after the ACTUAL audio format so Whisper decodes it.
   iOS Safari sends audio/mp4; defaulting everything to webm made those uploads
   fail to transcribe. */
const WHISPER_EXT: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mp4": "mp4", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
  "audio/mpeg": "mp3", "audio/mp3": "mp3",
};

const WHISPER_STRONG = new Set(["en","es","fr","de","it","pt","nl","ru","zh","ja","ko","ar","tr","pl","sv","no","da","hi","tl","id","ms","th","vi","he"]);

/* Language keys whose Whisper/gpt-4o-transcribe ISO hint differs from the
   key's base code (Filipino "fil" → Whisper's "tl" / Tagalog). */
const WHISPER_LANG_ALIASES: Record<string, string> = { fil: "tl" };

/* Minimal shape of the Azure STT HTTP response we depend on — keeps the
   injectable fetch implementation free of the full DOM Response type. */
export interface SttHttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<any>;
  text(): Promise<string>;
}

export interface TranscribeDeps {
  /** Whether Azure Speech credentials are configured. */
  azureConfigured: () => boolean;
  /** Performs the Azure STT POST. Defaults to global fetch. */
  azureFetch: (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; signal?: AbortSignal }) => Promise<SttHttpResponse>;
  /** Transcribes a prepared audio File via Whisper, returning raw text. */
  whisperTranscribe: (args: { file: File; language?: string; prompt?: string }) => Promise<string>;
  /** Independent-vendor fallback via Deepgram Nova, returning raw text. */
  deepgramTranscribe: (args: { buf: Buffer; contentType: string; language?: string }) => Promise<string>;
  /** Last-resort transcription via ElevenLabs Scribe, returning raw text. */
  elevenLabsTranscribe: (args: { file: File; language?: string }) => Promise<string>;
  /** Indian-language primary transcription via Sarvam Saarika, returning raw text. */
  sarvamTranscribe: (args: { file: File; languageCode?: string }) => Promise<string>;
  /** Chinese-language primary transcription via iFlytek IAT, returning raw text. */
  iflytekTranscribe: (args: { buf: Buffer; contentType: string; language: string }) => Promise<string>;
  /** Env source (keys/region). Defaults to process.env. */
  env: NodeJS.ProcessEnv;
}

export interface TranscribeResult {
  transcript: string;
  provider: SttProvider;
}

/* Bound the Whisper round-trip so a slow/throttled OpenAI call under concurrent
   load can't hang a candidate's mic. The SDK defaults (maxRetries 2, ~10min
   timeout) turn a 429 burst into many seconds of backoff per request; cap both
   so a stuck request fails fast and the candidate keeps moving. Tunable via
   WHISPER_TIMEOUT_MS (default 20s). */
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS) || 20_000;

/* Bound the Azure STT round-trip. A normal <25s clip transcribes in ~1-2s, but
   under concurrent load Azure throttles and a hung request would otherwise hold
   the candidate's mic open until the socket times out (minutes). Abort after
   this budget and fall over to Whisper. Tunable via AZURE_STT_TIMEOUT_MS. */
const AZURE_STT_TIMEOUT_MS = Number(process.env.AZURE_STT_TIMEOUT_MS) || 7_000;

/* ── Azure circuit breaker ───────────────────────────────────────────────────
 * Under concurrent load Azure throttling is bursty: when it starts failing it
 * tends to fail for many requests at once. Without a breaker, EACH of those
 * requests pays the full AZURE_STT_TIMEOUT_MS before failing over — that's the
 * "slow for some" symptom. After AZURE_BREAKER_THRESHOLD consecutive hard
 * failures (timeout / HTTP error) the breaker opens for AZURE_BREAKER_COOLDOWN_MS
 * and traffic skips straight to Whisper; the next request after the cooldown
 * probes Azure again. A single success closes it. NoMatch/empty (Azure alive,
 * just silence) is NOT a failure and resets the breaker.
 *
 * The breaker + account selection now live in azure-pool.ts so STT and TTS
 * share them and so multiple Azure accounts can be pooled. The breaker key is
 * per-ACCOUNT and per-FORMAT (`stt:<accountId>::<ctBase>`): a degraded cohort
 * (one codec, or one throttled account) is isolated without shunting healthy
 * cohorts to Whisper. With a single account configured this is identical to the
 * previous per-format-only behavior. */

/* The AI-integrations proxy dropped support for the legacy "whisper-1" model
   (every call 400s instantly — which the pipeline used to swallow as an empty
   transcript, leaving the interviewer deaf). gpt-4o-transcribe is the current
   supported successor with equal-or-better multilingual accuracy. Tunable via
   STT_MODEL. */
export const DEFAULT_STT_MODEL = "gpt-4o-transcribe";
export function sttModelFor(env: NodeJS.ProcessEnv): string {
  return env.STT_MODEL || DEFAULT_STT_MODEL;
}

function defaultWhisperTranscribe(env: NodeJS.ProcessEnv) {
  return async ({ file, language, prompt }: { file: File; language?: string; prompt?: string }): Promise<string> => {
    const openai = new OpenAI({
      apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
      baseURL: env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      timeout: WHISPER_TIMEOUT_MS,
      maxRetries: 1,
    });
    const createParams: any = { model: sttModelFor(env), file, response_format: "text", temperature: 0 };
    if (language) createParams.language = language;
    /* Priming the model with the answer so far (in the same language) steers it
       toward an honest continuation and away from the canned hallucinations it
       invents when handed a short or low-content clip with no context. */
    if (prompt) createParams.prompt = prompt;
    const result = await openai.audio.transcriptions.create(createParams);
    return result as any as string;
  };
}

/* Cap the priming prompt so a long answer can't blow past Whisper's prompt
   budget (~224 tokens). We only need recent context to anchor the next segment. */
const WHISPER_PROMPT_MAX_CHARS = 400;

/* ── ElevenLabs Scribe (last-resort STT fallback) ────────────────────────────
 * Only engaged when the primary OpenAI transcription THROWS (provider outage,
 * retired model, bad key) — never on a legitimately empty transcript, so real
 * silence stays silence. Requires ELEVENLABS_API_KEY; when unset the behavior
 * is identical to before (fail → empty transcript, loudly logged). This exists
 * because the proxy silently retired whisper-1 and every interview went deaf —
 * a second, independent vendor caps the blast radius of the next such outage. */
const ELEVENLABS_TIMEOUT_MS = Number(process.env.ELEVENLABS_STT_TIMEOUT_MS) || 15_000;
export const ELEVENLABS_STT_MODEL = "scribe_v1";

export function elevenLabsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY);
}

function defaultElevenLabsTranscribe(env: NodeJS.ProcessEnv) {
  return async ({ file, language }: { file: File; language?: string }): Promise<string> => {
    const form = new FormData();
    form.append("file", file);
    form.append("model_id", ELEVENLABS_STT_MODEL);
    /* Scribe expects ISO-639-1/3 codes; omit when unknown and let it auto-detect. */
    if (language) form.append("language_code", language);
    form.append("tag_audio_events", "false");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ELEVENLABS_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY as string },
        body: form,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`ElevenLabs STT HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: any = await res.json();
      return (json?.text ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ── Deepgram Nova (independent-vendor STT fallback) ─────────────────────────
 * Second vendor in the fallback chain after the primary (Whisper via the
 * OpenAI proxy) THROWS or is unconfigured — before ElevenLabs Scribe. Like
 * ElevenLabs, it is never engaged on a legitimately-empty transcript, so real
 * silence stays silence. Deepgram accepts raw audio bytes (webm/opus, mp4/AAC,
 * wav) directly, which makes it a good fallback for BOTH the Android and iOS
 * capture formats. Requires DEEPGRAM_API_KEY; when unset the chain skips it. */
const DEEPGRAM_TIMEOUT_MS = Number(process.env.DEEPGRAM_STT_TIMEOUT_MS) || 15_000;
export const DEEPGRAM_STT_MODEL = "nova-2";

export function deepgramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEEPGRAM_API_KEY);
}

/* Deepgram nova-2 multilingual coverage (base ISO-639-1). Outside this set we
   omit the language param and let Deepgram auto-detect. */
const DEEPGRAM_LANGS = new Set([
  "en","es","fr","de","it","pt","nl","ru","zh","ja","ko","tr","pl","sv","no",
  "da","uk","el","cs","fi","hu","id","ms","ro","sk","th","vi","bg","ca","et",
  "lv","lt","hi","ta",
]);
export function deepgramLanguageFor(rawLang: string): string | undefined {
  const base = rawLang.split("-")[0].toLowerCase();
  return DEEPGRAM_LANGS.has(base) ? base : undefined;
}

function defaultDeepgramTranscribe(env: NodeJS.ProcessEnv) {
  return async ({ buf, contentType, language }: { buf: Buffer; contentType: string; language?: string }): Promise<string> => {
    const params = new URLSearchParams({ model: DEEPGRAM_STT_MODEL, smart_format: "true" });
    if (language) params.set("language", language);
    else params.set("detect_language", "true");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEEPGRAM_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY as string}`,
          "Content-Type": contentType,
        },
        body: new Uint8Array(buf),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Deepgram STT HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: any = await res.json();
      return (json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ── Sarvam Saarika (Indian-language primary STT) ────────────────────────────
 * Sarvam is purpose-built for the Indian-language cohort (Hindi, Tamil, Telugu,
 * Kannada, Malayalam, Bengali, Gujarati, Marathi, Punjabi, Odia + English) and
 * handles code-switching (Hinglish/Tanglish) better than Azure's per-locale
 * recognizers. Routing: Indian languages try Sarvam FIRST when SARVAM_API_KEY
 * is set, then fall through to the existing Azure → Whisper chain unchanged —
 * so a Sarvam outage or missing key degrades to exactly today's behavior. */
const SARVAM_TIMEOUT_MS = Number(process.env.SARVAM_STT_TIMEOUT_MS) || 10_000;
export const SARVAM_STT_MODEL = "saarika:v2.5";

export function sarvamConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SARVAM_API_KEY);
}

/* Sarvam expects a BCP-47 Indian locale ("hi-IN", "ta-IN"…) or "unknown" for
   auto-detect (best for code-switched speech). */
export function sarvamLanguageCode(rawLang: string): string {
  const SUPPORTED = new Set(["hi","ta","te","kn","ml","bn","gu","mr","pa","od","or","en"]);
  const base = rawLang.split("-")[0].toLowerCase();
  if (!SUPPORTED.has(base)) return "unknown";
  if (base === "or" || base === "od") return "od-IN";
  return `${base}-IN`;
}

function defaultSarvamTranscribe(env: NodeJS.ProcessEnv) {
  return async ({ file, languageCode }: { file: File; languageCode?: string }): Promise<string> => {
    const form = new FormData();
    form.append("file", file);
    form.append("model", SARVAM_STT_MODEL);
    if (languageCode) form.append("language_code", languageCode);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SARVAM_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": env.SARVAM_API_KEY as string },
        body: form,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Sarvam STT HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: any = await res.json();
      return (json?.transcript ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ── iFlytek IAT (Chinese-language primary STT) ──────────────────────────────
 * iFlytek (讯飞) is the market-leading Mandarin recognizer and clearly beats
 * Whisper for Chinese speech, especially with accents and code-switching.
 * Routing: Chinese languages (base "zh") try iFlytek FIRST when the three
 * IFLYTEK_* credentials are set, then fall through to the existing Whisper →
 * Deepgram → ElevenLabs chain unchanged — so an iFlytek outage or missing key
 * degrades to exactly today's behavior.
 *
 * Protocol notes (why this looks different from the other providers):
 *  - iFlytek's IAT API is WebSocket-only with an HMAC-SHA256 signed URL.
 *  - It accepts ONLY raw 16 kHz 16-bit mono PCM — browsers send webm/opus or
 *    mp4/AAC, so we transcode via ffmpeg (available on PATH) before streaming.
 *  - Audio is sent base64-encoded in framed messages (status 0/1/2); results
 *    stream back as JSON segments that we concatenate; data.status === 2 ends
 *    the session.
 */
const IFLYTEK_TIMEOUT_MS = Number(process.env.IFLYTEK_STT_TIMEOUT_MS) || 15_000;
const IFLYTEK_STT_HOST = process.env.IFLYTEK_STT_HOST || "iat-api.xfyun.cn";
const IFLYTEK_STT_PATH = "/v2/iat";

export function iflytekConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.IFLYTEK_APP_ID && env.IFLYTEK_API_KEY && env.IFLYTEK_API_SECRET);
}

/** iFlytek engages only for Chinese (base "zh": zh, zh-CN, zh-TW, zh-HK…). */
export function iflytekHandlesLanguage(rawLang: string): boolean {
  return rawLang.split("-")[0].toLowerCase() === "zh";
}

/** Build the HMAC-SHA256-signed WebSocket URL (iFlytek auth scheme). */
export function iflytekSignedUrl(env: NodeJS.ProcessEnv, now: Date = new Date()): string {
  const date = now.toUTCString();
  const signatureOrigin = `host: ${IFLYTEK_STT_HOST}\ndate: ${date}\nGET ${IFLYTEK_STT_PATH} HTTP/1.1`;
  const signature = nodeCrypto
    .createHmac("sha256", env.IFLYTEK_API_SECRET as string)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin = `api_key="${env.IFLYTEK_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  const qs = new URLSearchParams({ authorization, date, host: IFLYTEK_STT_HOST });
  return `wss://${IFLYTEK_STT_HOST}${IFLYTEK_STT_PATH}?${qs.toString()}`;
}

/* Transcode arbitrary browser audio (webm/opus, mp4/AAC, wav) to the raw
   16 kHz 16-bit mono PCM iFlytek requires. Clips are short (<25 s), so an
   in-memory ffmpeg pipe is cheap. */
async function toPcm16k(buf: Buffer): Promise<Buffer> {
  const { spawn } = await import("node:child_process");
  return await new Promise<Buffer>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "16000", "-ac", "1",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    let errOut = "";
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
    ff.on("error", reject);
    ff.on("close", (code: number | null) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${errOut.slice(0, 200)}`));
    });
    ff.stdin.on("error", () => { /* EPIPE if ffmpeg dies early — surfaced via close */ });
    ff.stdin.end(buf);
  });
}

function defaultIflytekTranscribe(env: NodeJS.ProcessEnv) {
  return async ({ buf, language }: { buf: Buffer; contentType: string; language: string }): Promise<string> => {
    const pcm = await toPcm16k(buf);
    if (pcm.length < 320) return ""; /* <10ms of audio — nothing to send */

    return await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(iflytekSignedUrl(env));
      const pieces: string[] = [];
      let settled = false;
      const finish = (err?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        if (err) reject(err);
        else resolve((text ?? pieces.join("")).trim());
      };
      const timer = setTimeout(
        () => finish(new Error(`iFlytek STT timed out after ${IFLYTEK_TIMEOUT_MS}ms`)),
        IFLYTEK_TIMEOUT_MS,
      );

      ws.onerror = () => finish(new Error("iFlytek WebSocket error"));
      /* A close BEFORE the terminal status-2 result frame means the session was
         cut short (network flap / auth / server abort). Treat it as a FAILURE so
         the Whisper fallback chain runs — never accept a partial transcript as
         a successful primary result. */
      ws.onclose = () => finish(new Error("iFlytek WebSocket closed before final result"));
      ws.onopen = () => {
        /* Frame the PCM: first frame carries common/business config (status 0),
           middle frames status 1, and a final empty status-2 frame ends input.
           Frames may be sent back-to-back — iFlytek does not require realtime
           pacing for short prerecorded clips. */
        const FRAME = 8_000; /* 250ms of 16k/16-bit mono */
        const business = {
          language: "zh_cn",
          domain: "iat",
          accent: "mandarin",
          vad_eos: 5000,
          /* dwa off (no dynamic correction) so segments concatenate cleanly */
        };
        void language; /* zh-TW/HK still use zh_cn model — best available */
        for (let off = 0, first = true; off < pcm.length; off += FRAME, first = false) {
          const audio = pcm.subarray(off, off + FRAME).toString("base64");
          const msg: any = first
            ? { common: { app_id: env.IFLYTEK_APP_ID }, business, data: { status: 0, format: "audio/L16;rate=16000", encoding: "raw", audio } }
            : { data: { status: 1, format: "audio/L16;rate=16000", encoding: "raw", audio } };
          ws.send(JSON.stringify(msg));
        }
        ws.send(JSON.stringify({ data: { status: 2, format: "audio/L16;rate=16000", encoding: "raw", audio: "" } }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const json = JSON.parse(String(ev.data));
          if (json.code !== 0) {
            finish(new Error(`iFlytek STT error ${json.code}: ${String(json.message ?? "").slice(0, 200)}`));
            return;
          }
          const wsSegs = json?.data?.result?.ws ?? [];
          for (const seg of wsSegs) for (const cw of seg?.cw ?? []) if (cw?.w) pieces.push(cw.w);
          if (json?.data?.status === 2) finish(undefined, pieces.join(""));
        } catch (e) {
          finish(e as Error);
        }
      };
    });
  };
}

/* ── STT: audio → transcript via Azure Speech (primary) / Whisper (fallback) ──
 * Returns the transcript plus the provider that produced the final outcome so
 * the caller can record metrics. Never throws — any provider failure resolves
 * to an empty transcript. */
export async function transcribeAudio(
  args: { buf: Buffer | undefined; contentType: string; rawLang: string; prompt?: string },
  deps: Partial<TranscribeDeps> = {},
): Promise<TranscribeResult> {
  const env = deps.env ?? process.env;
  const azureConfigured = deps.azureConfigured ?? azureSpeechConfigured;
  const azureFetch = deps.azureFetch ?? (fetch as unknown as TranscribeDeps["azureFetch"]);
  const whisperTranscribe = deps.whisperTranscribe ?? defaultWhisperTranscribe(env);
  const deepgramTranscribe = deps.deepgramTranscribe ?? defaultDeepgramTranscribe(env);
  const elevenLabsTranscribe = deps.elevenLabsTranscribe ?? defaultElevenLabsTranscribe(env);
  const sarvamTranscribe = deps.sarvamTranscribe ?? defaultSarvamTranscribe(env);
  const iflytekTranscribe = deps.iflytekTranscribe ?? defaultIflytekTranscribe(env);

  const contentType = args.contentType || "audio/webm;codecs=opus";
  const ctBase = contentType.split(";")[0].trim().toLowerCase();
  /* Provider that handled the FINAL outcome — "none" (too-short / no-key) →
     "azure" → "whisper". */
  let provider: SttProvider = "none";

  try {
    const buf = args.buf;
    if (!buf || buf.length < 100) return { transcript: "", provider };

    const rawLang = args.rawLang || "en-US";
    const langMeta = resolveLangMeta(rawLang);

    /* ── Sarvam Saarika (Indian languages, primary) ────────────────────────── */
    /* Purpose-built Indian-language recognizer with code-switching support.
       Any failure or empty result falls through to the Azure → Whisper chain
       below, so this can only ADD accuracy, never remove availability. */
    if (langMeta.region === "indian" && sarvamConfigured(env)) {
      provider = "sarvam";
      try {
        const sarvamExt = WHISPER_EXT[ctBase] ?? "webm";
        const sarvamType = WHISPER_EXT[ctBase] ? ctBase : "audio/webm";
        const sarvamFile = new (globalThis as any).File([buf], `audio.${sarvamExt}`, { type: sarvamType });
        const raw = (await sarvamTranscribe({ file: sarvamFile, languageCode: sarvamLanguageCode(rawLang) })).trim();
        logger.info({ textLen: raw.length, lang: rawLang, ctBase }, "[STT] Sarvam recognition");
        if (raw) {
          const cleaned = cleanWhisperOutput(raw, rawLang);
          if (cleaned) return { transcript: cleaned, provider };
        }
        /* Empty/filtered — fall through to Azure/Whisper (maybe real silence,
           maybe a format Sarvam can't decode; the chain below decides). */
      } catch (err) {
        logger.warn(
          { err: String((err as any)?.message ?? err).slice(0, 300), lang: rawLang, ctBase },
          "[STT] Sarvam failed — falling back to Azure/Whisper",
        );
      }
    }

    /* ── Azure Speech STT (Indian languages only) ──────────────────────────── */
    /* Provider policy: Azure Speech is only reliable for the Indian-language
       cohort (where its neural recognizers clearly beat Whisper). For every
       other language Azure's per-locale models cause real failures — e.g. a
       Brazilian (pt-BR) candidate transcribed against the configured European
       pt-PT locale comes out garbled. Whisper is accent-agnostic from a single
       language hint, so all non-Indian languages go straight to it. This mirrors
       the TTS routing (Azure → Indian only, OpenAI for the rest).

       Round-robin an account from the pool whose breaker is closed for THIS
       format. pickAccount returns null when every account's breaker is open (all
       throttled) → skip straight to Whisper. With one account configured this is
       the previous single-key behavior. */
    const useAzure =
      langMeta.region === "indian" && azureConfigured() && azureAcceptsFormat(ctBase);
    const picked = useAzure
      ? pickAccount("stt", getSttAccounts(env), ctBase)
      : null;
    if (picked) {
      provider = "azure";
      const key    = picked.account.key;
      const region = picked.account.region;
      const locale = langMeta.azureLocale;

      const sttUrl = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${locale}&format=simple&profanityOption=raw`;
      /* Abort a hung/throttled Azure request after the budget so the candidate
         fails over to Whisper fast instead of waiting on a stuck socket. */
      const ctrl = new AbortController();
      const azureTimer = setTimeout(() => ctrl.abort(), AZURE_STT_TIMEOUT_MS);
      try {
        const sttRes = await azureFetch(sttUrl, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": contentType,
          },
          body: buf,
          signal: ctrl.signal,
        });

        if (sttRes.ok) {
          /* Azure responded (alive) — close the breaker even on NoMatch. */
          noteSuccess(picked.breakerKey);
          const json: any = await sttRes.json();
          const transcript = (json.DisplayText ?? "").trim();
          logger.info({ status: json.RecognitionStatus, textLen: (transcript || "").length, account: picked.account?.id }, "[STT] Azure recognition");
          if (json.RecognitionStatus === "Success" && transcript) {
            /* Recognized speech — return immediately */
            return { transcript, provider };
          }
          /* Azure returned Success/NoMatch but no text — fall through to Whisper */
        } else {
          /* HTTP error (incl. 429 throttle) counts toward tripping the breaker. */
          noteFailure(picked.breakerKey, picked.account?.id);
          const errText = await sttRes.text().catch(() => "");
          logger.warn({ status: sttRes.status, statusText: sttRes.statusText, account: picked.account?.id, errText: errText.slice(0, 200) }, "[STT] Azure HTTP error");
          /* Azure HTTP error — fall through to Whisper */
        }
      } catch (err) {
        /* Timeout/abort or network error — count it toward the breaker and fall
           through to Whisper so a slow Azure under load doesn't strand the
           candidate. */
        noteFailure(picked.breakerKey, picked.account?.id);
        const aborted = (err as Error)?.name === "AbortError";
        logger.warn({ err: (err as Error)?.name, aborted, account: picked.account?.id, budgetMs: AZURE_STT_TIMEOUT_MS }, "[STT] Azure request failed — falling back to Whisper");
      } finally {
        clearTimeout(azureTimer);
      }
    }

    /* ── iFlytek IAT (Chinese languages, primary) ──────────────────────────── */
    /* Purpose-built Mandarin recognizer. Any failure or empty result falls
       through to the Whisper → Deepgram → ElevenLabs chain below, so this can
       only ADD accuracy, never remove availability. */
    if (iflytekHandlesLanguage(rawLang) && iflytekConfigured(env)) {
      provider = "iflytek";
      try {
        const raw = (await iflytekTranscribe({ buf, contentType: ctBase, language: rawLang })).trim();
        logger.info({ textLen: raw.length, lang: rawLang, ctBase }, "[STT] iFlytek recognition");
        if (raw) {
          const cleaned = cleanWhisperOutput(raw, rawLang);
          if (cleaned) return { transcript: cleaned, provider };
        }
        /* Empty/filtered — fall through to Whisper (maybe real silence). */
      } catch (err) {
        logger.warn(
          { err: String((err as any)?.message ?? err).slice(0, 300), lang: rawLang, ctBase },
          "[STT] iFlytek failed — falling back to Whisper",
        );
      }
    }

    /* ── Whisper (primary for all languages) ───────────────────────────────── */
    const whisperExt = WHISPER_EXT[ctBase] ?? "webm";
    const whisperType = WHISPER_EXT[ctBase] ? ctBase : "audio/webm";
    const file = new (globalThis as any).File([buf], `audio.${whisperExt}`, { type: whisperType });
    const rawBase = rawLang.split("-")[0].toLowerCase();
    const baseLang = WHISPER_LANG_ALIASES[rawBase] ?? rawBase;
    const language = WHISPER_STRONG.has(baseLang) ? baseLang : undefined;
    const prompt = args.prompt?.trim().slice(-WHISPER_PROMPT_MAX_CHARS) || undefined;

    /* ── Independent-vendor fallback chain (Deepgram → ElevenLabs) ───────────
       Engaged ONLY when the primary vendor is systemically unavailable: the
       Whisper call THROWS, or no OpenAI key is configured at all. Never run on
       an empty-but-successful transcript — real silence stays silence. Each
       vendor failure falls through to the next; the final outcome is an empty
       transcript, loudly logged. */
    const vendorFallback = async (): Promise<TranscribeResult> => {
      if (deepgramConfigured(env)) {
        provider = "deepgram";
        try {
          const raw = (await deepgramTranscribe({
            buf, contentType: WHISPER_EXT[ctBase] ? ctBase : "audio/webm",
            language: deepgramLanguageFor(rawLang),
          })).trim();
          logger.info({ textLen: raw.length, lang: rawLang, ctBase }, "[STT] Deepgram fallback transcription");
          return { transcript: cleanWhisperOutput(raw, rawLang), provider };
        } catch (dgErr) {
          logger.error(
            { err: String((dgErr as any)?.message ?? dgErr).slice(0, 300), lang: rawLang, ctBase },
            "[STT] Deepgram fallback failed — trying ElevenLabs",
          );
        }
      }
      if (elevenLabsConfigured(env)) {
        provider = "elevenlabs";
        try {
          const raw = (await elevenLabsTranscribe({ file, language })).trim();
          logger.info({ textLen: raw.length, lang: rawLang, ctBase }, "[STT] ElevenLabs fallback transcription");
          return { transcript: cleanWhisperOutput(raw, rawLang), provider };
        } catch (elErr) {
          logger.error(
            { err: String((elErr as any)?.message ?? elErr).slice(0, 300), lang: rawLang, ctBase },
            "[STT] ElevenLabs fallback also failed — returning empty transcript",
          );
        }
      }
      return { transcript: "", provider };
    };

    if (!(env.AI_INTEGRATIONS_OPENAI_API_KEY ?? env.OPENAI_API_KEY)) {
      /* Primary vendor not even configured — the fallback chain IS the STT. */
      return await vendorFallback();
    }
    provider = "whisper";
    try {
      const raw = (await whisperTranscribe({ file, language, prompt })).trim();
      return { transcript: cleanWhisperOutput(raw, rawLang), provider };
    } catch (err) {
      /* A provider error must never crash the candidate's mic loop, but it must
         also never be silent — a systemic failure (unsupported model, bad key,
         throttling) looks identical to silence otherwise. */
      const e = err as any;
      logger.error(
        { status: e?.status, err: String(e?.message ?? e).slice(0, 300), model: sttModelFor(env), lang: rawLang, ctBase },
        "[STT] Whisper transcription failed — engaging vendor fallback chain",
      );
      return await vendorFallback();
    }
  } catch (err) {
    logger.error({ err: String((err as any)?.message ?? err).slice(0, 300) }, "[STT] transcribeAudio unexpected failure");
    return { transcript: "", provider };
  }
}
