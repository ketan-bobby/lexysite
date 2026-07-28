/**
 * schema/hm_share.ts — Hiring-Manager Share Packages
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   hiring_manager_shares  — One row per recipient when a recruiter emails a
 *                            branded candidate "profile package" to a hiring
 *                            manager who has no Lexy login. Each row carries a
 *                            signed, expiring token that powers a no-login web
 *                            view, a snapshot of exactly what the recruiter chose
 *                            to include, a brand snapshot, and the hiring
 *                            manager's decision (advance / interview / pass) fed
 *                            back into the recruiter's pipeline.
 *
 * ─── Security model ──────────────────────────────────────────────────────────
 *   • The public web view + decision endpoints live under /api/public/* (no auth)
 *     and authorise SOLELY by the unguessable `token` + `expires_at`.
 *   • The authed create route gates by recruiter staff role + data scope before
 *     a row is ever written; `tenant_id` is the recruiter's tenant so pipeline
 *     feedback (inbox / events) stays tenant-scoped.
 *   • Snapshots are point-in-time copies so a later candidate edit never silently
 *     changes what a hiring manager was shown.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/hm-share.ts                          — authed create/send + list
 *   routes/hm-share.ts (public sub-router)      — no-login view + decision
 *   components/share/SendToHiringManagerModal.tsx
 *   pages/hm-package.tsx                         — public branded view
 */
import { pgTable, text, timestamp, jsonb, boolean, integer, pgEnum } from "drizzle-orm/pg-core";

/** Hiring-manager decision returned from the no-login link. */
export const hmShareDecisionEnum = pgEnum("hm_share_decision", [
  "advance",
  "interview",
  "pass",
]);

export type HmShareDecision = (typeof hmShareDecisionEnum.enumValues)[number];

export const hiringManagerSharesTable = pgTable("hiring_manager_shares", {
  id:                text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** Unguessable signed token embedded in the link — the sole authZ for public routes. */
  token:             text("token").notNull().unique().$defaultFn(() => crypto.randomUUID()),

  // ── Ownership / scoping ──────────────────────────────────────────────────
  tenantId:          text("tenant_id").notNull(),
  candidateId:       text("candidate_id").notNull(),
  jobId:             text("job_id"),
  applicationId:     text("application_id"),
  createdByUserId:   text("created_by_user_id"),

  // ── Recipient ────────────────────────────────────────────────────────────
  recipientEmail:    text("recipient_email").notNull(),
  recipientName:     text("recipient_name"),

  // ── Per-send inclusion toggles ───────────────────────────────────────────
  includeContact:    boolean("include_contact").notNull().default(false),
  includeResume:     boolean("include_resume").notNull().default(false),
  includeNotes:      boolean("include_notes").notNull().default(true),

  // ── Payload snapshots (point-in-time) ────────────────────────────────────
  /** Candidate evaluation package as rendered in the email/web view + PDF. */
  packageSnapshot:   jsonb("package_snapshot"),
  /** { name, logoUrl, primaryColor } captured from the tenant at send time. */
  brandSnapshot:     jsonb("brand_snapshot"),
  /** Résumé object path captured at SEND time (only when includeResume). The
   *  public résumé stream serves THIS exact object — never the candidate's live
   *  résumé — so a later résumé replacement cannot leak newer content to an old
   *  token holder. Null when the recruiter did not include a résumé. */
  resumeObjectPath:  text("resume_object_path"),
  /** Recruiter's personal note to the hiring manager. */
  message:           text("message"),

  // ── Hiring-manager decision feedback ─────────────────────────────────────
  decision:          hmShareDecisionEnum("decision"),
  decisionComment:   text("decision_comment"),
  decidedByName:     text("decided_by_name"),
  decidedAt:         timestamp("decided_at", { withTimezone: true }),

  // ── Engagement tracking ──────────────────────────────────────────────────
  viewedAt:          timestamp("viewed_at", { withTimezone: true }),
  viewCount:         integer("view_count").notNull().default(0),

  /** sent | viewed | decided | expired | revoked */
  status:            text("status").notNull().default("sent"),
  expiresAt:         timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type HiringManagerShare = typeof hiringManagerSharesTable.$inferSelect;
