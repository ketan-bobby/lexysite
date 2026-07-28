/**
 * subscription-lifecycle.test.ts — regression tests for the manual-billing
 * lifecycle hardening (migration 0056).
 *
 * Run: pnpm --filter @workspace/api-server run test:lifecycle
 * (needs DATABASE_URL — the claim/ledger tests exercise the real dev DB
 * constraints; rows use synthetic tenant ids and are cleaned up.)
 *
 * Locked behaviours under test:
 *   • graceDaysFor: per-tenant override wins, null/undefined/negative fall
 *     back to the global default.
 *   • DUNNING_THRESHOLDS default parses to sorted [-14, -7, -1, 0].
 *   • billing_alerts_sent claim: UNIQUE(tenant_id, cycle_anchor, alert_type)
 *     — first insert wins, duplicate loses, a NEW cycle_anchor (payment
 *     recorded → paid_through advanced) re-arms the same alert type.
 *   • seat_overage dedup: one line per (tenant, period_key) via the partial
 *     unique index; other item_types unaffected by it.
 *   • per_hire shape CHECK: per_hire rows without hire identity are rejected;
 *     adjustment rows may be money-only and negative (credits/refunds).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, billingAlertsSentTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { graceDaysFor, GRACE_PERIOD_DAYS } from "./plan-enforcement";
import { DUNNING_THRESHOLDS, desiredStatusFor } from "./subscription-lifecycle-scheduler";

const DAY_MS = 24 * 60 * 60 * 1000;

const T = `test-lifecycle-${Date.now()}`;

after(async () => {
  await db.execute(sql`DELETE FROM billing_alerts_sent WHERE tenant_id LIKE 'test-lifecycle-%'`);
  await db.execute(sql`DELETE FROM fee_line_items WHERE tenant_id LIKE 'test-lifecycle-%'`);
});

/* ── graceDaysFor ── */
test("graceDaysFor: per-tenant override wins over the global default", () => {
  assert.equal(graceDaysFor(0), 0); // zero-grace Enterprise term is honoured
  assert.equal(graceDaysFor(30), 30);
});

test("graceDaysFor: null/undefined/invalid fall back to the global default", () => {
  assert.equal(graceDaysFor(null), GRACE_PERIOD_DAYS);
  assert.equal(graceDaysFor(undefined), GRACE_PERIOD_DAYS);
  assert.equal(graceDaysFor(-3), GRACE_PERIOD_DAYS);
});

/* ── dunning thresholds ── */
test("DUNNING_THRESHOLDS default is sorted [-14, -7, -1, 0]", () => {
  assert.deepEqual(DUNNING_THRESHOLDS, [-14, -7, -1, 0]);
});

/* ── lifecycle status boundaries (the tick() decision, extracted pure) ── */
test("desiredStatusFor: exact grace-boundary semantics (strict >)", () => {
  const pt = Date.parse("2026-07-01T00:00:00.000Z");
  const grace = 7;
  const cutoff = pt + grace * DAY_MS;
  // AT paid_through → still active; 1ms past → past_due.
  assert.equal(desiredStatusFor(pt, pt, grace), "active");
  assert.equal(desiredStatusFor(pt + 1, pt, grace), "past_due");
  // AT the grace cutoff → still past_due; 1ms past → suspended.
  assert.equal(desiredStatusFor(cutoff, pt, grace), "past_due");
  assert.equal(desiredStatusFor(cutoff + 1, pt, grace), "suspended");
});

test("desiredStatusFor: zero-grace tenant suspends immediately after paid_through", () => {
  const pt = Date.parse("2026-07-01T00:00:00.000Z");
  assert.equal(desiredStatusFor(pt, pt, 0), "active");
  assert.equal(desiredStatusFor(pt + 1, pt, 0), "suspended"); // no past_due window
});

test("desiredStatusFor: extended per-tenant grace keeps a tenant past_due longer than the default", () => {
  const pt = Date.parse("2026-07-01T00:00:00.000Z");
  const at20Days = pt + 20 * DAY_MS;
  assert.equal(desiredStatusFor(at20Days, pt, GRACE_PERIOD_DAYS), "suspended"); // default grace exhausted
  assert.equal(desiredStatusFor(at20Days, pt, 30), "past_due"); // negotiated 30-day grace still open
});

/* ── billing_alerts_sent claim semantics ── */
async function claim(tenantId: string, cycleAnchor: string, alertType: string): Promise<boolean> {
  const [won] = await db
    .insert(billingAlertsSentTable)
    .values({ tenantId, cycleAnchor, alertType })
    .onConflictDoNothing()
    .returning({ id: billingAlertsSentTable.id });
  return !!won;
}

