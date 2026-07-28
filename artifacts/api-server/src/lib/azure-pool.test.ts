/**
 * azure-pool.test.ts — coverage for the Azure account pool + per-account breaker.
 *
 * Pins the backward-compatible single-account behavior plus the new multi-key
 * features: round-robin selection, per-account circuit-breaker isolation, and
 * env parsing. Uses Node's built-in test runner with a UNIQUE namespace per test
 * so the module-level round-robin cursor and breaker state stay isolated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSttAccounts,
  getTtsAccounts,
  pickAccount,
  noteFailure,
  noteSuccess,
  breakerOpen,
  type AzureAccount,
} from "./azure-pool.ts";

/* ── Env parsing ─────────────────────────────────────────────────────────── */

test("getSttAccounts: primary key only → one account", () => {
  const accts = getSttAccounts({ AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "eastus" });
  assert.equal(accts.length, 1);
  assert.equal(accts[0].key, "k");
  assert.equal(accts[0].region, "eastus");
});

test("getSttAccounts: none configured → empty", () => {
  assert.deepEqual(getSttAccounts({}), []);
});

test("getSttAccounts: primary + AZURE_SPEECH_KEYS list, trims whitespace", () => {
  const accts = getSttAccounts({
    AZURE_SPEECH_KEY: "k0",
    AZURE_SPEECH_REGION: "eastus",
    AZURE_SPEECH_KEYS: "k1:westus, k2:westeurope ",
  });
  assert.equal(accts.length, 3);
  assert.deepEqual(accts.map((a) => a.key), ["k0", "k1", "k2"]);
  assert.deepEqual(accts.map((a) => a.region), ["eastus", "westus", "westeurope"]);
});

test("getSttAccounts: dedupes identical key+region", () => {
  const accts = getSttAccounts({
    AZURE_SPEECH_KEY: "k",
    AZURE_SPEECH_REGION: "eastus",
    AZURE_SPEECH_KEYS: "k:eastus,other:westus",
  });
  assert.equal(accts.length, 2);
  assert.deepEqual(accts.map((a) => a.key), ["k", "other"]);
});

test("getSttAccounts: skips malformed entries (no colon / empty halves)", () => {
  const accts = getSttAccounts({ AZURE_SPEECH_KEYS: "nocolon, :noregionkey, keyonly:, k:r" });
  assert.equal(accts.length, 1);
  assert.equal(accts[0].key, "k");
  assert.equal(accts[0].region, "r");
});

test("getTtsAccounts: dedicated TTS key is preferred over speech creds", () => {
  const accts = getTtsAccounts({
    AZURE_TTS_KEY: "t",
    AZURE_TTS_REGION: "westus",
    AZURE_SPEECH_KEY: "s",
    AZURE_SPEECH_REGION: "eastus",
  });
  assert.equal(accts.length, 1);
  assert.equal(accts[0].key, "t");
  assert.equal(accts[0].region, "westus");
});

test("getTtsAccounts: falls back to speech creds when no TTS key (backward compat)", () => {
  const accts = getTtsAccounts({ AZURE_SPEECH_KEY: "s", AZURE_SPEECH_REGION: "eastus" });
  assert.equal(accts.length, 1);
  assert.equal(accts[0].key, "s");
});

test("getTtsAccounts: dedicated TTS + AZURE_TTS_KEYS, no speech fallback appended", () => {
  const accts = getTtsAccounts({
    AZURE_TTS_KEY: "t0",
    AZURE_TTS_REGION: "westus",
    AZURE_TTS_KEYS: "t1:eastus",
    AZURE_SPEECH_KEY: "s",
    AZURE_SPEECH_REGION: "centralus",
  });
  assert.equal(accts.length, 2);
  assert.deepEqual(accts.map((a) => a.key), ["t0", "t1"]);
});

/* ── Round-robin selection ───────────────────────────────────────────────── */

const A: AzureAccount = { id: "r1#0", key: "ka", region: "r1" };
const B: AzureAccount = { id: "r2#1", key: "kb", region: "r2" };
const C: AzureAccount = { id: "r3#2", key: "kc", region: "r3" };

test("pickAccount round-robins across accounts", () => {
  const ns = "t-rr";
  const ids = [pickAccount(ns, [A, B, C]), pickAccount(ns, [A, B, C]), pickAccount(ns, [A, B, C]), pickAccount(ns, [A, B, C])]
    .map((p) => p!.account!.id);
  assert.deepEqual(ids, ["r1#0", "r2#1", "r3#2", "r1#0"]);
});

test("pickAccount with no accounts → null (caller must fall through to non-Azure)", () => {
  /* Backward-compat guard: when no Azure creds exist, the caller must NOT enter
     the Azure branch. A null pick is the contract that preserves the legacy
     "straight to Whisper/OpenAI" behavior. */
  assert.equal(pickAccount("t-empty", []), null);
});

test("TTS regression: no creds at all → getTtsAccounts empty → pickAccount null", () => {
  const accts = getTtsAccounts({});
  assert.deepEqual(accts, []);
  assert.equal(pickAccount("t-tts-empty", accts), null);
});

/* ── Per-account circuit breaker ─────────────────────────────────────────── */

test("breaker opens after the threshold and pickAccount skips the tripped account", () => {
  const ns = "t-iso";
  /* Trip ONLY account A's breaker (default threshold = 3). */
  for (let i = 0; i < 3; i++) noteFailure(`${ns}:${A.id}`);
  assert.equal(breakerOpen(`${ns}:${A.id}`), true);

  /* pickAccount must now always skip A and return the healthy B, regardless of
     where the round-robin cursor happens to be. */
  for (let i = 0; i < 5; i++) {
    assert.equal(pickAccount(ns, [A, B])!.account!.id, B.id);
  }
});

test("pickAccount returns null when every account's breaker is open", () => {
  const ns = "t-allopen";
  for (let i = 0; i < 3; i++) noteFailure(`${ns}:${A.id}`);
  for (let i = 0; i < 3; i++) noteFailure(`${ns}:${B.id}`);
  assert.equal(pickAccount(ns, [A, B]), null);
});

test("a success resets the failure streak (breaker stays closed)", () => {
  const ns = "t-reset";
  noteFailure(`${ns}:${A.id}`);
  noteFailure(`${ns}:${A.id}`); // 2 < threshold
  noteSuccess(`${ns}:${A.id}`); // reset
  noteFailure(`${ns}:${A.id}`); // back to 1
  assert.equal(breakerOpen(`${ns}:${A.id}`), false);
  assert.equal(pickAccount(ns, [A])!.account!.id, A.id);
});

test("breaker key includes the format dimension (STT isolation per codec)", () => {
  const ns = "stt-fmt";
  const p1 = pickAccount(ns, [A], "audio/webm");
  const p2 = pickAccount(ns, [A], "audio/ogg");
  assert.notEqual(p1!.breakerKey, p2!.breakerKey);
  /* Trip webm only; ogg must stay closed. */
  for (let i = 0; i < 3; i++) noteFailure(p1!.breakerKey);
  assert.equal(breakerOpen(p1!.breakerKey), true);
  assert.equal(breakerOpen(p2!.breakerKey), false);
});
