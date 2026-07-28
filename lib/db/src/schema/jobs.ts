/**
 * schema/jobs.ts — Job (Work Order) Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   jobs   — One row per job requisition / work order. Stores the full JD,
 *            salary range, location, work type, pipeline configuration, and
 *            status. The job is the central entity that links candidates,
 *            applications, ICP, interview plans, and outreach campaigns.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   job_status      — draft · active · paused · closed · pending_approval · rejected
 *   work_type       — remote · hybrid · onsite
 *   employment_type — full_time · part_time · contract · internship
 *   jd_source       — ai · paste · upload
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/jobs.ts         — full CRUD and work-order numbering
 *   routes/pipeline.ts     — pipeline canvas reads job config
 *   lib/intelligence.ts    — scoring context
 */
import { pgTable, text, timestamp, integer, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobStatusEnum = pgEnum("job_status", ["draft", "active", "paused", "closed", "pending_approval", "rejected", "published"]);
export const workTypeEnum = pgEnum("work_type", ["remote", "hybrid", "onsite"]);
export const employmentTypeEnum = pgEnum("employment_type", ["full_time", "part_time", "contract", "internship"]);
export const jdSourceEnum = pgEnum("jd_source", ["ai", "paste", "upload"]);

export const jobsTable = pgTable("jobs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workOrderNumber: text("work_order_number").unique(),
  /* Client's own work order / requisition number inherited from the client's
   * external system. Optional, free-text, and NOT unique (client numbering
   * schemes vary and may collide across clients). Distinct from the
   * Lexy-generated workOrderNumber above, which stays the internal identifier. */
  clientWorkOrderNumber: text("client_work_order_number"),
  tenantId: text("tenant_id").notNull(),
  subClientId: text("sub_client_id"),
  createdById: text("created_by_id"),
  title: text("title").notNull(),
  department: text("department"),
  location: text("location"),
  workType: workTypeEnum("work_type"),
  employmentType: employmentTypeEnum("employment_type"),
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  description: text("description").notNull(),
  jdSource: jdSourceEnum("jd_source"),
  jdFileName: text("jd_file_name"),
  language: text("language").notNull().default("en"),
  isConfidential: boolean("is_confidential").notNull().default(false),
  assignedRecruiterId: text("assigned_recruiter_id"),
  assignedHiringManagerId: text("assigned_hiring_manager_id"),
  approvedById: text("approved_by_id"),
  rejectionNote: text("rejection_note"),
  status: jobStatusEnum("status").notNull().default("active"),
  platformRecommendationsEnabled: boolean("platform_recommendations_enabled").notNull().default(false),
  /* NYC Local Law 144 (AEDT) flags. Set by tenant; when enabled,
   * candidate-facing notice page renders and 10-business-day notice
   * clock starts at aedtNoticePublishedAt. Auditor exports join on
   * jobId where aedtEnabled = true. See lib/db/drizzle/0015_*.sql. */
  aedtEnabled: boolean("aedt_enabled").notNull().default(false),
  aedtNoticePublishedAt: timestamp("aedt_notice_published_at", { withTimezone: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
/* DB row schema — the runtime counterpart to `typeof jobsTable.$inferSelect`.
 * This represents the row as it sits in Postgres (timestamps as `Date`,
 * every column included). It is NOT the API response shape: routes
 * routinely convert `Date → ISO string` and drop server-only fields before
 * returning. Use this for query-result validation in tests and tooling;
 * the API parity check in @workspace/api-zod is the source of truth for
 * the wire shape. */
export const selectJobSchema = createSelectSchema(jobsTable);
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
