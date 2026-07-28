/**
 * discovery-optin-test-env.ts — TEST-ONLY side-effect module.
 *
 * Imported FIRST by platform-pool-discovery-optin.test.ts so the OpenAI
 * clients (constructed at module load in lib/ai.ts and career-profile.ts)
 * point at the local mock AI server instead of the real API. The interview-
 * completion regression test can then exercise the REAL
 * POST /portal/career-interview/complete route end-to-end without network
 * calls or spend, proving it no longer auto-promotes to pool='platform'.
 *
 * Never imported by production code.
 */
export const MOCK_AI_PORT = 45871;
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = `http://127.0.0.1:${MOCK_AI_PORT}/v1`;
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-mock-key";
/* Force the pure-OpenAI branch in chatCompletionWithAI (no Azure fallback). */
delete process.env.AZURE_OPENAI_API_KEY;
