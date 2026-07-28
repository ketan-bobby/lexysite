/**
 * schema/recruiter-avatar.ts — Recruiter Intro Avatar (HeyGen) — Phase 1
 *
 * ─── Why these tables exist ───────────────────────────────────────────────────
 * Recruiters can record a short (20-30s) talking-avatar welcome that plays to a
 * candidate BEFORE a Lexy interview, then hands off to Lexy. The avatar is built
 * from a single recruiter photo via HeyGen (Talking Photo — no training), speaks
 * a synthetic HeyGen voice (recruiter-picked gender/style, NOT their real voice)
 * and reads an auto-generated script written natively in the candidate's
 * language. The whole feature is best-effort: if anything is missing or fails the
 * interview falls back to pure Lexy and is NEVER blocked.
 *
 * ─── Tables ───────────────────────────────────────────────────────────────────
 *   recruiter_avatar_profiles    — One row per recruiter user. Their photo,
 *                                  HeyGen talking-photo id, chosen voice + tone,
 *                                  consent, and ready/draft/disabled status.
 *   recruiter_intro_scripts      — Cache of generated (language-native) scripts,
 *                                  keyed by a hash of the render context so the
 *                                  same script is reused instead of re-billed.
 *   recruiter_avatar_video_jobs  — One HeyGen render per (profile, photo, voice,
 *                                  language, script). A partial unique index on
 *                                  cacheKey (excluding failed) makes a completed
 *                                  video reusable forever — no wasted credits.
 *
 * ─── Tenant model ─────────────────────────────────────────────────────────────
 * Every row carries tenantId (NOT company_id). Route handlers gate access with
 * getAllowedTenantIds() + a STAFF_ROLES allowlist, mirroring routes/ai-jobs.ts.
 */
import { pgTable, text, timestamp, boolean, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recruiterAvatarStatusEnum = pgEnum("recruiter_avatar_status", [
  "draft",     // created but not yet usable (no photo and/or no consent)
  "ready",     // photo + consent present → eligible to render & play
  "disabled",  // explicitly turned off by the recruiter/admin
]);

export const recruiterAvatarVideoStatusEnum = pgEnum("recruiter_avatar_video_status", [
  "pending",     // row created, render not yet submitted to HeyGen
  "processing",  // submitted; HeyGen is rendering (heygenVideoId set)
  "completed",   // rendered + persisted to our object storage
  "failed",      // permanent failure (excluded from the dedupe unique index)
]);

export const recruiterAvatarProfilesTable = pgTable("recruiter_avatar_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  recruiterUserId: text("recruiter_user_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  /* Our object-storage path for the recruiter photo (/objects/...). The source
     of truth we control — HeyGen asset urls expire, this does not. */
  avatarImageObjectPath: text("avatar_image_object_path"),
  /* HeyGen talking_photo id, lazily created from the photo on first render. */
  heygenTalkingPhotoId: text("heygen_talking_photo_id"),
  /* Explicit voice override; when null we resolve one per language + gender. */
  selectedVoiceId: text("selected_voice_id"),
  voiceGender: text("voice_gender").notNull().default("female"),
  primaryLanguage: text("primary_language").notNull().default("en-US"),
  tone: text("tone").notNull().default("warm_professional"),
  consentConfirmed: boolean("consent_confirmed").notNull().default(false),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  consentVersion: text("consent_version"),
  status: recruiterAvatarStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  /* One avatar profile per recruiter user. */
  recruiterUq: uniqueIndex("recruiter_avatar_profiles_recruiter_uq").on(table.recruiterUserId),
}));

export const recruiterIntroScriptsTable = pgTable("recruiter_intro_scripts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  recruiterAvatarProfileId: text("recruiter_avatar_profile_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id"),
  /* Language the script was authored from (English base) vs the language it is
     actually written in. Translation-ready by construction. */
  sourceLanguage: text("source_language").notNull().default("en-US"),
  language: text("language").notNull(),
  tone: text("tone").notNull().default("warm_professional"),
  scriptText: text("script_text").notNull(),
  /* Hash of the render context (profile, job, language, tone, template version).
     Cache identity: a matching hash reuses the existing script. */
  scriptHash: text("script_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  scriptCacheUq: uniqueIndex("recruiter_intro_scripts_cache_uq").on(table.scriptHash),
}));

export const recruiterAvatarVideoJobsTable = pgTable("recruiter_avatar_video_jobs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  recruiterAvatarProfileId: text("recruiter_avatar_profile_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id"),
  interviewId: text("interview_id"),
  jobId: text("job_id"),
  language: text("language").notNull(),
  scriptText: text("script_text").notNull(),
  scriptHash: text("script_hash").notNull(),
  voiceId: text("voice_id"),
  heygenTalkingPhotoId: text("heygen_talking_photo_id"),
  heygenVideoId: text("heygen_video_id"),
  status: recruiterAvatarVideoStatusEnum("status").notNull().default("pending"),
  /* Our persisted MP4 (/objects/...) — HeyGen output urls expire. */
  outputVideoObjectPath: text("output_video_object_path"),
  /* Transient HeyGen output url, kept for debugging only. */
  outputVideoUrlExternal: text("output_video_url_external"),
  errorMessage: text("error_message"),
  /* Dedupe/cache identity: hash(profile|talkingPhoto|voice|language|scriptHash). */
  cacheKey: text("cache_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  /* At most one LIVE (non-failed) video per cache identity → a completed render
     is reused forever, and a failed one can be retried. Mirrors ai_jobs. */
  cacheLiveUq: uniqueIndex("recruiter_avatar_video_jobs_cache_live_uq")
    .on(table.cacheKey)
    .where(sql`${table.cacheKey} is not null and ${table.status} <> 'failed'`),
}));

export const insertRecruiterAvatarProfileSchema = createInsertSchema(recruiterAvatarProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectRecruiterAvatarProfileSchema = createSelectSchema(recruiterAvatarProfilesTable);
export type RecruiterAvatarProfile = typeof recruiterAvatarProfilesTable.$inferSelect;
export type InsertRecruiterAvatarProfile = z.infer<typeof insertRecruiterAvatarProfileSchema>;
export type RecruiterIntroScript = typeof recruiterIntroScriptsTable.$inferSelect;
export type RecruiterAvatarVideoJob = typeof recruiterAvatarVideoJobsTable.$inferSelect;
export type RecruiterAvatarStatus = (typeof recruiterAvatarStatusEnum.enumValues)[number];
export type RecruiterAvatarVideoStatus = (typeof recruiterAvatarVideoStatusEnum.enumValues)[number];
