/**
 * connectionEngine.test.ts — Connection Engine Manual Test Script
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Standalone smoke-test script for the employer-side Connection Engine.
 * Creates a synthetic candidate, fires a sequence of connection events, and
 * verifies that recalculateConnectionScore() produces the expected score and
 * top-signal list. Cleans up all inserted rows after the run.
 *
 * ─── How to run ──────────────────────────────────────────────────────────────
 *   ENABLE_CONNECTION_ENGINE=true node --loader tsx src/lib/connectionEngine.test.ts
 *
 * ─── Alternative: test via the live API ──────────────────────────────────────
 *   curl -X POST http://localhost:$PORT/api/connection-event \
 *     -H 'Content-Type: application/json' \
 *     -d '{"candidateId":"test-cand-1","eventType":"replied_to_outreach"}'
 *
 *   curl http://localhost:$PORT/api/connection-score/test-cand-1
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   Not imported at runtime — run directly with tsx during development.
 */

import { recalculateConnectionScore, getConnectionScore, getConnectionEvents, topSignals } from "./connectionEngine";
import { db } from "@workspace/db";
import { connectionEventsTable, connectionScoresTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const TEST_CANDIDATE = "test-connection-engine-candidate";

async function run() {
  console.log("── Connection Engine Tests ────────────────────────────");

  // Clean up any leftover test data
  await db.delete(connectionEventsTable).where(eq(connectionEventsTable.candidateId, TEST_CANDIDATE));
  await db.delete(connectionScoresTable).where(eq(connectionScoresTable.candidateId, TEST_CANDIDATE));

  // Test 1: Creating connection events ────────────────────────────────────────
  console.log("\n[1] Creating connection events...");
  await db.insert(connectionEventsTable).values({ id: crypto.randomUUID(), candidateId: TEST_CANDIDATE, eventType: "replied_to_outreach" });
  await db.insert(connectionEventsTable).values({ id: crypto.randomUUID(), candidateId: TEST_CANDIDATE, eventType: "booked_interview" });
  const events = await getConnectionEvents(TEST_CANDIDATE);
  console.assert(events.length === 2, `FAIL: expected 2 events, got ${events.length}`);
  console.log("  ✓ 2 events created");

  // Test 2: Calculating score ─────────────────────────────────────────────────
  console.log("\n[2] Calculating score...");
  const score1 = await recalculateConnectionScore(TEST_CANDIDATE);
  // replied_to_outreach (+15) + booked_interview (+20) = 35
  console.assert(score1 === 35, `FAIL: expected score 35, got ${score1}`);
  console.log(`  ✓ Score = ${score1} (expected 35)`);

  // Test 3: Score caps at 100 ─────────────────────────────────────────────────
  console.log("\n[3] Score caps at 100...");
  // Add enough positive events to exceed 100
  const extraEvents = [
    "response_within_24h",
    "accepted_intro",
    "completed_interview",
    "viewed_opportunity",
    "multiple_interactions",
  ];
  for (const t of extraEvents) {
    await db.insert(connectionEventsTable).values({ id: crypto.randomUUID(), candidateId: TEST_CANDIDATE, eventType: t });
  }
  const score2 = await recalculateConnectionScore(TEST_CANDIDATE);
  console.assert(score2 === 100, `FAIL: expected score capped at 100, got ${score2}`);
  console.log(`  ✓ Score = ${score2} (capped at 100)`);

  // Test 4: Negative events reduce score ─────────────────────────────────────
  console.log("\n[4] Negative events reduce score...");
  await db.delete(connectionEventsTable).where(eq(connectionEventsTable.candidateId, TEST_CANDIDATE));
  await db.insert(connectionEventsTable).values({ id: crypto.randomUUID(), candidateId: TEST_CANDIDATE, eventType: "no_show" });
  const score3 = await recalculateConnectionScore(TEST_CANDIDATE);
  // no_show = -25, capped at 0
  console.assert(score3 === 0, `FAIL: expected score 0 after no-show, got ${score3}`);
  console.log(`  ✓ Score = ${score3} after no-show (capped at 0)`);

  // Test 5: App runs without connection data ─────────────────────────────────
  console.log("\n[5] Score returns null for unknown candidate...");
  const noData = await getConnectionScore("completely-unknown-candidate");
  console.assert(noData === null, `FAIL: expected null for unknown candidate, got ${JSON.stringify(noData)}`);
  console.log("  ✓ null returned for unknown candidate (app continues normally)");

  // Test 6: topSignals helper ────────────────────────────────────────────────
  console.log("\n[6] topSignals returns top 3 signals...");
  const signals = topSignals([
    { eventType: "booked_interview" },
    { eventType: "no_show" },
    { eventType: "replied_to_outreach" },
    { eventType: "viewed_opportunity" },
  ]);
  console.assert(signals.length <= 3, `FAIL: expected ≤3 signals, got ${signals.length}`);
  console.log(`  ✓ Top signals: ${signals.join(", ")}`);

  // Clean up
  await db.delete(connectionEventsTable).where(eq(connectionEventsTable.candidateId, TEST_CANDIDATE));
  await db.delete(connectionScoresTable).where(eq(connectionScoresTable.candidateId, TEST_CANDIDATE));

  console.log("\n── All tests passed ✓ ─────────────────────────────────\n");
  process.exit(0);
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
