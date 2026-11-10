import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  attendanceApprovalInput,
  attendanceWorkspaceInput,
  recallBotConfiguration,
  verifyRecallWebhook,
  zoomAttendanceUrl,
  recallState,
} from "./meeting-attendance-core";

test("capture is explicit-consent, audio-only, silent and bounded; no AI configuration", () => {
  const now = Date.now();
  const cfg = recallBotConfiguration(
    {
      id: "attempt",
      token: "opaque",
      joinUrl: "https://us02web.zoom.us/j/12345678901?pwd=pass",
      meetingId: "12345678901",
      scheduledAt: new Date(now + 3600_000),
      durationMinutes: 45,
    },
    now,
  );
  assert.equal(cfg.bot_name, "Lexy — Interview Assistant");
  assert.equal(cfg.recording_config.transcript, null);
  assert.equal(cfg.recording_config.video_mixed_mp4, null);
  assert.equal(cfg.recording_config.participant_events, null);
  assert.deepEqual(cfg.recording_config.retention, { type: "timed", hours: 24 });
  assert.deepEqual(cfg.recording_config.audio_mixed_mp3, {});
  assert.equal(cfg.automatic_leave.in_call_recording_timeout, 2700);
  assert.ok(!("automatic_audio_output" in cfg));
  assert.deepEqual(cfg.breakout_room, { mode: "join_main_room" });
  for (const consent of [false, "true", undefined])
    assert.equal(
      attendanceApprovalInput.safeParse({
        scheduleId: "00000000-0000-4000-8000-000000000001",
        consent,
        consentStatement: "Participants explicitly approved recording.",
      }).success,
      false,
    );
  assert.equal(
    attendanceWorkspaceInput.safeParse({ connectionId: "c", authorized: false }).success,
    false,
  );
});
test("meeting identity, host, query and time windows cannot be substituted", () => {
  for (const raw of [
    "https://zoom.us.evil.com/j/12345678901",
    "http://zoom.us/j/12345678901",
    "https://localhost/j/12345678901",
    "https://user:pass@zoom.us/j/12345678901",
    "https://zoom.us/j/99999999999",
    "https://zoom.us/j/12345678901?redirect=http://localhost",
    "https://zoom.us/rec/12345678901",
    "https://zoom.us/j/12345678901#fragment",
  ])
    assert.throws(() => zoomAttendanceUrl(raw, "12345678901"));
  const base = {
    id: "a",
    token: "b",
    joinUrl: "https://zoom.us/j/12345678901",
    meetingId: "12345678901",
    scheduledAt: new Date(Date.now() - 2 * 3600_000),
    durationMinutes: 60,
  };
  assert.throws(() => recallBotConfiguration(base));
  assert.throws(() =>
    recallBotConfiguration({
      ...base,
      scheduledAt: new Date(Date.now() + 3600_000),
      durationMinutes: 61,
    }),
  );
  assert.equal(recallState("future_provider_state"), null);
});
test("modern and legacy signed webhooks reject tampering, replay age, future time and header mixing", () => {
  const bytes = randomBytes(32),
    secret = `whsec_${bytes.toString("base64")}`,
    body = Buffer.from('{"event":"bot.done"}'),
    now = Date.now(),
    stamp = String(Math.floor(now / 1000));
  const sig = createHmac("sha256", bytes).update(`message.${stamp}.`).update(body).digest("base64");
  for (const prefix of ["webhook", "svix"]) {
    const headers = {
      [`${prefix}-id`]: "message",
      [`${prefix}-timestamp`]: stamp,
      [`${prefix}-signature`]: `v1,${sig}`,
    };
    const id = verifyRecallWebhook(body, headers, secret, now);
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.throws(() => verifyRecallWebhook(Buffer.from("{}"), headers, secret, now));
    assert.throws(() => verifyRecallWebhook(body, headers, secret, now + 301_000));
    assert.throws(() => verifyRecallWebhook(body, headers, secret, now - 301_000));
    assert.throws(() => verifyRecallWebhook(body, headers, undefined, now));
    assert.throws(() =>
      verifyRecallWebhook(body, { ...headers, [`${prefix}-signature`]: "v1,bad" }, secret, now),
    );
  }
  assert.throws(() =>
    verifyRecallWebhook(
      body,
      {
        "webhook-id": "incomplete-modern",
        "svix-id": "message",
        "svix-timestamp": stamp,
        "svix-signature": `v1,${sig}`,
      },
      secret,
      now,
    ),
  );
});
