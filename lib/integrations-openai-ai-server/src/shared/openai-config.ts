/**
 * Single source of truth for OpenAI credentials across all server-side
 * integration clients (chat, audio, image).
 *
 * Resolution order:
 * 1. Managed AI-proxy pair (AI_INTEGRATIONS_OPENAI_API_KEY +
 *    AI_INTEGRATIONS_OPENAI_BASE_URL) — auto-provisioned in the hosted
 *    environment. The proxy key is only valid against the proxy base URL,
 *    so the two are used together or not at all.
 * 2. OPENAI_API_KEY (the name defined in the root .env) against OpenAI's
 *    default endpoint — used in local/laptop environments without the proxy.
 */
export interface OpenAIConfig {
  apiKey: string;
  /** undefined = use the OpenAI SDK's default base URL (api.openai.com). */
  baseURL: string | undefined;
}

export function getOpenAIConfig(): OpenAIConfig {
  const proxyKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const proxyBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (proxyKey && proxyBaseURL) {
    return { apiKey: proxyKey, baseURL: proxyBaseURL };
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing OpenAI credentials: set OPENAI_API_KEY, or provide both AI_INTEGRATIONS_OPENAI_API_KEY and AI_INTEGRATIONS_OPENAI_BASE_URL for the managed proxy.",
    );
  }
  return { apiKey: key, baseURL: undefined };
}

export function getOpenAIApiKey(): string {
  return getOpenAIConfig().apiKey;
}
