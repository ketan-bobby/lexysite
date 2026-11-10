import OpenAI from "openai";
import { resolveLangMeta } from "./ai";
import { getTtsAccounts, pickAccount, noteFailure, noteSuccess } from "./azure-pool";
import { logger } from "./logger";
import { meteredFetch } from "./vendor-usage";

export type InterviewVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
export interface SpeechOptions {
  openaiVoice?: InterviewVoice;
  openaiModel?: "tts-1" | "tts-1-hd";
  /** Dependency injection for offline routing tests. Never accepts caller credentials. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export function interviewVoice(language: string) {
  const meta = resolveLangMeta(language);
  return {
    meta,
    voice: meta.family === "english" ? "en-GB-AdaMultilingualNeural" : meta.azureVoice,
    locale: meta.family === "english" ? "en-GB" : meta.azureLocale,
  };
}

/** One bounded voice chain for BOTH job and career interviews. Dedicated Azure
 * credentials remain separate from STT; OpenAI stays the final fallback. */
export async function synthesizeInterviewSpeech(
  text: string,
  language: string,
  options: SpeechOptions = {},
): Promise<{ audio: Buffer; provider: "azure" | "elevenlabs" | "openai" }> {
  const env = options.env ?? process.env;
  const { meta, voice, locale } = interviewVoice(language);
  const providerFetch = (provider: "azure_tts" | "elevenlabs") =>
    options.fetch ??
    meteredFetch(provider, undefined, undefined, {
      inputCharacters: [...text].length,
    });
  const readAudio = async (response: Response) => {
    if (!response.ok) throw new Error(`Speech provider HTTP ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new Error("Speech provider returned empty audio");
    return audio;
  };

  if (meta.ttsProvider === "elevenlabs" && env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = env.ELEVENLABS_TTS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
      const response = await providerFetch("elevenlabs")(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_96`,
        {
          method: "POST",
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
          signal: AbortSignal.timeout(9000),
        },
      );
      return { audio: await readAudio(response), provider: "elevenlabs" };
    } catch {
      logger.warn({ language }, "[TTS] ElevenLabs unavailable — trying Azure/OpenAI");
    }
  }

  const picked = pickAccount("tts", getTtsAccounts(env));
  if (picked) {
    try {
      const { key, region } = picked.account;
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${voice}'><prosody rate='-7%' pitch='-3%'>${escaped}</prosody></voice></speak>`;
      const response = await providerFetch("azure_tts")(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
          },
          body: ssml,
          signal: AbortSignal.timeout(8000),
        },
      );
      const audio = await readAudio(response);
      noteSuccess(picked.breakerKey);
      return { audio, provider: "azure" };
    } catch {
      noteFailure(picked.breakerKey, picked.account.id);
      logger.warn(
        { language, account: picked.account.id },
        "[TTS] Azure unavailable — trying OpenAI",
      );
    }
  }

  const apiKey = env.OPENAI_API_KEY ?? env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) throw new Error("No working speech provider is configured");
  const client = new OpenAI({
    apiKey,
    timeout: 12000,
    maxRetries: 1,
    fetch: options.fetch ?? meteredFetch("openai_direct"),
  });
  const response = await client.audio.speech.create({
    model: options.openaiModel ?? "tts-1",
    voice: options.openaiVoice ?? "shimmer",
    input: text,
  });
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("OpenAI returned empty audio");
  return { audio, provider: "openai" };
}
