import { test } from "node:test";
import assert from "node:assert/strict";
import { interviewRoomUrl } from "./interview-link-url";

test("unpublished development sessions link to the preview environment", () => {
  assert.equal(
    interviewRoomUrl("session-1", { nodeEnv: "development", devDomain: "pilot.replit.dev" }),
    "https://pilot.replit.dev/interviews/session-1/room",
  );
});
test("configured canonical origin and artifact prefix take priority", () => {
  assert.equal(
    interviewRoomUrl("session/1", {
      nodeEnv: "production",
      appBaseUrl: "https://hiring.example/app/",
      devDomain: "pilot.replit.dev",
    }),
    "https://hiring.example/app/interviews/session%2F1/room",
  );
});
test("production does not guess a host or fall back to a preview URL", () => {
  assert.throws(() =>
    interviewRoomUrl("s", { nodeEnv: "production", devDomain: "pilot.replit.dev" }),
  );
});
test("invalid, credential-bearing and ambiguous configured URLs fail explicitly", () => {
  for (const appBaseUrl of [
    "javascript:bad",
    "https://user:pass@example.test",
    "https://example.test/?q=1",
  ])
    assert.throws(() => interviewRoomUrl("s", { appBaseUrl }));
});
