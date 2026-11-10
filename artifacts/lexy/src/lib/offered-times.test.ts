import test from "node:test";
import assert from "node:assert/strict";
import {
  canOfferTimes,
  offeredTimesError,
  normalizeAlternatives,
  parseCandidateOfferedTimes,
  toLocalInput,
  verifyPublished,
} from "./offered-times";

const v = "v1_" + "a".repeat(64);

test("temporary-unavailability messages remain visible without treating failures as empty options", () => {
  assert.equal(
    offeredTimesError(
      { code: "offered_times_unavailable", error: "Please contact your recruiter." },
      "fallback",
    ),
    "Please contact your recruiter.",
  );
  assert.equal(offeredTimesError({ error: "" }, "fallback"), "fallback");
  assert.equal(offeredTimesError(null, "fallback"), "fallback");
});
const a = "2030-01-01T10:00:00.000Z",
  b = "2030-01-02T10:00:00.000Z";
const prop = (o = {}) => ({
  scheduleId: "s",
  version: v,
  offerVersion: "offer-1",
  scheduledAt: a,
  durationMinutes: 30,
  startsAt: [a, b],
  expiresAt: a,
  ...o,
});

test("parses valid and rejects wrong schedule / bad first", () => {
  assert.ok(parseCandidateOfferedTimes(prop(), "s"));
  assert.throws(() => parseCandidateOfferedTimes(prop(), "x"));
  assert.throws(() => parseCandidateOfferedTimes(prop({ startsAt: [b, a] }), "s"));
});
test("verifyPublished checks alternatives", () => {
  assert.ok(verifyPublished({ version: v, proposal: prop() }, "s", [b]));
  assert.throws(() => verifyPublished({ version: v, proposal: prop() }, "s", []));
});
test("normalize", () => {
  const now = Date.parse("2029-01-01T00:00:00Z");
  assert.equal(normalizeAlternatives([""], a, now).ok, false);
  assert.equal(normalizeAlternatives([], a, now).ok, true);
  assert.equal(normalizeAlternatives(["not-a-date"], a, now).ok, false);
  assert.equal(normalizeAlternatives([a], a, now).ok, false);
  assert.equal(normalizeAlternatives(["2020-01-01T00:00"], a, now).ok, false);
  assert.equal(normalizeAlternatives(Array(5).fill("2031-01-01T00:00"), a, now).ok, false);
});
test("unchanged saved wall time preserves seconds, milliseconds and DST-fold offset", () => {
  const anchor = "2030-11-03T06:30:17.123Z";
  const out = normalizeAlternatives([toLocalInput(anchor)], a, 0, [anchor]);
  assert.deepEqual(out, { ok: true, value: [anchor] });
});
test("rejects incoherent offers and a changed original in the publish receipt", () => {
  assert.throws(() => parseCandidateOfferedTimes(prop({ offerVersion: null }), "s"));
  assert.throws(() => parseCandidateOfferedTimes(prop({ expiresAt: null }), "s"));
  assert.throws(() =>
    verifyPublished({ version: v, proposal: prop({ durationMinutes: 60 }) }, "s", [b], {
      version: v,
      proposal: prop(),
    }),
  );
});
test("canOfferTimes", () => {
  assert.equal(canOfferTimes({ status: "pending", type: "technical", scheduledAt: a }, 0), true);
  assert.equal(
    canOfferTimes({ status: "pending", type: "ai_interview", scheduledAt: a }, 0),
    false,
  );
  assert.equal(canOfferTimes({ status: "confirmed", type: "technical", scheduledAt: a }, 0), false);
});
