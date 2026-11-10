import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FORM,
  parseMicros,
  toForm,
  validate,
} from "../components/jobs/sourcing-controls-shared";

test("six-decimal account rates parse exactly, never round down sub-cent cost", () => {
  assert.equal(parseMicros("0.025001"), 25001);
  assert.equal(parseMicros("0.000001"), 1);
  for (const s of ["0", "-1", "0.0000001", "100.000001", "1e-2", "Infinity"])
    assert.equal(parseMicros(s), null);
});
test("rates roundtrip, preserve unchecked provider settings, and can be cleared", () => {
  const input = {
    ...DEFAULT_FORM,
    accountRates: {
      ...DEFAULT_FORM.accountRates,
      serp: {
        rate: "0.025001",
        basis: "prepaid_allocation" as const,
        source: "fixture plan",
        expires: "2099-01-01",
      },
    },
  };
  const saved = validate(input, false);
  assert.ok(saved.limits);
  assert.equal(saved.limits.accountRates?.serp?.microsPerCredit, 25001);
  assert.deepEqual(toForm(saved.limits), input);
  assert.equal(
    validate(toForm(saved.limits), true).limits?.accountRates?.serp?.microsPerCredit,
    25001,
  );
  const cleared = {
    ...input,
    accountRates: { ...input.accountRates, serp: { ...input.accountRates.serp, rate: "" } },
  };
  assert.equal(validate(cleared, false).limits?.accountRates, undefined);
});
test("expired dates remain editable but invalid dates and secret-like sources are rejected", () => {
  const form = {
    ...DEFAULT_FORM,
    accountRates: {
      ...DEFAULT_FORM.accountRates,
      pdl: { rate: "0.10", basis: "payg" as const, source: "fixture plan", expires: "2020-01-01" },
    },
  };
  assert.ok(validate(form, false).limits);
  for (const patch of [
    { expires: "2026-02-31" },
    { source: "fixture@example.invalid" },
    { source: "" },
  ]) {
    assert.equal(
      validate(
        {
          ...form,
          accountRates: { ...form.accountRates, pdl: { ...form.accountRates.pdl, ...patch } },
        },
        false,
      ).limits,
      null,
    );
  }
});
