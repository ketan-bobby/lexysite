import assert from "node:assert/strict";
import { test } from "node:test";
import { offeredTimesSchemaUnavailable } from "./offered-times-errors";

test("recognizes a wrapped missing feature table or column without returning SQL details", () => {
  for (const code of ["42P01", "42703"]) {
    assert.equal(
      offeredTimesSchemaUnavailable({
        query: 'select "version" from "interview_offered_times"',
        cause: { code },
      }),
      true,
    );
  }
  assert.equal(
    offeredTimesSchemaUnavailable({
      code: "42P01",
      message: 'relation "interview_offered_times" does not exist',
    }),
    true,
  );
});

test("unrelated schema, permission, trigger and connection errors are not hidden", () => {
  for (const code of ["23505", "42501", "P0001", "08006"]) {
    assert.equal(
      offeredTimesSchemaUnavailable({
        query: 'insert into "interview_offered_times" values ($1)',
        cause: { code },
      }),
      false,
    );
  }
  assert.equal(
    offeredTimesSchemaUnavailable({
      query: 'insert into "candidate_action_events" values ($1)',
      cause: { code: "42P01" },
    }),
    false,
  );
  assert.equal(offeredTimesSchemaUnavailable({ code: "42703" }), false);
  assert.equal(
    offeredTimesSchemaUnavailable({
      query: 'insert into "interview_offered_times" values ($1)',
      cause: { code: "42P01", message: 'relation "candidate_action_events" does not exist' },
    }),
    false,
  );
  assert.equal(
    offeredTimesSchemaUnavailable({
      query: 'insert into "interview_offered_times" values ($1)',
      cause: { code: "42703", where: "PL/pgSQL function some_trigger" },
    }),
    false,
  );
});

test("error traversal is bounded and tolerates malformed or circular causes", () => {
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  for (const error of [null, undefined, "42P01", circular, { cause: null }])
    assert.equal(offeredTimesSchemaUnavailable(error), false);
});
