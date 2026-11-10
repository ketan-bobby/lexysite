import assert from "node:assert/strict";
import test from "node:test";
import { readGooglePanelCalendar } from "./google-panel-freebusy";

const start = "2035-01-01T10:00:00.000Z",
  end = "2035-01-01T12:00:00.000Z",
  id = "owner@example.test";
const body = () => ({
  timeMin: start,
  timeMax: end,
  calendars: { [id]: { busy: [{ start, end }] } },
});
function transport(value: unknown, status = 200) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const request = (async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(calls.length === 1 ? { id } : value), { status });
  }) as typeof fetch;
  return { calls, request };
}
test("Google panel reads only the owned primary identifier, then free/busy, never event details", async () => {
  const f = transport(body());
  const result = await readGooglePanelCalendar("fixture-access", start, end, f.request);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].url, /calendars\/primary\?fields=id$/);
  assert.match(f.calls[1].url, /\/freeBusy$/);
  assert.deepEqual(JSON.parse(String(f.calls[1].options?.body)), {
    timeMin: start,
    timeMax: end,
    timeZone: "UTC",
    calendarExpansionMax: 1,
    items: [{ id }],
  });
  assert.deepEqual(result, [
    {
      showAs: "busy",
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /owner|fixture-access|title|attendees/);
});
test("an explicitly empty verified free/busy result is free, not an unknown response", async () => {
  const b = body();
  b.calendars[id].busy = [];
  assert.deepEqual(await readGooglePanelCalendar("token", start, end, transport(b).request), []);
});
test("incomplete, wrong-account, wrong-window and errored Google replies stay unknown", async () => {
  for (const value of [
    {},
    { ...body(), timeMax: start },
    { ...body(), calendars: {} },
    { ...body(), calendars: { wrong: { busy: [] } } },
    { ...body(), calendars: { [id]: { busy: [] }, extra: { busy: [] } } },
    { ...body(), calendars: { [id]: { errors: [{ reason: "forbidden" }], busy: [] } } },
    { ...body(), calendars: { [id]: {} } },
    { ...body(), groups: { group: {} } },
    { ...body(), calendars: { [id]: { busy: [{ start: end, end: start }] } } },
    { ...body(), calendars: { [id]: { busy: [{ start: "bad", end }] } } },
    {
      ...body(),
      calendars: {
        [id]: { busy: [{ start: "2036-01-01T10:00:00Z", end: "2036-01-01T11:00:00Z" }] },
      },
    },
  ])
    await assert.rejects(readGooglePanelCalendar("token", start, end, transport(value).request));
});
test("provider failures are sanitized and cannot fall back to another account or provider", async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = transport({ private: "secret" }, status);
    await assert.rejects(
      readGooglePanelCalendar("token", start, end, f.request),
      (e) => e instanceof Error && !e.message.includes("secret"),
    );
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(
    readGooglePanelCalendar("token", start, end, async () => {
      throw new Error("private network details");
    }),
  );
});
