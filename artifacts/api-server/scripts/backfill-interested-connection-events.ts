/**
 * One-off backfill: emit Connection Engine events for candidates who clicked the
 * "I'm interested" quick-reply button BEFORE that route recorded engagement
 * signals (only the inbound-email webhook path used to). These candidates show
 * "responded interested" / advanced to an interview yet read Connection
 * Strength 0. This replays the exact events the live route now emits.
 *
 * Idempotent: skips any (candidate) that already has connection events.
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/backfill-interested-connection-events.ts
 */
import {
  db,
  outreachEnrollmentsTable,
  outreachMessagesTable,
  sourcedCandidatesTable,
  candidatesTable,
  connectionEventsTable,
} from "@workspace/db";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import {
  recordConnectionEvent,
  recalculateConnectionScore,
} from "../src/lib/connectionEngine.js";

/** Has this candidate already received the "interested" connection signature?
 *  Checks the specific signal (accepted_intro) rather than ANY event, so the
 *  backfill stays complete for candidates who happen to have unrelated events
 *  while still being safe/idempotent on re-run. */
async function hasInterestedSignature(candidateId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: connectionEventsTable.id })
    .from(connectionEventsTable)
    .where(and(
      eq(connectionEventsTable.candidateId, candidateId),
      eq(connectionEventsTable.eventType, "accepted_intro"),
    ))
    .limit(1);
  return !!row;
}

async function emitInterested(opts: {
  candidateId: string;
  lookupCandidateIds: (string | null | undefined)[];
  jobId: string | null;
  employerId: string | null;
  label: string;
}): Promise<number | null> {
  const { candidateId, jobId, employerId, label } = opts;
  if (!candidateId) return null;
  if (await hasInterestedSignature(candidateId)) {
    console.log(`  skip ${label} — candidate ${candidateId} already has interested signature`);
    return null;
  }
  const lookupIds = Array.from(new Set(opts.lookupCandidateIds.filter((id): id is string => !!id)));
  await recordConnectionEvent({ candidateId, eventType: "replied_to_outreach", jobId, employerId });
  const [lastSent] = await db
    .select({ sentAt: outreachMessagesTable.sentAt })
    .from(outreachMessagesTable)
    .where(and(inArray(outreachMessagesTable.candidateId, lookupIds), eq(outreachMessagesTable.status, "sent")))
    .orderBy(desc(outreachMessagesTable.sentAt))
    .limit(1);
  if (lastSent?.sentAt) {
    const hrs = (Date.now() - new Date(lastSent.sentAt).getTime()) / 36e5;
    if (hrs <= 24) {
      await recordConnectionEvent({ candidateId, eventType: "response_within_24h", jobId, employerId });
    }
  }
  await recordConnectionEvent({ candidateId, eventType: "accepted_intro", jobId, employerId });
  const score = await recalculateConnectionScore(candidateId, jobId, employerId);
  console.log(`  ✓ ${label} — candidate ${candidateId} → score ${score}`);
  return score;
}

async function main() {
  let done = 0;

  // Path 1: enrollment quick-reply "interested"
  const enrollments = await db
    .select()
    .from(outreachEnrollmentsTable)
    .where(sql`${outreachEnrollmentsTable.recipientData}->>'quickReplyAction' = 'interested'`);
  console.log(`Enrollment 'interested' quick-replies: ${enrollments.length}`);
  for (const e of enrollments) {
    const [sc] = await db
      .select()
      .from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, e.candidateId))
      .limit(1);
    const canonical = sc?.normalizedCandidateId ?? null;
    if (!canonical) {
      console.log(`  skip enrollment ${e.id} — no canonical candidate id`);
      continue;
    }
    const r = await emitInterested({
      candidateId: canonical,
      lookupCandidateIds: [canonical, sc?.id, e.candidateId],
      jobId: e.jobId ?? null,
      employerId: e.tenantId ?? null,
      label: `enrollment:${e.id}`,
    });
    if (r != null) done++;
  }

  // Path 2: message quick-reply positive ("interested")
  const messages = await db
    .select()
    .from(outreachMessagesTable)
    .where(and(sql`${outreachMessagesTable.repliedAt} IS NOT NULL`, eq(outreachMessagesTable.replySentiment, "positive")));
  console.log(`Message positive replies: ${messages.length}`);
  for (const m of messages) {
    // candidate_id can be a sourced id OR a normalized candidate id — resolve canonical.
    const [cand] = await db
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, m.candidateId))
      .limit(1);
    let canonical: string | null = cand?.id ?? null;
    if (!canonical) {
      const [sc] = await db
        .select()
        .from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.id, m.candidateId))
        .limit(1);
      canonical = sc?.normalizedCandidateId ?? null;
    }
    if (!canonical) {
      console.log(`  skip message ${m.id} — could not resolve canonical candidate id`);
      continue;
    }
    const r = await emitInterested({
      candidateId: canonical,
      lookupCandidateIds: [canonical, m.candidateId],
      jobId: m.jobId ?? null,
      employerId: m.tenantId ?? null,
      label: `message:${m.id}`,
    });
    if (r != null) done++;
  }

  console.log(`\nBackfill complete. Candidates updated: ${done}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
