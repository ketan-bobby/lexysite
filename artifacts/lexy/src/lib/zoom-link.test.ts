import test from "node:test";
import assert from "node:assert/strict";
import { safeZoomJoinUrl, zoomErrorMessage } from "./zoom-link";

test("accepts join urls", () => {
  assert.ok(safeZoomJoinUrl("https://us02web.zoom.us/j/84012345678?pwd=abc"));
  assert.equal(safeZoomJoinUrl("https://zoom.us/j/84012345678/"), "https://zoom.us/j/84012345678");
  assert.equal(
    safeZoomJoinUrl("https://us02web.zoom.us/j/84012345678?pwd=a.b~c"),
    "https://us02web.zoom.us/j/84012345678?pwd=a.b~c",
  );
});
test("rejects unsafe urls", () => {
  for (const u of [
    "http://zoom.us/j/84012345678",
    "https://evilzoom.us/j/84012345678",
    "https://zoom.us.evil.com/j/84012345678",
    "https://zoom.us/s/84012345678?zak=x",
    "https://a:b@zoom.us/j/84012345678",
    "https://zoom.us/j/84012345678?foo=1",
    "https://a.b.zoom.us/j/84012345678",
    "https://zoom.us/j/84012345678?pwd=",
    "https://zoom.us/j/84012345678?",
    "https://zoom.us/j/84012345678\\x",
    "https://zoom.us/j/84012345678?pwd=a&pwd=b",
    "https://zoom.us/j/%38401234567",
    "https://zoom.us/j/../j/84012345678",
    "https://zoom.us/j/840123456789",
    "https://zoom.us/j/84012345678#x",
    "https://-bad.zoom.us/j/84012345678",
    "https://zoom.us/j/84012345678?tk=1",
    "javascript:alert(1)",
    null,
    " https://zoom.us/j/84012345678",
  ])
    assert.equal(safeZoomJoinUrl(u), null, String(u));
});
test("error messages", () => {
  assert.match(zoomErrorMessage({ status: 503 }, "x"), /outcome is unconfirmed/);
  assert.doesNotMatch(zoomErrorMessage({ status: 503 }, "x"), /nothing was changed/i);
  assert.match(zoomErrorMessage(new Error("x"), "save"), /could not confirm the save/);
});
