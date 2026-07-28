/**
 * admission.test.ts — coverage for the in-process admission-control semaphore.
 *
 * Pins the core guarantees: admit up to the cap immediately, queue beyond it,
 * hand a freed slot to the next waiter, and time out (shed) when no slot frees
 * in the wait budget. Tests use createSemaphore() directly with small caps so
 * the behavior is deterministic and independent of env config.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "./admission.ts";

test("admits immediately while under the cap", async () => {
  const s = createSemaphore(2, 50);
  assert.equal(await s.acquire(), true);
  assert.equal(await s.acquire(), true);
  assert.equal(s.inFlight(), 2);
});

test("queues beyond the cap, then a release hands the slot to the waiter", async () => {
  const s = createSemaphore(1, 1000);
  assert.equal(await s.acquire(), true);

  let granted = false;
  const waiter = s.acquire(1000).then((ok) => { granted = ok; });
  /* Give the microtask queue a tick — the waiter must still be pending. */
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(granted, false, "waiter should be queued while the slot is taken");
  assert.equal(s.waiting(), 1);

  s.release();          // hand the slot to the queued waiter
  await waiter;
  assert.equal(granted, true);
  assert.equal(s.waiting(), 0);
  assert.equal(s.inFlight(), 1, "in-flight stays at the cap as the slot transfers");
});

test("times out (sheds) when full and no slot frees within the budget", async () => {
  const s = createSemaphore(1, 30);
  assert.equal(await s.acquire(), true);

  const start = Date.now();
  const ok = await s.acquire(40);
  assert.equal(ok, false, "should be rejected after the wait budget");
  assert.ok(Date.now() - start >= 30, "should have waited roughly the budget");
  assert.equal(s.waiting(), 0, "timed-out waiter must be removed from the queue");
});

test("release without waiters frees a slot for the next acquire", async () => {
  const s = createSemaphore(1, 20);
  assert.equal(await s.acquire(), true);
  s.release();
  assert.equal(s.inFlight(), 0);
  assert.equal(await s.acquire(), true, "slot should be available again after release");
});

test("FIFO: the earliest waiter is granted first", async () => {
  const s = createSemaphore(1, 1000);
  await s.acquire();

  const order: number[] = [];
  const w1 = s.acquire(1000).then(() => order.push(1));
  const w2 = s.acquire(1000).then(() => order.push(2));
  await new Promise((r) => setTimeout(r, 10));

  s.release(); // → w1
  await w1;
  s.release(); // → w2
  await w2;
  assert.deepEqual(order, [1, 2]);
});
