/**
 * schema/index.ts — Drizzle Schema Barrel
 *
 * Re-exports every per-domain schema module (tables, enums, insert/select
 * Zod schemas, and inferred row types) under one namespace. Imported by
 * lib/db/src/index.ts as `import * as schema from "./schema"` and handed to
 * `drizzle(client, { schema })` so the typed query builder and RLS-aware
 * connections see the full table set. Add new schema files here to surface
 * them across the app.
 */
export * from "./tenants";
export * from "./users";
export * from "./jobs";
export * from "./candidates";
export * from "./applications";
export * from "./icp";
export * from "./interviews";
export * from "./outreach";
export * from "./communication";
export * from "./prep";
export * from "./sourcing";
export * from "./verify";
export * from "./talent_match";
export * from "./notifications";
export * from "./intelligence";
export * from "./pipeline";
export * from "./invite_tokens";
export * from "./career_profiles";
export * from "./recommendation_progress";
export * from "./outreach-engine";
export * from "./anti-ghost";
export * from "./talent_pool";
export * from "./hm_share";
export * from "./career_progress";
export * from "./newsletter";
export * from "./staff_invite_tokens";
export * from "./external_clicks";
export * from "./audit";
export * from "./recruiter_digest";
export * from "./outreach_conversation";
export * from "./candidate_rejections";
export * from "./connection-engine";
export * from "./candidate-connection-engine";
export * from "./candidate-import";
export * from "./credit-usage";
export * from "./partners";
export * from "./billing";
export * from "./fee-ledger";
export * from "./subscription-prices";
export * from "./trial-signups";
export * from "./achievements";
export * from "./system-errors";
export * from "./http-access-logs";
export * from "./stt-metrics";
export * from "./market-intel-ask-log";
export * from "./password_reset_tokens";
export * from "./plan-limit-notifications";
export * from "./candidate-demographics";
export * from "./candidate-ai-consent";
export * from "./discovery-consent";
export * from "./linx-requests";
export * from "./deletion-requests";
export * from "./aedt";
export * from "./governance";
export * from "./disclosure-acks";
export * from "./stripe-events";
export * from "./admin-impersonation";
export * from "./ai-brand";
export * from "./ai-workorder";
export * from "./ai-messages";
export * from "./candidate-outcomes";
export * from "./candidate-events";
export * from "./ai-jobs";
export * from "./recruiter-avatar";
export * from "./recruiter-admin-clients";
export * from "./recruiter-managers";
export * from "./job-recruiters";
export * from "./recruiter-mail-accounts";
export * from "./agent-runs";
export * from "./evaluations";
