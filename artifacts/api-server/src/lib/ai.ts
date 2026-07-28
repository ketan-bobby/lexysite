/**
 * ai.ts — Unified AI / LLM Client Layer
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides a single, language-aware interface to all LLM and speech AI services
 * used across the platform. All other files import from here — they never
 * instantiate OpenAI or Azure clients directly.
 *
 * ─── Language routing ────────────────────────────────────────────────────────
 * Lexy supports 40+ languages for AI interviews. The language code passed to
 * each function drives three routing decisions:
 *
 *   1. LLM provider   — most languages use OpenAI (gpt-4o). A subset of
 *                       languages (Arabic, Turkish, Polish, Scandinavian) route
 *                       to Azure OpenAI when configured, falling back to OpenAI.
 *   2. Speech provider — all languages use Azure Neural TTS via synthesizeSpeechAzure()
 *   3. Azure locale/voice — each language maps to a specific BCP-47 locale and
 *                           a named Azure Neural voice (e.g. "en-US-JennyNeural")
 *
 * resolveLangMeta() handles the lookup with two fallback levels:
 *   exact key (e.g. "en-US") → base code (e.g. "gu" from "gu-IN") → "en-US"
 *
 * ─── Three core functions ────────────────────────────────────────────────────
 *   generateWithAI()          Single prompt → string response. Injects a
 *                             language instruction into the system prompt so the
 *                             model always replies in the correct language.
 *
 *   generateJSON<T>()         Wrapper around generateWithAI() that strips
 *                             markdown code fences and parses the result as JSON.
 *                             Used heavily by resume parsers, ICP generators, etc.
 *
 *   chatCompletionWithAI()    Multi-turn message array → string response. Used
 *                             by the interview engine which maintains full
 *                             conversation history in memory.
 *
 *   synthesizeSpeechAzure()   Text → MP3 Buffer via Azure Neural TTS REST API.
 *                             Returns null (graceful degradation) if Azure Speech
 *                             credentials are not configured.
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *   OPENAI_API_KEY                 Primary OpenAI key (required)
 *   AI_INTEGRATIONS_OPENAI_API_KEY Replit-managed OpenAI proxy key (preferred)
 *   AI_INTEGRATIONS_OPENAI_BASE_URL Replit proxy base URL
 *   AZURE_OPENAI_API_KEY           Azure OpenAI key (optional — for Indian/other langs)
 *   AZURE_OPENAI_ENDPOINT          Azure OpenAI endpoint URL
 *   AZURE_OPENAI_DEPLOYMENT        Azure deployment name / model alias
 *   AZURE_SPEECH_KEY               Azure Speech key (for TTS)
 *   AZURE_SPEECH_REGION            Azure Speech region (e.g. "eastus")
 */

import OpenAI, { AzureOpenAI } from "openai";
import { logger } from "./logger";

export type SpeechProvider = "deepgram" | "azure";
export type LlmProvider    = "openai"   | "azure";

export interface LanguageMeta {
  label:          string;
  nativeName:     string;
  family:         string;
  speechProvider: SpeechProvider;
  llmProvider:    LlmProvider;
  region:         "indian" | "global";
  azureLocale:    string;   // BCP-47 for Azure Speech API, e.g. "gu-IN"
  azureVoice:     string;   // Azure Neural voice name
  hidden?:        boolean;  // resolvable alias, but not offered in the picker
  /** Preferred TTS vendor when Azure has no good voice for the language.
      "elevenlabs" → /interviews/tts tries ElevenLabs multilingual first,
      then falls through the normal Azure → OpenAI chain. */
  ttsProvider?:   "elevenlabs";
  /** ISO-639-1 hint for Whisper/gpt-4o-transcribe when it differs from the
      language key's base code (e.g. "fil" → Whisper knows it as "tl"). */
  whisperLang?:   string;
}

