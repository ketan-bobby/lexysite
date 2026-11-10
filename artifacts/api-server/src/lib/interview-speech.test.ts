import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_LANGUAGES,
  languageInstruction,
  azureChatDeployment,
  resolveLangMeta,
} from "./ai";
import { synthesizeInterviewSpeech, interviewVoice } from "./interview-speech";

test("all offered languages resolve to their own voice and explicit native-language instruction", () => {
  for (const [code, meta] of Object.entries(SUPPORTED_LANGUAGES)) {
    if (meta.hidden) continue;
    const selected = interviewVoice(code);
    assert.equal(resolveLangMeta(code).resolvedKey, code);
    assert.ok(languageInstruction(code).includes(meta.label));
    assert.ok(languageInstruction(code).includes("Preserve JSON keys"));
    assert.equal(
      selected.voice,
      meta.family === "english" ? "en-GB-AdaMultilingualNeural" : meta.azureVoice,
    );
    assert.ok(selected.locale);
  }
});

test("Azure deployment selection handles reversed endpoint/deployment consistently", () => {
  assert.equal(azureChatDeployment({ AZURE_OPENAI_DEPLOYMENT: "chat-model" }), "chat-model");
  assert.equal(
    azureChatDeployment({
      AZURE_OPENAI_DEPLOYMENT: "https://fake-resource.example",
      AZURE_OPENAI_ENDPOINT: "chat-model",
    }),
    "chat-model",
  );
});

test("ElevenLabs-preferred locales use multilingual speech without calling Azure", async () => {
  for (const language of ["fil", "id", "ms"]) {
    const result = await synthesizeInterviewSpeech("Synthetic sample", language, {
      env: { ELEVENLABS_API_KEY: "fake-test-only" },
      fetch: async (url, init) => {
        assert.ok(String(url).includes("elevenlabs.io"));
        assert.equal(JSON.parse(String(init?.body)).model_id, "eleven_multilingual_v2");
        assert.ok(init?.signal);
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    assert.equal(result.provider, "elevenlabs");
    assert.equal(result.audio.length, 3);
  }
});

test("ElevenLabs errors fall through to dedicated Azure, never the STT account", async () => {
  const calls: string[] = [];
  const result = await synthesizeInterviewSpeech("A & B < C", "fil", {
    env: {
      ELEVENLABS_API_KEY: "fake-test-only",
      AZURE_TTS_KEY: "fake-voice-only",
      AZURE_TTS_REGION: "testvoice",
      AZURE_SPEECH_KEY: "fake-recognition-only",
      AZURE_SPEECH_REGION: "testrecognition",
    },
    fetch: async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(null, { status: 401 });
      assert.ok(String(url).includes("testvoice.tts"));
      assert.ok(String(init?.body).includes("A &amp; B &lt; C"));
      assert.ok(String(init?.body).includes("fil-PH-BlessicaNeural"));
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  assert.equal(result.provider, "azure");
  assert.equal(calls.length, 2);
});

test("without Azure accounts, OpenAI speech uses the direct endpoint and stable voice", async () => {
  const result = await synthesizeInterviewSpeech("Synthetic sample", "en-IN", {
    env: { OPENAI_API_KEY: "fake-test-only" },
    fetch: async (url, init) => {
      assert.ok(String(url).startsWith("https://api.openai.com/"));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.voice, "shimmer");
      assert.equal(body.model, "tts-1");
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  assert.equal(result.provider, "openai");
});

test("no usable speech providers fails explicitly", async () => {
  await assert.rejects(
    synthesizeInterviewSpeech("Synthetic sample", "hi", { env: {} }),
    /No working speech provider/,
  );
});

test("Vietnamese prefers its tested native Azure voice even with ElevenLabs configured", async () => {
  const result = await synthesizeInterviewSpeech("Synthetic sample", "vi", {
    env: {
      ELEVENLABS_API_KEY: "fake-test-only",
      AZURE_TTS_KEY: "fake-voice-only",
      AZURE_TTS_REGION: "testvietnamese",
    },
    fetch: async (url, init) => {
      assert.ok(String(url).includes("testvietnamese.tts"));
      assert.ok(String(init?.body).includes("vi-VN-HoaiMyNeural"));
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  assert.equal(result.provider, "azure");
});
