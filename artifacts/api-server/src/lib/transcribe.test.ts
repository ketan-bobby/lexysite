/**
 * transcribe.test.ts — automated coverage for the /interviews/transcribe brains.
 *
 * Mobile interview listening depends on routing each phone's audio format AND
 * language to a provider that can handle it:
 *   - Provider policy: Azure Speech is used ONLY for Indian-language interviews;
 *     every other language goes straight to Whisper (Azure's per-locale models
 *     mis-transcribe e.g. Brazilian pt-BR against the configured pt-PT locale).
 *   - Format: iOS Safari sends audio/mp4 (AAC) which MUST go to Whisper (Azure
 *     can't decode it); Android/Chrome send audio/webm (opus) which goes to
 *     Azure first — but only for Indian languages.
 * These tests pin that routing so a regression can't silently break listening on
 * one platform or shunt an Indian-language candidate off Azure.
 *
 * NOTE: tests that exercise the Azure path use an Indian language ("or-IN",
 * Odia) so Azure is attempted. Odia is chosen because the Whisper hallucination
 * cleaner does NOT enforce a non-Latin script for it, so the Latin
 * Whisper-fallback assertions below survive cleanWhisperOutput(). Non-Indian
 * languages intentionally never touch Azure.
 *
 * Uses Node's built-in test runner (node:test) with dependency injection — no
 * live HTTP server, database, or Azure/OpenAI credentials required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribeAudio, cleanWhisperOutput, sarvamLanguageCode, sttModelFor, DEFAULT_STT_MODEL, type TranscribeDeps, type SttHttpResponse } from "./transcribe.ts";

/* A buffer comfortably over the 100-byte minimum so it isn't treated as too-short. */
const audioBuf = Buffer.alloc(2048, 1);

/* Env that makes both Azure and Whisper appear "available" by default. Tests
   override azureConfigured() / azureFetch / whisperTranscribe as needed. */
const fullEnv: NodeJS.ProcessEnv = {
  AZURE_SPEECH_KEY: "test-key",
  AZURE_SPEECH_REGION: "eastus",
  OPENAI_API_KEY: "test-openai-key",
};

function azureSuccess(text: string): SttHttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({ RecognitionStatus: "Success", DisplayText: text }),
    text: async () => "",
  };
}

function azureHttpError(status: number): SttHttpResponse {
  return {
    ok: false,
    status,
    statusText: "error",
    json: async () => ({}),
    text: async () => "azure failed",
  };
}

test("too-short buffer returns empty transcript and does not call any provider", async () => {
  let azureCalled = false;
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { azureCalled = true; return azureSuccess("nope"); },
    whisperTranscribe: async () => { whisperCalled = true; return "nope"; },
  };

  const tiny = Buffer.alloc(50, 1); // < 100 bytes
  const res = await transcribeAudio({ buf: tiny, contentType: "audio/webm;codecs=opus", rawLang: "or-IN" }, deps);

  assert.equal(res.transcript, "");
  assert.equal(res.provider, "none");
  assert.equal(azureCalled, false, "Azure must not be called for a too-short buffer");
  assert.equal(whisperCalled, false, "Whisper must not be called for a too-short buffer");
});

test("undefined buffer returns empty transcript", async () => {
  const res = await transcribeAudio(
    { buf: undefined, contentType: "audio/webm", rawLang: "or-IN" },
    { env: fullEnv, azureConfigured: () => true, azureFetch: async () => azureSuccess("x") },
  );
  assert.equal(res.transcript, "");
  assert.equal(res.provider, "none");
});

test("webm/opus (Android/Chrome) attempts Azure first", async () => {
  let azureUrl = "";
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async (url) => { azureUrl = url; return azureSuccess("hello from azure"); },
    whisperTranscribe: async () => { whisperCalled = true; return "should not happen"; },
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "or-IN" }, deps);

  assert.equal(res.provider, "azure");
  assert.equal(res.transcript, "hello from azure");
  assert.ok(azureUrl.includes("stt.speech.microsoft.com"), "Azure STT endpoint should be hit");
  assert.equal(whisperCalled, false, "Whisper must not run when Azure succeeds for webm");
});