export const SUPPORTED_LANGUAGES: Record<string, LanguageMeta> = {

  // ── English variants ─────────────────────────────────────────────────────────
  "en-US": { label: "English (United States)",  nativeName: "English (US)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-US", azureVoice: "en-US-JennyNeural"     },
  "en-GB": { label: "English (United Kingdom)", nativeName: "English (UK)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-GB", azureVoice: "en-GB-SoniaNeural"     },
  "en-AU": { label: "English (Australia)",      nativeName: "English (AU)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-AU", azureVoice: "en-AU-NatashaNeural"   },
  "en-IN": { label: "English (India)",          nativeName: "English (IN)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-IN", azureVoice: "en-IN-NeerjaNeural"    },
  "en-CA": { label: "English (Canada)",         nativeName: "English (CA)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-CA", azureVoice: "en-CA-ClaraNeural"     },
  "en-NZ": { label: "English (New Zealand)",    nativeName: "English (NZ)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-NZ", azureVoice: "en-NZ-MollyNeural"     },
  "en-ZA": { label: "English (South Africa)",   nativeName: "English (ZA)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-ZA", azureVoice: "en-ZA-LeahNeural"      },
  "en-SG": { label: "English (Singapore)",      nativeName: "English (SG)",  family: "english",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "en-SG", azureVoice: "en-SG-LunaNeural"      },

  // ── Spanish variants ─────────────────────────────────────────────────────────
  "es-ES": { label: "Spanish (Spain)",          nativeName: "Español (ES)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-ES", azureVoice: "es-ES-ElviraNeural"    },
  "es-MX": { label: "Spanish (Mexico)",         nativeName: "Español (MX)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-MX", azureVoice: "es-MX-DaliaNeural"     },
  "es-AR": { label: "Spanish (Argentina)",      nativeName: "Español (AR)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-AR", azureVoice: "es-AR-ElenaNeural"     },
  "es-CO": { label: "Spanish (Colombia)",       nativeName: "Español (CO)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-CO", azureVoice: "es-CO-SalomeNeural"    },
  "es-US": { label: "Spanish (United States)",  nativeName: "Español (US)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-US", azureVoice: "es-US-PalomaNeural"    },
  "es-CL": { label: "Spanish (Chile)",          nativeName: "Español (CL)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-CL", azureVoice: "es-CL-CatalinaNeural"  },
  "es-PE": { label: "Spanish (Peru)",           nativeName: "Español (PE)",  family: "spanish",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "es-PE", azureVoice: "es-PE-CamilaNeural"    },

  // ── Indian languages ─────────────────────────────────────────────────────────
  hi:  { label: "Hindi",     nativeName: "हिन्दी",    family: "hindi",     speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "hi-IN", azureVoice: "hi-IN-SwaraNeural"      },
  bn:  { label: "Bengali",   nativeName: "বাংলা",     family: "bengali",   speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "bn-IN", azureVoice: "bn-IN-TanishaaNeural"   },
  ta:  { label: "Tamil",     nativeName: "தமிழ்",     family: "tamil",     speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "ta-IN", azureVoice: "ta-IN-PallaviNeural"    },
  te:  { label: "Telugu",    nativeName: "తెలుగు",    family: "telugu",    speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "te-IN", azureVoice: "te-IN-ShrutiNeural"     },
  mr:  { label: "Marathi",   nativeName: "मराठी",     family: "marathi",   speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "mr-IN", azureVoice: "mr-IN-AarohiNeural"     },
  gu:  { label: "Gujarati",  nativeName: "ગુજરાતી",   family: "gujarati",  speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "gu-IN", azureVoice: "gu-IN-DhwaniNeural"     },
  kn:  { label: "Kannada",   nativeName: "ಕನ್ನಡ",     family: "kannada",   speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "kn-IN", azureVoice: "kn-IN-SapnaNeural"      },
  ml:  { label: "Malayalam", nativeName: "മലയാളം",    family: "malayalam", speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "ml-IN", azureVoice: "ml-IN-SobhanaNeural"    },
  pa:  { label: "Punjabi",   nativeName: "ਪੰਜਾਬੀ",    family: "punjabi",   speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "pa-IN", azureVoice: "pa-IN-OjasNeural"       },
  or:  { label: "Odia",      nativeName: "ଓଡ଼ିଆ",     family: "odia",      speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "or-IN", azureVoice: "or-IN-SubhasiniNeural"  },
  ur:  { label: "Urdu",      nativeName: "اردو",       family: "urdu",      speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "ur-PK", azureVoice: "ur-PK-UzmaNeural"       },
  as:  { label: "Assamese",  nativeName: "অসমীয়া",   family: "assamese",  speechProvider: "azure", llmProvider: "openai", region: "indian", azureLocale: "as-IN", azureVoice: "as-IN-YashicaNeural"    },

  // ── Other global languages ───────────────────────────────────────────────────
  fr:  { label: "French",     nativeName: "Français",   family: "french",     speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "fr-FR", azureVoice: "fr-FR-DeniseNeural"   },
  de:  { label: "German",     nativeName: "Deutsch",    family: "german",     speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "de-DE", azureVoice: "de-DE-KatjaNeural"    },
  it:  { label: "Italian",    nativeName: "Italiano",   family: "italian",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "it-IT", azureVoice: "it-IT-ElsaNeural"     },
  pt:      { label: "Portuguese (Brazil)",   nativeName: "Português (Brasil)",   family: "portuguese", speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "pt-BR", azureVoice: "pt-BR-FranciscaNeural", hidden: true },
  "pt-BR": { label: "Portuguese (Brazil)",   nativeName: "Português (Brasil)",   family: "portuguese", speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "pt-BR", azureVoice: "pt-BR-FranciscaNeural" },
  "pt-PT": { label: "Portuguese (Portugal)", nativeName: "Português (Portugal)", family: "portuguese", speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "pt-PT", azureVoice: "pt-PT-RaquelNeural" },
  /* Filipino: Azure has a fil-PH voice but it reads flat — ElevenLabs
     multilingual is the primary voice; STT goes to gpt-4o-transcribe with the
     "tl" (Tagalog) hint. Both "fil" and "tl" resolve here. */
  fil: { label: "Filipino",   nativeName: "Filipino",   family: "filipino",   speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "fil-PH", azureVoice: "fil-PH-BlessicaNeural", ttsProvider: "elevenlabs", whisperLang: "tl" },
  tl:  { label: "Filipino",   nativeName: "Filipino",   family: "filipino",   speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "fil-PH", azureVoice: "fil-PH-BlessicaNeural", ttsProvider: "elevenlabs", whisperLang: "tl", hidden: true },
  /* ASEAN + Middle East (regional model table): STT = gpt-4o-transcribe;
     TTS = ElevenLabs multilingual where it supports the language (id/ms/vi,
     like fil), Azure neural where it doesn't (th/he). */
  id:  { label: "Indonesian", nativeName: "Bahasa Indonesia", family: "indonesian", speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "id-ID", azureVoice: "id-ID-GadisNeural",    ttsProvider: "elevenlabs" },
  ms:  { label: "Malay",      nativeName: "Bahasa Melayu",    family: "malay",      speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "ms-MY", azureVoice: "ms-MY-YasminNeural",   ttsProvider: "elevenlabs" },
  th:  { label: "Thai",       nativeName: "ไทย",              family: "thai",       speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "th-TH", azureVoice: "th-TH-PremwadeeNeural" },
  vi:  { label: "Vietnamese", nativeName: "Tiếng Việt",       family: "vietnamese", speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "vi-VN", azureVoice: "vi-VN-HoaiMyNeural",   ttsProvider: "elevenlabs" },
  he:  { label: "Hebrew",     nativeName: "עברית",            family: "hebrew",     speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "he-IL", azureVoice: "he-IL-HilaNeural"      },
  nl:  { label: "Dutch",      nativeName: "Nederlands", family: "dutch",      speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "nl-NL", azureVoice: "nl-NL-ColetteNeural"  },
  ru:  { label: "Russian",    nativeName: "Русский",    family: "russian",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "ru-RU", azureVoice: "ru-RU-SvetlanaNeural" },
  zh:  { label: "Chinese",    nativeName: "中文",        family: "chinese",    speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "zh-CN", azureVoice: "zh-CN-XiaoxiaoNeural" },
  ja:  { label: "Japanese",   nativeName: "日本語",      family: "japanese",   speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "ja-JP", azureVoice: "ja-JP-NanamiNeural"   },
  ko:  { label: "Korean",     nativeName: "한국어",      family: "korean",     speechProvider: "azure", llmProvider: "openai", region: "global", azureLocale: "ko-KR", azureVoice: "ko-KR-SunHiNeural"    },
  ar:  { label: "Arabic",     nativeName: "العربية",    family: "arabic",     speechProvider: "azure", llmProvider: "azure", region: "global", azureLocale: "ar-SA", azureVoice: "ar-SA-ZariyahNeural"  },
  tr:  { label: "Turkish",    nativeName: "Türkçe",     family: "turkish",    speechProvider: "azure", llmProvider: "azure", region: "global", azureLocale: "tr-TR", azureVoice: "tr-TR-EmelNeural"     },
  pl:  { label: "Polish",     nativeName: "Polski",     family: "polish",     speechProvider: "azure", llmProvider: "azure", region: "global", azureLocale: "pl-PL", azureVoice: "pl-PL-ZofiaNeural"    },
  sv:  { label: "Swedish",    nativeName: "Svenska",    family: "swedish",    speechProvider: "azure", llmProvider: "azure", region: "global", azureLocale: "sv-SE", azureVoice: "sv-SE-SofieNeural"    },
  no:  { label: "Norwegian",  nativeName: "Norsk",      family: "norwegian",  speechProvider: "azure", llmProvider: "azure", region: "global", azureLocale: "nb-NO", azureVoice: "nb-NO-PernilleNeural" },
  da:  { label: "Danish",     nativeName: "Dansk",      family: "danish",     speechProvider: "azure", llmProvider: "azure", region: "global", azureLocale: "da-DK", azureVoice: "da-DK-ChristelNeural" },
};

