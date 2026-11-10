import assert from "node:assert/strict";
import { test } from "node:test";
import {
  zoomJoinUrl,
  zoomSnapshot,
  zoomReviewToken,
  assertZoomApproval,
  zoomApproval,
} from "./staff-zoom-link";

test("Zoom join URLs reject host links, spoofing, host tokens and ambiguous participant URLs", () => {
  assert.equal(
    zoomJoinUrl("https://us02web.zoom.us/j/12345678901?pwd=abc._-~"),
    "https://us02web.zoom.us/j/12345678901?pwd=abc._-~",
  );
  for (const url of [
    "http://zoom.us/j/123456789",
    "https://evilzoom.us/j/123456789",
    "https://zoom.us.evil.test/j/123456789",
    "https://user@zoom.us/j/123456789",
    "https://zoom.us:444/j/123456789",
    "https://zoom.us/s/123456789",
    "https://zoom.us/j/123456789?zak=host-secret",
    "https://zoom.us/j/123456789?pwd=a&pwd=b",
    "https://zoom.us/j/123456789#host",
    "https://zoom.us/my/reusable",
    "https://zoom.us/j/123456789012",
    " https://zoom.us/j/123456789",
    "https://zoom.us/a/../j/123456789",
    "https://zoom.us/j/123456789?pwd=",
    "https://a.b.zoom.us/j/123456789",
  ])
    assert.throws(() => zoomJoinUrl(url));
});
test("Zoom approval tokens are actor, URL, native revision, expiry and tombstone bound", () => {
  const expiry = new Date(Date.now() + 60_000).toISOString(),
    version = `v1_${"a".repeat(64)}`;
  const args = [
    "synthetic-secret",
    "actor",
    "snapshot",
    version,
    null,
    "https://zoom.us/j/123456789",
    expiry,
  ] as const;
  const token = zoomReviewToken(...args);
  assertZoomApproval(token, token, expiry, Date.now());
  assert.throws(() => assertZoomApproval(token, `zl_${"0".repeat(64)}`, expiry, Date.now()));
  assert.throws(() => assertZoomApproval(token, token, expiry, Date.now() + 120_000));
  assert.notEqual(
    zoomReviewToken(args[0], args[1], args[2], version, "new-id", args[5], expiry),
    token,
  );
  assert.notEqual(
    zoomReviewToken(args[0], "other", args[2], version, null, args[5], expiry),
    token,
  );
  assert.equal(zoomApproval.safeParse({ confirm: false }).success, false);
});
test("Zoom publication evidence excludes private feedback but changes with time or recipient", () => {
  const row = {
    schedule: {
      id: "s",
      tenantId: "t",
      applicationId: "a",
      scheduledAt: new Date("2035-01-01"),
      durationMinutes: 30,
      type: "video",
      status: "confirmed",
      interviewerId: "staff",
    },
    application: { id: "a", tenantId: "t", candidateId: "c", jobId: "j" },
    job: { id: "j", tenantId: "t" },
    candidate: { id: "c", userId: "u", tenantId: "t", email: "candidate@example.test" },
  } as unknown as Parameters<typeof zoomSnapshot>[0];
  const initial = zoomSnapshot(row);
  assert.equal(
    zoomSnapshot({ ...row, schedule: { ...row.schedule, feedbackNotes: "private" } }),
    initial,
  );
  assert.notEqual(
    zoomSnapshot({ ...row, schedule: { ...row.schedule, durationMinutes: 90 } }),
    initial,
  );
  assert.notEqual(
    zoomSnapshot({ ...row, candidate: { ...row.candidate, email: "other@example.test" } }),
    initial,
  );
});