test("mp4/aac (iOS Safari) skips Azure and routes to Whisper, named by real content-type", async () => {
  for (const [contentType, expectedExt] of [
    ["audio/mp4", "mp4"],
    ["audio/aac", "aac"],
    ["audio/x-m4a", "m4a"],
  ] as const) {
    let azureCalled = false;
    let receivedFile: File | undefined;
    const deps: Partial<TranscribeDeps> = {
      env: fullEnv,
      azureConfigured: () => true,
      azureFetch: async () => { azureCalled = true; return azureSuccess("nope"); },
      whisperTranscribe: async ({ file }) => { receivedFile = file; return "whisper text"; },
    };

    const res = await transcribeAudio({ buf: audioBuf, contentType, rawLang: "or-IN" }, deps);

    assert.equal(azureCalled, false, `Azure must be skipped for ${contentType} (it can't decode AAC)`);
    assert.equal(res.provider, "whisper");
    assert.equal(res.transcript, "whisper text");
    assert.ok(receivedFile, "Whisper should receive a File");
    assert.equal(receivedFile!.name, `audio.${expectedExt}`, `Whisper upload must be named by real content-type for ${contentType}`);
    assert.equal(receivedFile!.type, contentType, `Whisper file type must match real content-type for ${contentType}`);
  }
});

test("non-Indian language on webm skips Azure entirely and uses Whisper (provider policy)", async () => {
  let azureCalled = false;
  let whisperLang: string | undefined = "UNSET";
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { azureCalled = true; return azureSuccess("should not run"); },
    whisperTranscribe: async ({ language }) => { whisperLang = language; return "olá tudo bem"; },
  };

  /* Portuguese (pt-BR) is a "global" language — Azure must NOT be attempted even
     though the format (webm) is Azure-eligible and credentials are present. */
  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "pt-BR" }, deps);

  assert.equal(azureCalled, false, "Azure must be skipped for non-Indian languages even on Azure-eligible audio");
  assert.equal(res.provider, "whisper");
  assert.equal(res.transcript, "olá tudo bem");
  assert.equal(whisperLang, "pt", "Whisper should receive the base language hint for Portuguese");
});

test("Azure HTTP error falls through to Whisper without throwing", async () => {
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => azureHttpError(500),
    whisperTranscribe: async () => { whisperCalled = true; return "recovered by whisper"; },
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/webm", rawLang: "or-IN" }, deps);

  assert.equal(whisperCalled, true, "Whisper should be the fallback after an Azure HTTP error");
  assert.equal(res.provider, "whisper");
  assert.equal(res.transcript, "recovered by whisper");
});

test("Azure throwing is caught and returns empty without throwing", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: { AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "eastus" }, // no OpenAI key → no whisper fallback
    azureConfigured: () => true,
    azureFetch: async () => { throw new Error("network down"); },
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/webm", rawLang: "or-IN" }, deps);
  assert.equal(res.transcript, "");
});

test("Whisper throwing is caught and returns empty without throwing", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => false, // skip azure, go straight to whisper
    whisperTranscribe: async () => { throw new Error("whisper 500"); },
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/mp4", rawLang: "or-IN" }, deps);
  assert.equal(res.transcript, "");
});

test("no Whisper key after Azure unavailable returns empty (provider none)", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: { AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "eastus" }, // no OpenAI key
    azureConfigured: () => false,
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/mp4", rawLang: "or-IN" }, deps);
  assert.equal(res.transcript, "");
  assert.equal(res.provider, "none");
});

test("Azure NoMatch (empty text) falls through to Whisper", async () => {
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ RecognitionStatus: "NoMatch", DisplayText: "" }),
      text: async () => "",
    }),
    whisperTranscribe: async () => { whisperCalled = true; return "whisper saved it"; },
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/webm", rawLang: "or-IN" }, deps);
  assert.equal(whisperCalled, true);
  assert.equal(res.transcript, "whisper saved it");
  assert.equal(res.provider, "whisper");
});

test("Whisper hallucination output is filtered to empty", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => "Thanks for watching!",
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/mp4", rawLang: "or-IN" }, deps);
  assert.equal(res.transcript, "");
  assert.equal(res.provider, "whisper");
});

/* ── Concurrency / latency hardening ─────────────────────────────────────────
 * Under concurrent mobile load Azure throttles in bursts. These tests pin the
 * timeout-fallthrough and the per-format circuit breaker so the "slow for some"
 * regression can't return. The breaker is module-level state keyed by audio
 * format, so each test below uses a DISTINCT Azure-eligible format (webm / ogg /
 * wav / x-wav) to stay isolated from the others. */

