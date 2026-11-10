import assert from "node:assert/strict";
import { mock, test } from "node:test";
mock.module("./vendor-usage", {
  namedExports: {
    meteredFetch: (_provider: unknown, transport: typeof fetch) => transport,
  },
});
const { recallAttendanceProvider } = await import("./recall-attendance-provider");

const id = "00000000-0000-4000-8000-000000000001",
  token = "00000000-0000-4000-8000-000000000002",
  botId = "00000000-0000-4000-8000-000000000003";
const bot = {
  id: botId,
  metadata: { lexy_attendance: id, lexy_dispatch: token },
  status_changes: [],
  recordings: [],
};
type Gateway = Parameters<typeof recallAttendanceProvider>[0];
function fixture(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ path: string; method?: string; connectionId?: string; body?: unknown }> = [];
  const gateway: Gateway = {
    listConnections: async () => [
      { id: "pinned", connector_name: "recall-ai", customer_id: "fixture" },
    ],
    proxy: async (_connector, path, options) => {
      calls.push({ path, ...options });
      const reply = replies.shift();
      assert.ok(reply, "unexpected retry/provider request");
      return Response.json(reply.body, { status: reply.status });
    },
  };
  return { provider: recallAttendanceProvider(gateway), calls };
}
test("create pins the reviewed connection, metadata and audio-only config with one write", async () => {
  const f = fixture([{ status: 201, body: bot }]);
  const result = await f.provider.create("pinned", {
    id,
    token,
    joinUrl: "https://zoom.us/j/12345678901",
    meetingId: "12345678901",
    scheduledAt: new Date(Date.now() + 3600_000),
    durationMinutes: 30,
  });
  assert.equal(result.id, botId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.connectionId, "pinned");
  assert.equal(f.calls[0]!.path, "/api/v1/bot/");
  assert.equal(f.calls[0]!.method, "POST");
  assert.deepEqual((f.calls[0]!.body as { metadata: unknown }).metadata, bot.metadata);
});
test("non-2xx and malformed accepted writes are never retried or reported as no-bot", async () => {
  for (const reply of [
    { status: 429, body: {} },
    { status: 500, body: {} },
    { status: 201, body: { id: botId } },
  ]) {
    const f = fixture([reply]);
    await assert.rejects(
      f.provider.create("pinned", {
        id,
        token,
        joinUrl: "https://zoom.us/j/12345678901",
        meetingId: "12345678901",
        scheduledAt: new Date(Date.now() + 3600_000),
        durationMinutes: 30,
      }),
    );
    assert.equal(f.calls.length, 1);
  }
});
test("recovery refuses absent, conflicting or paginated receipts and never writes", async () => {
  for (const body of [
    { next: null, results: [] },
    { next: null, results: [bot, bot] },
    { next: "https://external.invalid/next", results: [bot] },
    { next: null, results: [{ ...bot, metadata: { ...bot.metadata, lexy_dispatch: id } }] },
  ]) {
    const f = fixture([{ status: 200, body }]);
    await assert.rejects(f.provider.recover("pinned", id, token));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.method, "GET");
  }
});
test("finished bots require media cleanup; scheduled cancellation and live stop are distinct", async () => {
  const done = fixture([
    {
      status: 200,
      body: { ...bot, status_changes: [{ code: "done", created_at: new Date().toISOString() }] },
    },
  ]);
  assert.equal(await done.provider.stop("pinned", botId), "ended");
  assert.equal(done.calls.length, 1);
  const scheduled = fixture([
    { status: 200, body: { ...bot, join_at: new Date(Date.now() + 3600_000).toISOString() } },
    { status: 200, body: {} },
  ]);
  assert.equal(await scheduled.provider.stop("pinned", botId), "cancelled");
  assert.equal(scheduled.calls[1]!.method, "DELETE");
  const live = fixture([
    {
      status: 200,
      body: {
        ...bot,
        status_changes: [{ code: "in_call_recording", created_at: new Date().toISOString() }],
      },
    },
    { status: 200, body: {} },
  ]);
  assert.equal(await live.provider.stop("pinned", botId), "pending");
  assert.equal(live.calls[1]!.path, `/api/v1/bot/${botId}/leave_call/`);
  const fatal = fixture([
    {
      status: 200,
      body: { ...bot, status_changes: [{ code: "fatal", created_at: new Date().toISOString() }] },
    },
  ]);
  assert.equal(await fatal.provider.stop("pinned", botId), "pending");
  assert.equal(fatal.calls.length, 1, "fatal media may still be uploading; wait for done");
});
test("untrusted media hosts and wrong dispatch receipts never trigger a download", async () => {
  for (const url of [
    "http://127.0.0.1/a.mp3",
    "https://evil.invalid/a.mp3",
    "https://s3.us-west-2.amazonaws.com.evil.invalid/a.mp3",
  ]) {
    const f = fixture([
      {
        status: 200,
        body: {
          ...bot,
          status_changes: [{ code: "done", created_at: new Date().toISOString() }],
          recordings: [
            {
              id,
              media_shortcuts: {
                audio_mixed: { status: { code: "done" }, data: { download_url: url } },
              },
            },
          ],
        },
      },
    ]);
    await assert.rejects(f.provider.audio("pinned", botId, id, token));
    assert.equal(f.calls.length, 1);
  }
});
