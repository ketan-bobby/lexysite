import test from "node:test";
import assert from "node:assert/strict";
import {
  googleInterviewEvents,
  googleEventReceipt,
  googleInterviewEventId,
  safeGoogleMeetUrl,
  type GoogleEventDetails,
} from "./google-interview-event";
export const details: GoogleEventDetails = {
  transactionId: "synthetic-request",
  binding: "synthetic-binding",
  jobTitle: "Engineer",
  recipientEmail: "candidate@example.test",
  organizerEmail: "staff@example.test",
  startAt: "2030-01-01T12:00:00.000Z",
  endAt: "2030-01-01T12:30:00.000Z",
};
export function eventFixture() {
  return {
    id: googleInterviewEventId(details.transactionId),
    status: "confirmed",
    summary: "Interview: Engineer",
    organizer: { email: details.organizerEmail, self: true },
    start: { dateTime: details.startAt },
    end: { dateTime: details.endAt },
    attendees: [{ email: details.recipientEmail }],
    visibility: "private",
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: {
      private: { lexySchedule: details.binding, lexyAttempt: details.transactionId },
    },
    conferenceData: {
      createRequest: { requestId: details.transactionId, status: { statusCode: "success" } },
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
    },
  };
}
test("panel events invite and verify exactly the reviewed recipients, with guest visibility disabled", async () => {
  const panel = { ...details, panelEmails: ["panel-a@example.test", "panel-b@example.test"] };
  const remote = eventFixture();
  remote.attendees.push(...panel.panelEmails.map((email) => ({ email })));
  let calls = 0;
  const api = googleInterviewEvents(async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(
      body.attendees.map((a: { email: string }) => a.email),
      [details.recipientEmail, ...panel.panelEmails],
    );
    assert.equal(body.guestsCanSeeOtherGuests, false);
    assert.equal(body.guestsCanInviteOthers, false);
    return Response.json(remote);
  });
  assert.equal((await api.create("synthetic", panel)).conferenceStatus, "ready");
  assert.equal(calls, 1);
  assert.throws(() => googleEventReceipt(remote, details)); // solo never inherits panel guests
  for (const emails of [
    [details.recipientEmail],
    ["foreign@example.test"],
    [details.recipientEmail, ...panel.panelEmails, "extra@example.test"],
    [details.recipientEmail, panel.panelEmails[0], panel.panelEmails[0]],
  ]) {
    assert.throws(() =>
      googleEventReceipt({ ...remote, attendees: emails.map((email) => ({ email })) }, panel),
    );
  }
});
test("invalid, duplicate, organizer/candidate-colliding and overlarge panels cause no provider write", async () => {
  let calls = 0;
  const api = googleInterviewEvents(async () => {
    calls++;
    return Response.json(eventFixture());
  });
  for (const panelEmails of [
    ["invalid"],
    [details.recipientEmail],
    [details.organizerEmail],
    ["a@example.test", "A@example.test"],
    Array(6).fill("too-many@example.test"),
  ]) {
    await assert.rejects(api.create("synthetic", { ...details, panelEmails }));
  }
  assert.equal(calls, 0);
});
test("Google inserts exactly one private guest event and a new Meet request, never patch/list/retry", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = googleInterviewEvents(async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json(eventFixture());
  });
  const receipt = await api.create("synthetic-access", details);
  assert.equal(receipt.conferenceStatus, "ready");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
  );
  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body.attendees, [
    { email: details.recipientEmail, responseStatus: "needsAction" },
  ]);
  assert.equal(body.guestsCanSeeOtherGuests, false);
  assert.equal(body.guestsCanInviteOthers, false);
  assert.match(body.id, /^[0-9a-v]{5,1024}$/);
  assert.equal(body.conferenceData.createRequest.requestId, details.transactionId);
  assert.equal(calls[0].init.redirect, "error");
  await api.read("synthetic-access", details);
  assert.equal(calls[1].init.method, "GET");
  assert.ok(!calls[1].init.body);
});
test("Google event validation binds identity, guest, interval, private flags and durable attempt", () => {
  for (const patch of [
    { id: "wrong" },
    { status: "cancelled" },
    { summary: "another role" },
    { organizer: { email: "foreign@example.test", self: true } },
    { organizer: { email: details.organizerEmail, self: false } },
    { attendees: [{ email: "foreign@example.test" }] },
    { attendees: [{ email: details.recipientEmail }, { email: "extra@example.test" }] },
    { attendees: [{ email: details.recipientEmail, additionalGuests: 1 }] },
    { attendeesOmitted: true },
    { guestsCanInviteOthers: true },
    { guestsCanSeeOtherGuests: true },
    { guestsCanModify: true },
    { visibility: "public" },
    { start: { dateTime: "2030-01-01T13:00:00Z" } },
    {
      extendedProperties: {
        private: { lexySchedule: "foreign", lexyAttempt: details.transactionId },
      },
    },
  ])
    assert.throws(() => googleEventReceipt({ ...eventFixture(), ...patch }, details));
});
test("Meet is asynchronous: pending and failure are honest; malicious or contradictory links fail closed", () => {
  const event = eventFixture();
  const pending = {
    ...event,
    conferenceData: {
      createRequest: { requestId: details.transactionId, status: { statusCode: "pending" } },
    },
  };
  assert.deepEqual(googleEventReceipt(pending, details), {
    id: event.id,
    meetUrl: null,
    conferenceStatus: "pending",
  });
  assert.equal(
    googleEventReceipt(
      {
        ...pending,
        conferenceData: {
          createRequest: { requestId: details.transactionId, status: { statusCode: "failure" } },
        },
      },
      details,
    ).conferenceStatus,
    "failed",
  );
  for (const uri of [
    "javascript:alert(1)",
    "https://meet.google.com.evil.test/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij?x=1",
    "https://evil.test",
    "https://user:pass@meet.google.com/abc-defg-hij",
  ]) {
    assert.equal(safeGoogleMeetUrl(uri), false);
    assert.throws(() =>
      googleEventReceipt(
        {
          ...event,
          conferenceData: {
            ...event.conferenceData,
            entryPoints: [{ entryPointType: "video", uri }],
          },
        },
        details,
      ),
    );
  }
  assert.throws(() =>
    googleEventReceipt(
      { ...event, conferenceData: { ...event.conferenceData, entryPoints: [] } },
      details,
    ),
  );
  assert.throws(() =>
    googleEventReceipt(
      {
        ...event,
        conferenceData: {
          ...event.conferenceData,
          createRequest: { requestId: "foreign", status: { statusCode: "success" } },
        },
      },
      details,
    ),
  );
});
test("Read/insert failures never retry and don't leak Google payloads; unsupported Meet fails before insertion", async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    let count = 0;
    const api = googleInterviewEvents(async () => {
      count++;
      return Response.json({ private: "provider-private-body" }, { status });
    });
    await assert.rejects(
      api.create("synthetic-access", details),
      (e) => !String(e).includes("provider-private-body"),
    );
    assert.equal(count, 1);
  }
  const api = googleInterviewEvents(async () =>
    Response.json({ id: "primary", conferenceProperties: { allowedConferenceSolutionTypes: [] } }),
  );
  await assert.rejects(api.canMeet("synthetic-access"));
});
