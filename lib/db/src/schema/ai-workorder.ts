/**
 * schema/ai-workorder.ts — Workorder (Job) AI Context Intelligence
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   workorder_ai_contexts  — 1:1 with a job. Per-role context that AI message
 *                            generation prioritises OVER the tenant brand profile
 *                            on conflict: why the role exists, team, tech stack,
 *                            selling points, concerns, messaging angle, etc.
 *   workorder_ai_documents — Per-job uploaded docs (storage key + distilled brief).
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   ai_urgency — low · medium · high · critical
 *
 * Reuses `workTypeEnum` (remote/hybrid/onsite) and `aiDocTypeEnum` rather than
 * redefining parallel enums.
 */
import { pgTable, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workTypeEnum } from "./jobs";
import { aiDocTypeEnum } from "./ai-brand";

export const aiUrgencyEnum = pgEnum("ai_urgency", ["low", "medium", "high", "critical"]);

export const workorderAiContextsTable = pgTable("workorder_ai_contexts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** 1:1 with jobs.id — at most one AI context per workorder. */
  jobId: text("job_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  projectName: text("project_name"),
  department: text("department"),
  hiringManager: text("hiring_manager"),
  whyRoleExists: text("why_role_exists"),
  businessProblem: text("business_problem"),
  teamDescription: text("team_description"),
  projectDescription: text("project_description"),
  techStack: text("tech_stack"),
  mustHaveSkills: text("must_have_skills"),
  niceToHaveSkills: text("nice_to_have_skills"),
  candidateSellingPoints: text("candidate_selling_points"),
  candidateConcerns: text("candidate_concerns"),
  interviewProcess: text("interview_process"),
  compensationNotes: text("compensation_notes"),
  workModel: workTypeEnum("work_model"),
  urgencyLevel: aiUrgencyEnum("urgency_level"),
  hiringManagerPreferences: text("hiring_manager_preferences"),
  messagingAngle: text("messaging_angle"),
  /** Free-text role-specific instructions for the AI. Treated as data. */
  aiInstructions: text("ai_instructions"),
  updatedById: text("updated_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const workorderAiDocumentsTable = pgTable("workorder_ai_documents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  jobId: text("job_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  docType: aiDocTypeEnum("doc_type").notNull().default("workorder_doc"),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  contentType: text("content_type"),
  distilledBrief: text("distilled_brief"),
  uploadedById: text("uploaded_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWorkorderAiContextSchema = createInsertSchema(workorderAiContextsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectWorkorderAiContextSchema = createSelectSchema(workorderAiContextsTable);
export type InsertWorkorderAiContext = z.infer<typeof insertWorkorderAiContextSchema>;
export type WorkorderAiContext = typeof workorderAiContextsTable.$inferSelect;

export const insertWorkorderAiDocumentSchema = createInsertSchema(workorderAiDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectWorkorderAiDocumentSchema = createSelectSchema(workorderAiDocumentsTable);
export type InsertWorkorderAiDocument = z.infer<typeof insertWorkorderAiDocumentSchema>;
export type WorkorderAiDocument = typeof workorderAiDocumentsTable.$inferSelect;