test("alert claim: first insert wins, duplicate loses (at-most-once per cycle)", async () => {
  const anchor = "2026-08-01T00:00:00.000Z";
  assert.equal(await claim(T, anchor, "reminder_14d"), true);
  assert.equal(await claim(T, anchor, "reminder_14d"), false);
  // A different threshold in the same cycle is an independent claim.
  assert.equal(await claim(T, anchor, "reminder_7d"), true);
});

test("alert claim: CONCURRENT claimers — exactly one wins (multi-replica safety)", async () => {
  const anchor = "2026-10-01T00:00:00.000Z";
  const results = await Promise.all(
    Array.from({ length: 10 }, () => claim(T, anchor, "reminder_1d")),
  );
  assert.equal(results.filter(Boolean).length, 1, "exactly one concurrent claimer may send");
});

test("alert claim: send failure AFTER a won claim does NOT re-arm (at-most-once by design)", async () => {
  const anchor = "2026-11-01T00:00:00.000Z";
  assert.equal(await claim(T, anchor, "lapsed"), true);
  // Simulate the send throwing after the claim was recorded…
  try {
    throw new Error("SES down");
  } catch {
    /* scheduler logs and moves on */
  }
  // …next tick must NOT send a duplicate: the claim is already burned.
  assert.equal(await claim(T, anchor, "lapsed"), false);
});

test("alert claim: a new cycle_anchor (payment recorded) re-arms every alert", async () => {
  const oldAnchor = "2026-08-01T00:00:00.000Z";
  const newAnchor = "2026-09-01T00:00:00.000Z";
  assert.equal(await claim(T, oldAnchor, "lapsed"), true);
  assert.equal(await claim(T, oldAnchor, "lapsed"), false);
  assert.equal(await claim(T, newAnchor, "lapsed"), true); // fresh cycle
});

/* ── fee_line_items generalised ledger constraints ── */
test("seat_overage: one line per tenant per period (partial unique index)", async () => {
  const insertOverage = (period: string) =>
    db.execute(sql`
    INSERT INTO fee_line_items (tenant_id, item_type, amount, currency, description, period_key)
    VALUES (${T}, 'seat_overage', 50, 'USD', 'test overage', ${period})
    ON CONFLICT (tenant_id, period_key) WHERE item_type = 'seat_overage' DO NOTHING
    RETURNING id`);
  const first = await insertOverage("2026-07");
  const dup = await insertOverage("2026-07");
  const nextMonth = await insertOverage("2026-08");
  const rowsOf = (r: any) => r.rows ?? (Array.isArray(r) ? r : []);
  assert.equal(rowsOf(first).length, 1);
  assert.equal(rowsOf(dup).length, 0, "duplicate month must be a no-op");
  assert.equal(rowsOf(nextMonth).length, 1, "a new month is a fresh claim");
});

test("adjustment lines may be money-only and negative (credit/refund)", async () => {
  const r = await db.execute(sql`
    INSERT INTO fee_line_items (tenant_id, item_type, amount, currency, description, evidence)
    VALUES (${T}, 'adjustment', -120.5, 'USD', 'test refund', '{"paymentType":"refund"}'::jsonb)
    RETURNING id, amount`);
  const rows = (r as any).rows ?? [];
  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0].amount) < 0);
});

/** drizzle wraps pg errors — the constraint name is on err.cause.message. */
function rejectsWithConstraint(re: RegExp) {
  return (err: unknown) => {
    const msg = `${(err as Error)?.message ?? ""} ${((err as any)?.cause as Error)?.message ?? ""}`;
    assert.match(msg, re);
    return true;
  };
}

test("per_hire rows without hire identity are REJECTED by the shape CHECK", async () => {
  await assert.rejects(
    db.execute(sql`
      INSERT INTO fee_line_items (tenant_id, item_type, amount, currency)
      VALUES (${T}, 'per_hire', 1000, 'USD')`),
    rejectsWithConstraint(/per_hire_shape/),
  );
});

test("unknown item_type is rejected", async () => {
  await assert.rejects(
    db.execute(sql`
      INSERT INTO fee_line_items (tenant_id, item_type, amount, currency)
      VALUES (${T}, 'mystery', 1, 'USD')`),
    rejectsWithConstraint(/item_type_check/),
  );
});

/* ── proration math (mirrors the route's formula) ── */
test("proration delta = (new − old) × remainingDays/30, rounded to cents", () => {
  const delta = (oldM: number, newM: number, days: number) =>
    Math.round((newM - oldM) * (days / 30) * 100) / 100;
  assert.equal(delta(500, 1200, 15), 350); // upgrade mid-cycle
  assert.equal(delta(1200, 500, 15), -350); // downgrade → credit
  assert.equal(delta(500, 500, 15), 0); // same price → no line
  assert.equal(delta(500, 1200, 0), 0); // nothing remaining → no line
});
