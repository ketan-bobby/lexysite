import { test } from "node:test";
import assert from "node:assert/strict";
import { safeGoogleMeetAuthUrl, shouldShowStatus, errStatus } from "./google-meet-recording-state";
test("only the exact HTTPS Google consent endpoint can receive a staff redirect", () => {
  const valid = "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic";
  assert.equal(safeGoogleMeetAuthUrl(valid), valid);
  for (const input of [
    null,
    {},
    "",
    "/login",
    "javascript:alert(1)",
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com.evil.test/o/oauth2/v2/auth",
    "https://accounts.google.com:444/o/oauth2/v2/auth",
    "https://accounts.google.com/another-path",
    "https://user@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com@evil.test/o/oauth2/v2/auth",
  ])
    assert.equal(safeGoogleMeetAuthUrl(input), null);
});
test("authority denials and read failures never expose a cached private account", () => {
  for (const readFailing of [true, false])
    for (const denied of [true, false])
      assert.equal(shouldShowStatus({ readFailing, denied }), !readFailing && !denied);
});
test("only numeric HTTP statuses are treated as status evidence", () => {
  assert.equal(errStatus({ status: 403 }), 403);
  for (const input of [undefined, null, new Error("403"), { status: "403" }])
    assert.equal(errStatus(input), null);
});