test("Azure abort/timeout falls through to Whisper (does not strand the candidate)", async () => {
  let whisperCalled = false;
  const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { throw abortErr; },
    whisperTranscribe: async () => { whisperCalled = true; return "whisper after timeout"; },
  };

  const res = await transcribeAudio({ buf: audioBuf, contentType: "audio/webm", rawLang: "or-IN" }, deps);
  assert.equal(whisperCalled, true, "an aborted/timed-out Azure call must fall over to Whisper");
  assert.equal(res.provider, "whisper");
  assert.equal(res.transcript, "whisper after timeout");
});

test("Azure breaker opens after consecutive failures and skips Azure entirely", async () => {
  let azureCalls = 0;
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { azureCalls++; return azureHttpError(429); },
    whisperTranscribe: async () => "whisper",
  };
  const ct = "audio/ogg"; // isolated format for this test

  /* Default threshold is 3 consecutive hard failures. */
  for (let i = 0; i < 3; i++) {
    const r = await transcribeAudio({ buf: audioBuf, contentType: ct, rawLang: "or-IN" }, deps);
    assert.equal(r.provider, "whisper");
  }
  assert.equal(azureCalls, 3, "Azure should be tried up to the threshold before the breaker opens");

  /* Breaker now open — Azure must be skipped so the cohort doesn't keep paying
     the timeout on every request. */
  const after = await transcribeAudio({ buf: audioBuf, contentType: ct, rawLang: "or-IN" }, deps);
  assert.equal(after.provider, "whisper");
  assert.equal(azureCalls, 3, "Azure must NOT be called once the breaker is open");
});

test("Azure breaker is per-format: one format's failures don't open another's", async () => {
  /* Trip the breaker for audio/wav with 3 failures. */
  const failDeps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => azureHttpError(429),
    whisperTranscribe: async () => "whisper",
  };
  for (let i = 0; i < 3; i++) {
    await transcribeAudio({ buf: audioBuf, contentType: "audio/wav", rawLang: "or-IN" }, failDeps);
  }

  /* audio/wav is now open → Azure skipped. */
  let wavAzureCalled = false;
  const wavProbe: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { wavAzureCalled = true; return azureSuccess("should not run"); },
    whisperTranscribe: async () => "whisper",
  };
  const wavRes = await transcribeAudio({ buf: audioBuf, contentType: "audio/wav", rawLang: "or-IN" }, wavProbe);
  assert.equal(wavAzureCalled, false, "audio/wav breaker should be open");
  assert.equal(wavRes.provider, "whisper");

  /* A DIFFERENT format must be unaffected — Azure still attempted and succeeds. */
  let xwavAzureCalled = false;
  const xwavProbe: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { xwavAzureCalled = true; return azureSuccess("healthy cohort"); },
    whisperTranscribe: async () => "whisper",
  };
  const xwavRes = await transcribeAudio({ buf: audioBuf, contentType: "audio/x-wav", rawLang: "or-IN" }, xwavProbe);
  assert.equal(xwavAzureCalled, true, "audio/x-wav breaker must remain closed");
  assert.equal(xwavRes.provider, "azure");
  assert.equal(xwavRes.transcript, "healthy cohort");
});

test("an Azure success resets the breaker's failure streak", async () => {
  const ct = "audio/x-wav"; // closed/healthy from the previous test
  let mode: "fail" | "ok" = "fail";
  let azureCalls = 0;
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    azureFetch: async () => { azureCalls++; return mode === "ok" ? azureSuccess("ok") : azureHttpError(429); },
    whisperTranscribe: async () => "whisper",
  };

  /* Two failures (below threshold), then a success resets the streak. */
  await transcribeAudio({ buf: audioBuf, contentType: ct, rawLang: "or-IN" }, deps);
  await transcribeAudio({ buf: audioBuf, contentType: ct, rawLang: "or-IN" }, deps);
  mode = "ok";
  const okRes = await transcribeAudio({ buf: audioBuf, contentType: ct, rawLang: "or-IN" }, deps);
  assert.equal(okRes.provider, "azure", "success path should win and reset the streak");

  /* Streak reset → it again takes a full threshold of NEW failures before the
     breaker would open; the next failure alone must still try Azure. */
  mode = "fail";
  const callsBefore = azureCalls;
  const nextRes = await transcribeAudio({ buf: audioBuf, contentType: ct, rawLang: "or-IN" }, deps);
  assert.equal(azureCalls, callsBefore + 1, "Azure should still be attempted (breaker not open after a reset)");
  assert.equal(nextRes.provider, "whisper");
});

