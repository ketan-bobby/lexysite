/**
 * Shared OpenAI client for the server-side AI integration.
 * Resolves credentials via shared/openai-config (managed proxy pair, or
 * OPENAI_API_KEY fallback; throws at import time if neither is available)
 * and exports a configured `openai` instance.
 */
import OpenAI from "openai";
import { getOpenAIConfig } from "./shared/openai-config";

const { apiKey, baseURL } = getOpenAIConfig();

export const openai = new OpenAI({ apiKey, baseURL });
