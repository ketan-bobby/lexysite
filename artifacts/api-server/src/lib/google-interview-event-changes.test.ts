import test from "node:test";
import assert from "node:assert/strict";
import { googleInterviewEventChanges } from "./google-interview-event-changes";
import {
  googleEventObservation,
  googleInterviewEventId,
  type GoogleEventDetails,
} from "./google-interview-event";

const d: GoogleEventDetails = {
  transactionId: "synthetic-attempt",
  binding: "synthetic-binding",
  jobTitle: "Engineer",
  organizerEmail: "staff@example.test",
  recipientEmail: "candidate@example.test",
  startAt: "2030-11-03T15:30:15.123Z",
  endAt: "2030-11-03T16:00:15.123Z",
};
const event = () => ({
  id: googleInterviewEventId(d.transactionId),
  etag: '"original-etag"',
  status: "confirmed",
  summary: "Interview: Engineer",
  start: { dateTime: d.startAt },
  end: { dateTime: d.endAt },
  organizer: { email: d.organizerEmail, self: true },
  attendees: [{ email: d.recipientEmail }],
  guestsCanInviteOthers: false,
  guestsCanSeeOtherGuests: false,
  visibility: "private",
  extendedProperties: { private: { lexySchedule: d.binding, lexyAttempt: d.transactionId } },
  conferenceData: {
    conferenceSolution: { key: { type: "hangoutsMeet" } },
    entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
  },
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("member availability excludes only one verified original attendee copy, never a second overlapping event", async () => {
  const target = { ...d, panelEmails: ["panel@example.test"] };
  const source = {
    ...googleEventObservation(
      {
        ...event(),
        attendees: [...event().attendees, { email: "panel@example.test" }],
      },
      target,
    ),
    iCalUID: "original-uid",
  };
  const copy = {
    id: "member-local-copy",
    iCalUID: source.iCalUID,
    status: "confirmed",
    organizer: { email: d.organizerEmail },
    start: { dateTime: source.startAt },
    end: { dateTime: source.endAt },
    attendees: [{ email: d.recipientEmail }, { email: "panel@example.test", self: true }],
  };
  for (const scenario of [
    "copy",
    "busy",
    "duplicate",
    "wrong-uid",
    "wrong-owner",
    "wrong-time",
    "wrong-self",
    "extra-guest",
    "same-id",
    "paged",
    "all-day",
    "error",
  ]) {
    const altered = structuredClone(copy);
    if (scenario === "wrong-uid") altered.iCalUID = "foreign";
    if (scenario === "wrong-owner") altered.organizer.email = "other@example.test";
    if (scenario === "wrong-time") altered.start.dateTime = "2030-11-04T15:01:00.000Z";
    if (scenario === "wrong-self") altered.attendees[1].self = false;
    if (scenario === "extra-guest") altered.attendees.push({ email: "foreign@example.test" });
    if (scenario === "same-id") {
      altered.id = googleInterviewEventId(d.transactionId);
      altered.iCalUID = "foreign";
    }
    const items: unknown[] = [altered];
    if (scenario === "duplicate") items.push(copy);
    if (scenario === "busy") items.push({ ...copy, id: "second", iCalUID: "second" });
    if (scenario === "all-day")
      items.push({ id: "all-day", start: { date: "2030-11-04" }, end: { date: "2030-11-05" } });
    const changes = googleInterviewEventChanges((async (url, init) => {
      assert.equal(init!.method, "GET");
      assert.equal(new URL(String(url)).pathname, "/calendar/v3/calendars/primary/events");
      if (scenario === "error") return response({}, 403);
      return response({
        kind: "calendar#events",
        items,
        ...(scenario === "paged" ? { nextPageToken: "more" } : {}),
      });
    }) as typeof fetch);
    const check = () =>
      changes.available("member-token", target, { source, email: "panel@example.test" });
    if (scenario === "copy") await check();
    else await assert.rejects(check());
  }
});
test("Panel PATCH observes exactly the original guests, preserves the list and rejects altered receipts", async () => {
  const target = { ...d, panelEmails: ["panel@example.test"] };
  const panelEvent = {
    ...event(),
    attendees: [...event().attendees, { email: "panel@example.test" }],
  };
  const source = googleEventObservation(panelEvent, target);
  for (const alteration of ["none", "missing", "extra", "duplicate"]) {
    let calls = 0;
    const changes = googleInterviewEventChanges((async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).searchParams.get("sendUpdates"), "all");
      assert.equal(init!.method, "PATCH");
      const body = JSON.parse(init!.body as string);
      assert.equal("attendees" in body, false);
      const attendees =
        alteration === "missing"
          ? event().attendees
          : alteration === "extra"
            ? [...panelEvent.attendees, { email: "extra@example.test" }]
            : alteration === "duplicate"
              ? [...panelEvent.attendees, { email: "panel@example.test" }]
              : panelEvent.attendees;
      return response({
        ...panelEvent,
        attendees,
        start: body.start,
        end: body.end,
        extendedProperties: body.extendedProperties,
      });
    }) as typeof fetch);
    const apply = () => changes.reschedule("synthetic", target, source, "panel-change");
    if (alteration === "none") assert.equal((await apply()).changeId, "panel-change");
    else await assert.rejects(apply());
    assert.equal(calls, 1);
  }
  for (const attendees of [
    event().attendees,
    [...panelEvent.attendees, { email: "foreign@example.test" }],
  ]) {
    const changes = googleInterviewEventChanges((async () =>
      response({ ...panelEvent, attendees })) as typeof fetch);
    await assert.rejects(changes.observe("synthetic", target));
  }
});
test("Conditional time-only PATCH targets the original ID, preserves Meet and carries one change marker", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [],
    target = { ...d, startAt: "2030-11-04T15:30:15.123Z", endAt: "2030-11-04T16:00:15.123Z" };
  const changes = googleInterviewEventChanges((async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const body = JSON.parse(init!.body as string);
    return response({
      ...event(),
      etag: '"new-etag"',
      start: body.start,
      end: body.end,
      extendedProperties: body.extendedProperties,
    });
  }) as typeof fetch);
  const result = await changes.reschedule(
    "synthetic",
    target,
    googleEventObservation(event(), d),
    "change-one",
  );
  assert.equal(result.meetUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal((calls[0].init.headers as Record<string, string>)["If-Match"], '"original-etag"');
  const url = new URL(calls[0].url);
  assert.equal(
    url.pathname,
    `/calendar/v3/calendars/primary/events/${googleInterviewEventId(d.transactionId)}`,
  );
  assert.equal(url.searchParams.get("sendUpdates"), "all");
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body as string)).sort(), [
    "end",
    "extendedProperties",
    "start",
  ]);
  assert.equal(calls[0].init.redirect, "error");
});
test("Cancellation sends one conditional DELETE with guest notifications, accepting only an empty successful response", async () => {
  let calls = 0;
  const source = googleEventObservation(event(), d);
  const changes = googleInterviewEventChanges((async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).searchParams.get("sendUpdates"), "all");
    assert.equal(init!.method, "DELETE");
    assert.equal(init!.body, undefined);
    assert.equal((init!.headers as Record<string, string>)["If-Match"], source.etag);
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  await changes.cancel("synthetic", d, source);
  assert.equal(calls, 1);
  await assert.rejects(
    googleInterviewEventChanges((async () =>
      response({ unexpected: true })) as typeof fetch).cancel("synthetic", d, source),
  );
});
test("Interval availability excludes only the original ID; other overlaps, all-day and incomplete results fail closed", async () => {
  let query: URL | undefined;
  const withItems = (items: unknown[], extra = {}) =>
    googleInterviewEventChanges((async (url) => {
      query = new URL(String(url));
      return response({ kind: "calendar#events", items, ...extra });
    }) as typeof fetch);
  await withItems([{ id: googleInterviewEventId(d.transactionId) }]).available("synthetic", d);
  assert.equal(query!.searchParams.get("singleEvents"), "true");
  assert.equal(query!.searchParams.get("timeMin"), d.startAt);
  await withItems([
    { id: "another", status: "cancelled" },
    { id: "transparent", transparency: "transparent" },
  ]).available("synthetic", d);
  for (const items of [
    [{ id: "another", start: { dateTime: d.startAt }, end: { dateTime: d.endAt } }],
    [{ id: "all-day", start: { date: "2030-11-03" }, end: { date: "2030-11-04" } }],
    [{ id: "malformed" }],
  ]) {
    await assert.rejects(withItems(items).available("synthetic", d));
  }
  await assert.rejects(withItems([], { nextPageToken: "more" }).available("synthetic", d));
  await googleInterviewEventChanges((async () =>
    response({ kind: "calendar#events" })) as typeof fetch).available("synthetic", d);
  await assert.rejects(
    googleInterviewEventChanges((async () => response({})) as typeof fetch).available(
      "synthetic",
      d,
    ),
  );
});
test("Recurring events, hostile entity tags and mismatched receipts cannot become an approved source", () => {
  for (const extra of [
    { recurrence: ["RRULE:FREQ=DAILY"] },
    { recurringEventId: "other" },
    { originalStartTime: { dateTime: d.startAt } },
    { etag: '"bad\\r\\nheader"\r\nunsafe' },
    { etag: "*" },
    { id: "another-event" },
  ]) {
    assert.throws(() => googleEventObservation({ ...event(), ...extra }, d));
  }
});
test("Provider rejection or network uncertainty never retries or changes the original Meet", async () => {
  for (const status of [401, 403, 404, 410, 412, 429, 500]) {
    let calls = 0;
    const changes = googleInterviewEventChanges((async () => {
      calls++;
      return new Response(null, { status });
    }) as typeof fetch);
    await assert.rejects(changes.cancel("synthetic", d, googleEventObservation(event(), d)));
    assert.equal(calls, 1);
  }
  const wrong = googleInterviewEventChanges((async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return response({
      ...event(),
      start: body.start,
      end: body.end,
      extendedProperties: body.extendedProperties,
      conferenceData: {
        conferenceSolution: { key: { type: "hangoutsMeet" } },
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/zzz-yyyy-xxx" }],
      },
    });
  }) as typeof fetch);
  await assert.rejects(
    wrong.reschedule("synthetic", d, googleEventObservation(event(), d), "change"),
  );
});