// ── Language resolver — handles "gu-IN" → "gu", "es-MX" → keep, etc. ─────────

export function resolveLangMeta(language: string): LanguageMeta & { resolvedKey: string } {
  /* Try exact key first (e.g. "en-US", "es-MX") */
  if (SUPPORTED_LANGUAGES[language]) {
    return { ...SUPPORTED_LANGUAGES[language], resolvedKey: language };
  }
  /* Try base code (e.g. "gu-IN" → "gu", "fr-CA" → "fr") */
  const base = language.split("-")[0].toLowerCase();
  if (SUPPORTED_LANGUAGES[base]) {
    return { ...SUPPORTED_LANGUAGES[base], resolvedKey: base };
  }
  /* Final fallback */
  return { ...SUPPORTED_LANGUAGES["en-US"], resolvedKey: "en-US" };
}

// ── Clients ────────────────────────────────────────────────────────────────────

const openaiClient = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

function getAzureClient(): AzureOpenAI | null {
  const key = process.env.AZURE_OPENAI_API_KEY;
  let endpoint   = process.env.AZURE_OPENAI_ENDPOINT   ?? "";
  let deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "";
  if (!key || !endpoint || !deployment) return null;

  /* Auto-correct: the two secrets are sometimes entered in reverse order.
     The endpoint must be a URL; the deployment is a model/deployment name. */
  if (deployment.startsWith("http") && !endpoint.startsWith("http")) {
    [endpoint, deployment] = [deployment, endpoint];
  }

  return new AzureOpenAI({ apiKey: key, endpoint, deployment, apiVersion: "2024-12-01-preview" });
}