/* ── Latin-script repetition / loop guard (cleanWhisperOutput) ──────────────
 * Whisper hallucinates loops on short/quiet non-English audio; the older script
 * checks only catch NON-Latin garbage, so these pin the script-agnostic guard. */

test("cleanWhisperOutput: a token repeated 6+ times in a row is discarded", () => {
  assert.equal(cleanWhisperOutput("obrigado obrigado obrigado obrigado obrigado obrigado", "pt"), "");
});

test("cleanWhisperOutput: a short phrase repeated back-to-back is discarded", () => {
  assert.equal(cleanWhisperOutput("não sei não sei não sei não sei", "pt"), "");
});

test("cleanWhisperOutput: very low lexical diversity over a long output is discarded", () => {
  /* 16 words, only 2 distinct → diversity 0.125 < 0.25 */
  const babble = "casa casa porta casa casa porta casa casa porta casa casa porta casa casa porta casa";
  assert.equal(cleanWhisperOutput(babble, "pt"), "");
});

test("cleanWhisperOutput: a sentence-length loop after a genuine answer is collapsed, keeping the genuine part", () => {
  /* Seen live in Gujarati: Sarvam echoed one ~13-word sentence 6× inside a
     single result after the candidate's real opening sentence. */
  const genuine =
    "ગુજરાતી મારી માતૃભાષા છે. અમારા રોજિંદા જીવનમાં ઘરમાં દરેક પ્રકારની વાતચીતમાં ગુજરાતી ભાષાનો જ ઉપયોગ થાય છે.";
  const loop = "અમારા રોજિંદા જીવનમાં ઘરમાં દરેક પ્રકારની વાતચીતમાં ગુજરાતી ભાષાનો જ ઉપયોગ થાય છે.";
  const looped = "ગુજરાતી મારી માતૃભાષા છે. " + Array(6).fill(loop).join(" ");
  assert.equal(cleanWhisperOutput(looped, "gu-IN"), genuine);
});

test("cleanWhisperOutput: a pure long-phrase loop collapses to a single occurrence", () => {
  /* One fluent sentence echoed 6× — keep exactly one copy (the remnant is
     high-diversity, so it is not treated as babble). */
  const loop = "અમારા રોજિંદા જીવનમાં ઘરમાં દરેક પ્રકારની વાતચીતમાં ઉપયોગ થાય છે.";
  assert.equal(cleanWhisperOutput(Array(6).fill(loop).join(" "), "gu-IN"), loop);
});

test("cleanWhisperOutput: a genuine Portuguese answer is preserved", () => {
  const real = "Eu tenho cinco anos de experiência liderando equipes de engenharia em empresas de tecnologia.";
  assert.equal(cleanWhisperOutput(real, "pt"), real);
});

test("cleanWhisperOutput: a short real answer (under the guard threshold) is preserved", () => {
  assert.equal(cleanWhisperOutput("Sim, claro.", "pt"), "Sim, claro.");
});

test("cleanWhisperOutput: a normal answer that repeats a word a few times survives", () => {
  const real = "Sim sim, eu concordo totalmente com essa abordagem para o projeto.";
  assert.equal(cleanWhisperOutput(real, "pt"), real);
});

/* ── Whisper priming prompt passthrough ─────────────────────────────────────
 * The answer-so-far is passed to Whisper to curb hallucination on short clips.
 * Pin that transcribeAudio forwards it (capped to the model's prompt budget). */

test("transcribeAudio forwards the priming prompt to Whisper for non-Indian languages", async () => {
  let seenPrompt: string | undefined = "UNSET";
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    whisperTranscribe: async ({ prompt }) => { seenPrompt = prompt; return "resposta"; },
  };
  const res = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "pt-BR", prompt: "Eu trabalho com" },
    deps,
  );
  assert.equal(res.provider, "whisper");
  assert.equal(res.transcript, "resposta");
  assert.equal(seenPrompt, "Eu trabalho com");
});

