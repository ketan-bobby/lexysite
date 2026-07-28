/**
 * ai-provider.ts — Region-aware AI provider adapter (Phase 0 skeleton)
 *
 * Every new AI call site should go through `aiForRegion(region)` rather
 * than importing `lib/ai.ts` directly. Today the adapter returns the same
 * OpenAI-backed helpers for every region — but once Phase 1 ships, the
 * `in` branch will route to Azure OpenAI India South (or whichever EU /
 * other regional deployment we wire up next) without any caller change.
 *
 * The contract is intentionally narrow: the three functions the codebase
 * actually uses (generateWithAI, generateJSON, chatCompletionWithAI) plus
 * speech synthesis. Anything beyond that we add as needed.
 *
 * ── Why this exists in Phase 0 ──────────────────────────────────────────
 *
 * Sub-processor residency is a real GDPR / DPDP gap that's easy to forget
 * if we sprinkle `import { generateJSON } from "./ai"` everywhere. Forcing
 * new code through the adapter means the day we stand up Azure OpenAI in
 * Mumbai, switching IN tenants over is a one-file change instead of an
 * audit of every AI call across the codebase.
 */
import type { Region } from "./region";
import * as ai from "./ai";

export interface RegionAI {
  region: Region;
  generateWithAI: typeof ai.generateWithAI;
  generateJSON: typeof ai.generateJSON;
  chatCompletionWithAI: typeof ai.chatCompletionWithAI;
  synthesizeSpeechAzure: typeof ai.synthesizeSpeechAzure;
}

/**
 * Return an AI client bound to the given region. Today every region maps
 * to the same OpenAI-primary implementation in lib/ai.ts; the region is
 * tagged on the returned object so call sites + logs can attribute usage.
 *
 * Phase 1: `in` will resolve to an Azure OpenAI India South client; `eu`
 * to Azure OpenAI France Central; etc. Sub-processor lists per region
 * will be exposed alongside.
 */
export function aiForRegion(region: Region): RegionAI {
  return {
    region,
    generateWithAI: ai.generateWithAI,
    generateJSON: ai.generateJSON,
    chatCompletionWithAI: ai.chatCompletionWithAI,
    synthesizeSpeechAzure: ai.synthesizeSpeechAzure,
  };
}
