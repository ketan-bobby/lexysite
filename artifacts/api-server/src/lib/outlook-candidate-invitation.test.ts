import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invitedCandidate,
  invitedRecipients,
  invitationRecipientHash,
  sendCandidateCalendarInvitation,
} from "./outlook-candidate-invitation";
import {
  CalendarError,
  linkedCalendarEvent,
  type CalendarRequest,
  type GraphEvent,
} from "./outlook-calendar-core";

const start = "2035-11-01T10:00:00.000Z";
const end = "2035-11-01T11:00:00.000Z";
const input = {
  scheduleId: "synthetic-invite",
  tenantId: "synthetic-employer",
  jobTitle: "Test role",
  candidateEmail: "candidate@example.invalid",
  start,
  end,
  transactionId: "stable-synthetic-transaction",
};
function event(attendees: GraphEvent["attendees"] = []): GraphEvent {
  return {
    id: "immutable-graph-event",
    "@odata.etag": "etag-1",
    start: { dateTime: start, timeZone: "UTC" },
    end: { dateTime: end, timeZone: "UTC" },
    isOrganizer: true,
    type: "singleInstance",
    attendees,
  };
}
function stub(
  records: Array<{ path: string; init?: RequestInit }>,
  result: GraphEvent = event([{ emailAddress: { address: "candidate@example.invalid" } }]),
  busy = false,
): CalendarRequest {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    records.push({ path, init });
    if (path.includes("/me/calendarView?")) return { value: busy ? [event()] : [] } as T;
    return result as T;
  };
}

test("a candidate-only invitation is created explicitly with a stable transaction id", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const saved = await sendCandidateCalendarInvitation(stub(calls), input, null);
  assert.ok(invitedCandidate(saved, input.candidateEmail, start, end));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, "/me/events");
  assert.equal(calls[1].init?.method, "POST");
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.transactionId, input.transactionId);
  assert.deepEqual(body.attendees, [
    {
      emailAddress: { address: input.candidateEmail },
      type: "required",
    },
  ]);
  assert.equal(body.allowNewTimeProposals, false);
  assert.equal(body.singleValueExtendedProperties.length, 1);
  assert.ok(!JSON.stringify(body).includes("panel@example"));
  assert.equal(
    invitationRecipientHash(" CANDIDATE@example.invalid "),
    invitationRecipientHash(input.candidateEmail),
  );
});

test("an existing personal hold is converted only with its exact revision", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  await sendCandidateCalendarInvitation(stub(calls), input, event());
  assert.equal(calls[1].init?.method, "PATCH");
  assert.equal(new Headers(calls[1].init?.headers).get("If-Match"), "etag-1");
  assert.equal(JSON.parse(String(calls[1].init?.body)).transactionId, undefined);
});

test("guest events, changed holds and busy calendars never send", async () => {
  for (const existing of [
    event([{ emailAddress: { address: "someoneelse@example.invalid" } }]),
    { ...event(), start: { dateTime: "2035-11-01T12:00:00Z", timeZone: "UTC" } },
    { ...event(), "@odata.etag": undefined },
  ]) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    await assert.rejects(
      sendCandidateCalendarInvitation(stub(calls), input, existing),
      (error: unknown) => error instanceof CalendarError && error.status === 409,
    );
    assert.ok(calls.every((call) => call.init?.method !== "POST" && call.init?.method !== "PATCH"));
  }
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  await assert.rejects(
    sendCandidateCalendarInvitation(stub(calls, event(), true), input, null),
    (error: unknown) => error instanceof CalendarError && error.code === "calendar_conflict",
  );
  assert.equal(calls.length, 1);
});

test("an ambiguous Graph response remains uncertain rather than claiming a sent invitation", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  await assert.rejects(
    sendCandidateCalendarInvitation(
      stub(calls, event([{ emailAddress: { address: "other@example.invalid" } }])),
      input,
      null,
    ),
    (error: unknown) => error instanceof CalendarError && error.code === "invitation_uncertain",
  );
  assert.equal(calls.filter((call) => call.init?.method === "POST").length, 1);
  assert.equal(
    invitedCandidate(
      event([
        { emailAddress: { address: input.candidateEmail } },
        { emailAddress: { address: "unexpected-guest@example.invalid" } },
      ]),
      input.candidateEmail,
      start,
      end,
    ),
    false,
  );
});

test("panel invitations request hidden attendees and verify the entire exact roster", async () => {
  const emails = [input.candidateEmail, "panel@example.invalid"];
  const accepted = {
    ...event(emails.map((address) => ({ emailAddress: { address } }))),
    hideAttendees: true,
  };
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  await sendCandidateCalendarInvitation(
    stub(calls, accepted),
    { ...input, panelEmails: [emails[1]] },
    null,
  );
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.hideAttendees, true);
  assert.equal(body.attendees.length, 2);
  assert.equal(body.transactionId, input.transactionId);
  assert.equal(invitedRecipients(accepted, emails, start, end, true), true);
  for (const changed of [
    { ...accepted, hideAttendees: false },
    {
      ...accepted,
      attendees: [...accepted.attendees!, { emailAddress: { address: "extra@example.invalid" } }],
    },
    { ...accepted, attendees: [accepted.attendees![0], accepted.attendees![0]] },
    { ...accepted, attendees: [accepted.attendees![0]] },
  ]) {
    assert.equal(invitedRecipients(changed, emails, start, end, true), false);
    await assert.rejects(
      sendCandidateCalendarInvitation(
        stub([], changed),
        { ...input, panelEmails: [emails[1]] },
        null,
      ),
      (error: unknown) => error instanceof CalendarError && error.code === "invitation_uncertain",
    );
  }
});

test("read-only invitation reconciliation explicitly selects attendee privacy from Microsoft", async () => {
  let select = "";
  const request: CalendarRequest = async <T>(path: string): Promise<T> => {
    select = new URL(path).searchParams.get("$select") ?? "";
    return { value: [] } as T;
  };
  assert.equal(await linkedCalendarEvent(request, "a".repeat(64)), null);
  assert.ok(select.split(",").includes("hideAttendees"));
});