test("transcribeAudio caps an over-long priming prompt to the tail of the text", async () => {
  let seenPrompt = "";
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    whisperTranscribe: async ({ prompt }) => { seenPrompt = prompt ?? ""; return "ok"; },
  };
  const long = "a".repeat(1000);
  await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "pt-BR", prompt: long },
    deps,
  );
  assert.ok(seenPrompt.length <= 400, `prompt should be capped, got ${seenPrompt.length}`);
});

test("transcribeAudio sends no prompt when none is provided", async () => {
  let seenPrompt: string | undefined = "UNSET";
  const deps: Partial<TranscribeDeps> = {
    env: fullEnv,
    azureConfigured: () => true,
    whisperTranscribe: async ({ prompt }) => { seenPrompt = prompt; return "ok"; },
  };
  await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "pt-BR" },
    deps,
  );
  assert.equal(seenPrompt, undefined);
});

/* ── STT model contract (regression: proxy dropped whisper-1) ────────────────
 * The July 2026 Spanish-interview outage was caused by the AI proxy dropping
 * the legacy "whisper-1" model: every call 400'd and was swallowed as an empty
 * transcript. Pin the contract: the model comes from STT_MODEL with a
 * proxy-supported default, and the legacy model is never the default again. */
test("sttModelFor defaults to a proxy-supported model (never legacy whisper-1)", () => {
  assert.equal(sttModelFor({} as NodeJS.ProcessEnv), DEFAULT_STT_MODEL);
  assert.equal(DEFAULT_STT_MODEL, "gpt-4o-transcribe");
  assert.notEqual(DEFAULT_STT_MODEL, "whisper-1");
});

test("sttModelFor honors the STT_MODEL env override", () => {
  assert.equal(sttModelFor({ STT_MODEL: "custom-model" } as NodeJS.ProcessEnv), "custom-model");
  assert.equal(sttModelFor({ STT_MODEL: "" } as NodeJS.ProcessEnv), DEFAULT_STT_MODEL);
});

test("cleanWhisperOutput: Amara.org subtitle hallucination (Spanish/Portuguese) is discarded", () => {
  assert.equal(cleanWhisperOutput("Subtítulos realizados por la comunidad de Amara.org", "es-PE"), "");
  assert.equal(cleanWhisperOutput("Legendas pela comunidade Amara.org", "pt-BR"), "");
  assert.notEqual(cleanWhisperOutput("Tengo cinco años de experiencia con Java.", "es-PE"), "");
});

/* ── ElevenLabs Scribe last-resort fallback ──────────────────────────────────
 * Independent-vendor safety net: when the primary OpenAI transcription THROWS
 * (provider outage / retired model), fall over to ElevenLabs — but only when a
 * key is configured, and never on a legitimately empty (silent) transcript. */