export function deepgramConfigured(): boolean {
  return !!process.env.DEEPGRAM_API_KEY;
}

export function azureConfigured(): boolean {
  return !!(
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

export function azureSpeechConfigured(): boolean {
  return !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

// ── Text embeddings ───────────────────────────────────────────────────────────
/* Profile/text embeddings power the similar-hire pattern signal (kNN cosine
 * similarity of a candidate against a tenant's real successful hires). One small
 * model, fixed dimensionality, so every stored vector is comparable. */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS  = 1536;

/**
 * Embed a single text into a fixed-length vector. Returns null on any failure
 * (no API key, provider error, empty input) so callers degrade gracefully —
 * embedding is always best-effort and must never break a request. Deterministic
 * for a given input on the embedding model.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const input = (text ?? "").trim();
  if (!input) return null;
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    logger.warn("generateEmbedding: no OpenAI API key configured — skipping");
    return null;
  }
  try {
    const resp = await openaiClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input,
    });
    const vec = resp.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) return null;
    return vec as number[];
  } catch (err: any) {
    logger.warn({ err: err?.message }, "generateEmbedding failed");
    return null;
  }
}

// ── Core LLM call — routes based on language ──────────────────────────────────

export async function generateWithAI(
  prompt: string,
  systemPrompt?: string,
  language = "en-US",
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const meta      = resolveLangMeta(language);
  const langLabel = meta.label;
  const llmTarget = meta.llmProvider;

  const langInstruction = `You must respond entirely in ${langLabel}. All questions, summaries, and output must be written in ${langLabel}.`;
  const fullSystem = systemPrompt
    ? `${systemPrompt}\n\n${langInstruction}`
    : langInstruction;

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: fullSystem },
    { role: "user",   content: prompt },
  ];

  const maxTokens = opts.maxTokens ?? 4096;

  if (llmTarget === "azure") {
    const azure = getAzureClient();
    if (azure) {
      try {
        logger.info({ language, llm: "azure" }, "LLM → Azure OpenAI");
        const resp = await azure.chat.completions.create({
          model: process.env.AZURE_OPENAI_DEPLOYMENT!.startsWith("http")
            ? process.env.AZURE_OPENAI_ENDPOINT!     /* swapped: endpoint has model name */
            : process.env.AZURE_OPENAI_DEPLOYMENT!,
          max_tokens: maxTokens,
          messages,
        });
        return resp.choices[0]?.message?.content ?? "";
      } catch (azureErr: any) {
        logger.warn({ language, err: azureErr?.message }, "Azure OpenAI failed — falling back to OpenAI");
      }
    } else {
      logger.warn({ language }, "Azure not configured — falling back to OpenAI");
    }
  }

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const model = opts.model ?? "gpt-4o";
  logger.info({ language, llm: "openai", model }, "LLM → OpenAI");
  const resp = await openaiClient.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
  });
  return resp.choices[0]?.message?.content ?? "";
}

