import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Minimal privacy-suppression identifiers; no profile or contact information.
export const candidateErasureTombstonesTable = pgTable("candidate_erasure_tombstones", {
  subjectId: text("subject_id").primaryKey(),
  erasedAt: timestamp("erased_at", { withTimezone: true }).notNull().defaultNow(),
});