test("transcribeAudio falls back to ElevenLabs when Whisper throws and a key is configured", async () => {
  let elCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, ELEVENLABS_API_KEY: "el-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw Object.assign(new Error("model retired"), { status: 400 }); },
    elevenLabsTranscribe: async () => { elCalled = true; return "Tengo cinco años de experiencia."; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.ok(elCalled, "ElevenLabs should be tried when Whisper throws");
  assert.equal(r.provider, "elevenlabs");
  assert.equal(r.transcript, "Tengo cinco años de experiencia.");
});

test("transcribeAudio does NOT call ElevenLabs on an empty-but-successful transcript (real silence)", async () => {
  let elCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, ELEVENLABS_API_KEY: "el-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => "",
    elevenLabsTranscribe: async () => { elCalled = true; return "should not happen"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(elCalled, false, "real silence must never be re-transcribed");
  assert.equal(r.provider, "whisper");
  assert.equal(r.transcript, "");
});

test("transcribeAudio returns empty (no ElevenLabs call) when Whisper throws and no key is set", async () => {
  let elCalled = false;
  const env = { ...fullEnv } as NodeJS.ProcessEnv;
  delete (env as any).ELEVENLABS_API_KEY;
  const deps: Partial<TranscribeDeps> = {
    env,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw new Error("outage"); },
    elevenLabsTranscribe: async () => { elCalled = true; return "nope"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(elCalled, false);
  assert.equal(r.transcript, "");
});

test("transcribeAudio survives BOTH Whisper and ElevenLabs failing", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, ELEVENLABS_API_KEY: "el-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw new Error("outage"); },
    elevenLabsTranscribe: async () => { throw new Error("also down"); },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(r.transcript, "");
  assert.equal(r.provider, "elevenlabs");
});

test("ElevenLabs fallback output still passes through the hallucination filter", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, ELEVENLABS_API_KEY: "el-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw new Error("outage"); },
    elevenLabsTranscribe: async () => "Subtítulos realizados por la comunidad de Amara.org",
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(r.transcript, "");
});

/* ── Sarvam Saarika (Indian-language primary) ────────────────────────────────
 * Indian languages try Sarvam FIRST when SARVAM_API_KEY is set; any failure or
 * empty result falls through to the existing Azure → Whisper chain unchanged.
 * Non-Indian languages must never touch Sarvam. */
test("transcribeAudio uses Sarvam first for Indian languages when configured", async () => {
  let azureCalled = false, whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, SARVAM_API_KEY: "sv-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => true,
    azureFetch: async () => { azureCalled = true; return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; },
    whisperTranscribe: async () => { whisperCalled = true; return "whisper text"; },
    sarvamTranscribe: async ({ languageCode }) => {
      assert.equal(languageCode, "hi-IN");
      return "मेरे पास पाँच साल का अनुभव है";
    },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "hi-IN" },
    deps,
  );
  assert.equal(r.provider, "sarvam");
  assert.equal(r.transcript, "मेरे पास पाँच साल का अनुभव है");
  assert.equal(azureCalled, false);
  assert.equal(whisperCalled, false);
});

test("transcribeAudio skips Sarvam for non-Indian languages", async () => {
  let sarvamCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, SARVAM_API_KEY: "sv-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => "hola",
    sarvamTranscribe: async () => { sarvamCalled = true; return "no"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(sarvamCalled, false);
  assert.equal(r.provider, "whisper");
});

test("transcribeAudio falls through Sarvam failure to Azure→Whisper chain", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, SARVAM_API_KEY: "sv-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => "எனக்கு ஐந்து ஆண்டுகள் அனுபவம் உள்ளது",
    sarvamTranscribe: async () => { throw new Error("sarvam down"); },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "ta-IN" },
    deps,
  );
  assert.equal(r.provider, "whisper");
  assert.equal(r.transcript, "எனக்கு ஐந்து ஆண்டுகள் அனுபவம் உள்ளது");
});

test("transcribeAudio without SARVAM_API_KEY behaves exactly as before (Azure path)", async () => {
  let sarvamCalled = false;
  const env = { ...fullEnv } as NodeJS.ProcessEnv;
  delete (env as any).SARVAM_API_KEY;
  const deps: Partial<TranscribeDeps> = {
    env,
    azureConfigured: () => true,
    azureFetch: async () => ({ ok: true, status: 200, json: async () => ({ RecognitionStatus: "Success", DisplayText: "azure text" }), text: async () => "" }),
    whisperTranscribe: async () => "unused",
    sarvamTranscribe: async () => { sarvamCalled = true; return "no"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "hi-IN" },
    deps,
  );
  assert.equal(sarvamCalled, false);
  assert.equal(r.provider, "azure");
  assert.equal(r.transcript, "azure text");
});

test("sarvamLanguageCode maps locales and falls back to auto-detect", () => {
  assert.equal(sarvamLanguageCode("hi-IN"), "hi-IN");
  assert.equal(sarvamLanguageCode("ta"), "ta-IN");
  assert.equal(sarvamLanguageCode("or-IN"), "od-IN");
  assert.equal(sarvamLanguageCode("fr-FR"), "unknown");
});

/* ── Deepgram Nova (independent-vendor fallback, before ElevenLabs) ──────────
 * When the primary OpenAI transcription THROWS (or no OpenAI key exists at
 * all), Deepgram is tried FIRST in the vendor fallback chain, then ElevenLabs.
 * Like ElevenLabs, it must never run on a legitimately empty transcript. */