/* JSON / scoring / structured-output mode.
 *
 * For determinism in scoring + agent decisions, this helper now drives the
 * underlying model with temperature 0 by default — repeated calls with the
 * same prompt return the same JSON. Callers that want creative variation
 * (rare for JSON output) can override via opts.temperature.
 *
 * `seed` is forwarded when supplied; OpenAI/Azure both honor a seed for
 * best-effort reproducibility on supported models. */
export async function generateJSON<T = Record<string, any>>(
  prompt: string,
  systemPrompt?: string,
  language = "en-US",
  opts: { temperature?: number; seed?: number } = {},
): Promise<T> {
  const raw     = await chatCompletionWithAI(
    [
      { role: "system", content: systemPrompt ?? "Respond with valid JSON only — no markdown fences, no commentary." },
      { role: "user",   content: prompt },
    ],
    language,
    {
      temperature: opts.temperature ?? 0,
      seed: opts.seed ?? 42,
    },
  );
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned) as T;
}

// ── Multi-turn chat — routes to Azure for Indian languages ────────────────────
export async function chatCompletionWithAI(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  language = "en-US",
  options: { maxTokens?: number; temperature?: number; seed?: number } = {},
): Promise<string> {
  const meta = resolveLangMeta(language);

  if (meta.llmProvider === "azure") {
    const azure = getAzureClient();
    if (azure) {
      try {
        logger.info({ language, llm: "azure" }, "LLM chat → Azure OpenAI");
        const resp = await azure.chat.completions.create({
          model: process.env.AZURE_OPENAI_DEPLOYMENT!,
          max_tokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.8,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          messages,
        });
        return resp.choices[0]?.message?.content ?? "";
      } catch (err: any) {
        logger.warn({ language, err: err?.message }, "Azure OpenAI chat failed — falling back to OpenAI");
      }
    } else {
      logger.warn({ language }, "Azure not configured — falling back to OpenAI");
    }
  }

  const resp = await openaiClient.chat.completions.create({
    model: "gpt-4o",
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.8,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    messages,
  });
  return resp.choices[0]?.message?.content ?? "";
}

// ── Azure Speech REST TTS ─────────────────────────────────────────────────────
export async function synthesizeSpeechAzure(
  text: string,
  azureLocale: string,
  azureVoice: string,
): Promise<Buffer | null> {
  const key    = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return null;

  /* Escape XML special chars */
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const ssml = `<speak version='1.0' xml:lang='${azureLocale}'><voice xml:lang='${azureLocale}' name='${azureVoice}'>${escaped}</voice></speak>`;

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
    },
    body: ssml,
  });

  if (!response.ok) {
    logger.warn({ status: response.status, azureLocale, azureVoice }, "Azure TTS failed");
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}
