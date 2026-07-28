/**
 * schema/ai-brand.ts — Tenant Brand Intelligence
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   tenant_ai_brand_profiles — 1:1 with a tenant. The brand "voice" that every
 *                              AI-generated message draws from: overview, mission,
 *                              values, EVP, tone, words to use/avoid, boilerplate.
 *                              `aiMessagingEnabled` is the per-tenant kill switch.
 *   tenant_ai_documents       — Uploaded tenant knowledge sources (brand guide,
 *                              values doc, benefits guide, etc.). Stored in object
 *                              storage; `distilledBrief` is a bounded summary that
 *                              is what actually gets injected into prompts.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   ai_tone     — formal · warm · direct · premium · technical · conversational
 *   ai_doc_type — brand_guide · values_document · benefits_guide · company_deck ·
 *                 careers_page · job_family · hiring_guidelines · workorder_doc · other
 *
 * Briefs (never raw documents) are injected into prompts, and uploaded text is
 * always treated as data — never as instructions (prompt-injection safety).
 */
import { pgTable, text, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiToneEnum = pgEnum("ai_tone", [
  "formal",
  "warm",
  "direct",
  "premium",
  "technical",
  "conversational",
]);

export const aiDocTypeEnum = pgEnum("ai_doc_type", [
  "brand_guide",
  "values_document",
  "benefits_guide",
  "company_deck",
  "careers_page",
  "job_family",
  "hiring_guidelines",
  "workorder_doc",
  "other",
]);

export const tenantAiBrandProfilesTable = pgTable("tenant_ai_brand_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** 1:1 with tenants.id — at most one brand profile per tenant. */
  tenantId: text("tenant_id").notNull().unique(),
  companyName: text("company_name"),
  website: text("website"),
  industry: text("industry"),
  companyOverview: text("company_overview"),
  employerBrandStatement: text("employer_brand_statement"),
  mission: text("mission"),
  values: text("values"),
  cultureNotes: text("culture_notes"),
  deiStatement: text("dei_statement"),
  candidateValueProp: text("candidate_value_proposition"),
  /** Default brand tone. Per-message generation may override. */
  toneOfVoice: aiToneEnum("tone_of_voice"),
  wordsToUse: text("words_to_use"),
  wordsToAvoid: text("words_to_avoid"),
  approvedBoilerplate: text("approved_boilerplate"),
  benefitsSummary: text("benefits_summary"),
  careersUrl: text("careers_url"),
  brandGuideUrl: text("brand_guide_url"),
  /** Per-tenant kill switch — when false, AI message generation is blocked. */
  aiMessagingEnabled: boolean("ai_messaging_enabled").notNull().default(true),
  updatedById: text("updated_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tenantAiDocumentsTable = pgTable("tenant_ai_documents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  docType: aiDocTypeEnum("doc_type").notNull().default("other"),
  fileName: text("file_name").notNull(),
  /** Object-storage key/path for the raw uploaded file. */
  storageKey: text("storage_key").notNull(),
  contentType: text("content_type"),
  /** Bounded LLM summary produced at upload time — this (not the raw doc) is
   *  what gets injected into prompts. Null until distillation completes. */
  distilledBrief: text("distilled_brief"),
  uploadedById: text("uploaded_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTenantAiBrandProfileSchema = createInsertSchema(tenantAiBrandProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectTenantAiBrandProfileSchema = createSelectSchema(tenantAiBrandProfilesTable);
export type InsertTenantAiBrandProfile = z.infer<typeof insertTenantAiBrandProfileSchema>;
export type TenantAiBrandProfile = typeof tenantAiBrandProfilesTable.$inferSelect;

export const insertTenantAiDocumentSchema = createInsertSchema(tenantAiDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectTenantAiDocumentSchema = createSelectSchema(tenantAiDocumentsTable);
export type InsertTenantAiDocument = z.infer<typeof insertTenantAiDocumentSchema>;
export type TenantAiDocument = typeof tenantAiDocumentsTable.$inferSelect;