test("transcribeAudio falls back to Deepgram (before ElevenLabs) when Whisper throws", async () => {
  let dgCalled = false, elCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, DEEPGRAM_API_KEY: "dg-key", ELEVENLABS_API_KEY: "el-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw Object.assign(new Error("model retired"), { status: 400 }); },
    deepgramTranscribe: async () => { dgCalled = true; return "Tengo cinco años de experiencia."; },
    elevenLabsTranscribe: async () => { elCalled = true; return "should not happen"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.ok(dgCalled, "Deepgram should be tried first when Whisper throws");
  assert.equal(elCalled, false, "ElevenLabs must not run when Deepgram succeeds");
  assert.equal(r.provider, "deepgram");
  assert.equal(r.transcript, "Tengo cinco años de experiencia.");
});

test("transcribeAudio falls through Deepgram → ElevenLabs when Deepgram also fails", async () => {
  let elCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, DEEPGRAM_API_KEY: "dg-key", ELEVENLABS_API_KEY: "el-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw new Error("outage"); },
    deepgramTranscribe: async () => { throw new Error("dg down too"); },
    elevenLabsTranscribe: async () => { elCalled = true; return "Tengo experiencia en ventas."; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.ok(elCalled, "ElevenLabs is the last resort after Deepgram fails");
  assert.equal(r.provider, "elevenlabs");
  assert.equal(r.transcript, "Tengo experiencia en ventas.");
});

test("transcribeAudio does NOT call Deepgram on an empty-but-successful transcript (real silence)", async () => {
  let dgCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, DEEPGRAM_API_KEY: "dg-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => "",
    deepgramTranscribe: async () => { dgCalled = true; return "should not happen"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(dgCalled, false, "real silence must never be re-transcribed");
  assert.equal(r.provider, "whisper");
  assert.equal(r.transcript, "");
});

test("transcribeAudio uses the vendor fallback chain when NO OpenAI key is configured", async () => {
  let dgCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { DEEPGRAM_API_KEY: "dg-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw new Error("must not be called"); },
    deepgramTranscribe: async () => { dgCalled = true; return "I have five years of experience."; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "en-US" },
    deps,
  );
  assert.ok(dgCalled, "Deepgram should carry STT when OpenAI is unconfigured");
  assert.equal(r.provider, "deepgram");
  assert.equal(r.transcript, "I have five years of experience.");
});

test("Deepgram fallback output still passes through the hallucination filter", async () => {
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, DEEPGRAM_API_KEY: "dg-key" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    whisperTranscribe: async () => { throw new Error("outage"); },
    deepgramTranscribe: async () => "Subtítulos realizados por la comunidad de Amara.org",
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "es-PE" },
    deps,
  );
  assert.equal(r.transcript, "");
});

test("deepgramLanguageFor maps supported base codes and auto-detects the rest", async () => {
  const { deepgramLanguageFor } = await import("./transcribe.ts");
  assert.equal(deepgramLanguageFor("es-PE"), "es");
  assert.equal(deepgramLanguageFor("pt-BR"), "pt");
  assert.equal(deepgramLanguageFor("hi-IN"), "hi");
  assert.equal(deepgramLanguageFor("gu-IN"), undefined, "unsupported → auto-detect");
});

/* ── iFlytek IAT (Chinese-language primary) ──────────────────────────────────
 * Chinese (base "zh") tries iFlytek FIRST when the IFLYTEK_* credentials are
 * set; any failure or empty result falls through to Whisper unchanged, and the
 * vendor fallback chain below Whisper is untouched. */
test("transcribeAudio uses iFlytek as primary for Chinese when configured", async () => {
  let iflyCalled = false, whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "k", IFLYTEK_API_SECRET: "s" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    iflytekTranscribe: async () => { iflyCalled = true; return "我有五年的销售经验。"; },
    whisperTranscribe: async () => { whisperCalled = true; return "should not happen"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "zh-CN" },
    deps,
  );
  assert.ok(iflyCalled, "iFlytek should be tried first for Chinese");
  assert.equal(whisperCalled, false);
  assert.equal(r.provider, "iflytek");
  assert.equal(r.transcript, "我有五年的销售经验。");
});

test("transcribeAudio falls back to Whisper when iFlytek throws", async () => {
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "k", IFLYTEK_API_SECRET: "s" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    iflytekTranscribe: async () => { throw new Error("iflytek down"); },
    whisperTranscribe: async () => { whisperCalled = true; return "我有五年的经验。"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "zh-CN" },
    deps,
  );
  assert.ok(whisperCalled, "Whisper must carry the request when iFlytek fails");
  assert.equal(r.provider, "whisper");
  assert.equal(r.transcript, "我有五年的经验。");
});

