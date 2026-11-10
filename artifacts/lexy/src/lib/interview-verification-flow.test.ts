import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../pages/recruiter/interviews/room.tsx", import.meta.url),
  "utf8",
);

test("automatic auth challenges only open the dialog, never request an email", () => {
  const handler = source.slice(
    source.indexOf("const handleApiError ="),
    source.indexOf("/* Keep the language ref"),
  );
  assert.match(handler, /openStepUp\(\)/);
  assert.doesNotMatch(handler, /startStepUp\(|step-up\/start/);
  const opener = source.slice(
    source.indexOf("const openStepUp ="),
    source.indexOf("const startStepUp ="),
  );
  assert.doesNotMatch(opener, /apiFetch|startStepUp|setStepUpCode/);
});
test("code sending remains an explicit guarded resend action", () => {
  assert.match(source, /onResend=\{startStepUp\}/);
  assert.match(source, /if \(stepUpSendInFlightRef\.current\) return/);
  assert.match(source, /stepUpSendInFlightRef\.current = false/);
});
test("dialog starts ready for an existing code, not falsely sending", () => {
  assert.match(source, /const \[stepUpStage,[^\n]+\("enter_code"\)/);
  assert.match(source, /Opening this page does not send another code/);
});