test("transcribeAudio falls back to Whisper when iFlytek returns empty", async () => {
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "k", IFLYTEK_API_SECRET: "s" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    iflytekTranscribe: async () => "",
    whisperTranscribe: async () => { whisperCalled = true; return "还不错。"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "zh" },
    deps,
  );
  assert.ok(whisperCalled);
  assert.equal(r.provider, "whisper");
  assert.equal(r.transcript, "还不错。");
});

test("transcribeAudio does NOT call iFlytek for non-Chinese languages", async () => {
  let iflyCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "k", IFLYTEK_API_SECRET: "s" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    iflytekTranscribe: async () => { iflyCalled = true; return "should not happen"; },
    whisperTranscribe: async () => "I have five years of experience.",
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "en-US" },
    deps,
  );
  assert.equal(iflyCalled, false);
  assert.equal(r.provider, "whisper");
});

test("transcribeAudio skips iFlytek for Chinese when credentials are missing", async () => {
  let iflyCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app" } as NodeJS.ProcessEnv, /* key+secret missing */
    azureConfigured: () => false,
    iflytekTranscribe: async () => { iflyCalled = true; return "x"; },
    whisperTranscribe: async () => "我有经验。",
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "zh-CN" },
    deps,
  );
  assert.equal(iflyCalled, false, "partial credentials must not enable iFlytek");
  assert.equal(r.provider, "whisper");
});

test("iFlytek output still passes through the hallucination filter", async () => {
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "k", IFLYTEK_API_SECRET: "s" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    iflytekTranscribe: async () => "谢谢观看",
    whisperTranscribe: async () => { whisperCalled = true; return ""; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "zh-CN" },
    deps,
  );
  assert.ok(whisperCalled, "filtered iFlytek output must fall through to Whisper");
  assert.equal(r.transcript, "");
});

test("iflytekSignedUrl produces a stable HMAC-signed wss URL", async () => {
  const { iflytekSignedUrl, iflytekHandlesLanguage } = await import("./transcribe.ts");
  const env = { IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "key", IFLYTEK_API_SECRET: "secret" } as NodeJS.ProcessEnv;
  const url = new URL(iflytekSignedUrl(env, new Date("2026-07-20T00:00:00Z")));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.hostname, "iat-api.xfyun.cn");
  assert.equal(url.pathname, "/v2/iat");
  assert.equal(url.searchParams.get("host"), "iat-api.xfyun.cn");
  assert.equal(url.searchParams.get("date"), "Mon, 20 Jul 2026 00:00:00 GMT");
  const authz = Buffer.from(url.searchParams.get("authorization") ?? "", "base64").toString();
  assert.ok(authz.includes('api_key="key"'));
  assert.ok(authz.includes('algorithm="hmac-sha256"'));
  assert.ok(authz.includes('headers="host date request-line"'));
  assert.ok(/signature="[A-Za-z0-9+/=]+"/.test(authz));
  assert.equal(iflytekHandlesLanguage("zh-TW"), true);
  assert.equal(iflytekHandlesLanguage("ja"), false);
});

test("transcribeAudio falls back to Whisper when iFlytek session is cut short (partial result)", async () => {
  /* The real client rejects when the WebSocket closes before the terminal
     status-2 frame; a rejecting dep must route to Whisper, never surface a
     partial transcript as the primary result. */
  let whisperCalled = false;
  const deps: Partial<TranscribeDeps> = {
    env: { ...fullEnv, IFLYTEK_APP_ID: "app", IFLYTEK_API_KEY: "k", IFLYTEK_API_SECRET: "s" } as NodeJS.ProcessEnv,
    azureConfigured: () => false,
    iflytekTranscribe: async () => { throw new Error("iFlytek WebSocket closed before final result"); },
    whisperTranscribe: async () => { whisperCalled = true; return "完整的回答内容。"; },
  };
  const r = await transcribeAudio(
    { buf: audioBuf, contentType: "audio/webm;codecs=opus", rawLang: "zh-CN" },
    deps,
  );
  assert.ok(whisperCalled, "premature-close must trigger the Whisper fallback");
  assert.equal(r.provider, "whisper");
  assert.equal(r.transcript, "完整的回答内容。");
});
