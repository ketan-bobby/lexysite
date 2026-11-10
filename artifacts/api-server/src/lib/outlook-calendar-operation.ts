import {
  CalendarError,
  CALENDAR_BINDING,
  assertCalendarAvailable,
  assertPersonalHold,
  eventView,
  linkedCalendarEvent,
  scheduleBinding,
  type CalendarRequest,
  type GraphEvent,
} from "./outlook-calendar-core";
import { scheduleVersion, SCHEDULE_CHANGED_MESSAGE } from "./coordinator-schedule-version";

export interface CalendarSchedule {
  id: string;
  tenantId: string;
  scheduledAt: Date;
  durationMinutes: number;
  status: string;
}
export interface CalendarAction {
  action: "create" | "update" | "pull" | "cancel";
  expectedScheduledAt: string;
  expectedVersion?: string;
  confirm: true;
}
export type NativeCalendarChange = {
  status: "cancelled" | "rescheduled";
  scheduledAt?: Date;
  durationMinutes?: number;
};

export function assertCalendarScheduleCurrent(input: CalendarAction, schedule: CalendarSchedule) {
  if (
    new Date(input.expectedScheduledAt).getTime() !== schedule.scheduledAt.getTime() ||
    (input.expectedVersion !== undefined &&
      input.expectedVersion !== scheduleVersion({ ...schedule }))
  )
    throw new CalendarError(409, "schedule_changed", SCHEDULE_CHANGED_MESSAGE);
}

/** Explicit human action. No invites; provider errors propagate without pretending success. */
export async function applyCalendarAction(
  input: CalendarAction,
  context: {
    callerId: string;
    schedule: CalendarSchedule;
    jobTitle: string;
    jobApproved: boolean;
  },
  request: CalendarRequest,
  updateNative: (change: NativeCalendarChange) => Promise<boolean>,
) {
  const { schedule } = context;
  if (input.confirm !== true)
    throw new CalendarError(400, "confirmation_required", "Confirm the calendar action first.");
  assertCalendarScheduleCurrent(input, schedule);
  if (input.action !== "cancel" && !context.jobApproved) {
    throw new CalendarError(
      409,
      "job_not_approved",
      "This work order must be approved before booking or moving an interview.",
    );
  }
  if (
    schedule.status === "completed" ||
    (schedule.status === "cancelled" && input.action !== "cancel")
  ) {
    throw new CalendarError(409, "schedule_closed", "This schedule is closed.");
  }
  const binding = scheduleBinding(schedule.tenantId, schedule.id);
  let event: GraphEvent | null = await linkedCalendarEvent(request, binding);
  if (event) assertPersonalHold(event);
  let nativeChanged = false;
  let remoteChanged = false;
  if (input.action === "pull" || input.action === "cancel") {
    if (input.action === "pull" && !event)
      throw new CalendarError(
        404,
        "event_not_found",
        "No linked Outlook event was found. No Lexy data was changed.",
      );
    const provider = eventView(event);
    if (input.action === "cancel" && event) {
      if (!event["@odata.etag"])
        throw new CalendarError(
          409,
          "revision_required",
          "Outlook did not provide an event revision. No change was made.",
        );
      await request(`/me/events/${encodeURIComponent(event.id)}`, {
        method: "DELETE",
        headers: { "If-Match": event["@odata.etag"] },
      });
      remoteChanged = true;
      event = null;
    }
    const updated = await updateNative(
      input.action === "cancel" || provider?.cancelled
        ? { status: "cancelled" }
        : {
            scheduledAt: new Date(provider!.start),
            durationMinutes: provider!.durationMinutes,
            status: "rescheduled",
          },
    );
    if (!updated)
      throw new CalendarError(
        409,
        "reconciliation_required",
        "The native schedule changed during this operation. Outlook may already have changed; refresh both views before continuing.",
      );
    nativeChanged = true;
  } else {
    if (input.action === "create" && event)
      return { event: eventView(event), nativeChanged: false, remoteChanged: false };
    if (input.action === "update" && !event)
      throw new CalendarError(404, "event_not_found", "Add this schedule to Outlook first.");
    if (event && !event["@odata.etag"])
      throw new CalendarError(
        409,
        "revision_required",
        "Outlook did not provide an event revision. No change was made.",
      );
    const start = schedule.scheduledAt.toISOString();
    const end = new Date(
      schedule.scheduledAt.getTime() + schedule.durationMinutes * 60000,
    ).toISOString();
    if (
      schedule.scheduledAt.getTime() < Date.now() ||
      schedule.durationMinutes < 5 ||
      schedule.durationMinutes > 480
    ) {
      throw new CalendarError(
        400,
        "invalid_schedule",
        "Choose a future interview lasting 5 minutes to 8 hours.",
      );
    }
    await assertCalendarAvailable(request, start, end, event?.id);
    const body = {
      subject: `Lexy interview — ${context.jobTitle}`.slice(0, 255),
      body: {
        contentType: "Text",
        content:
          "Interview calendar hold created in Lexy. Candidate invitations are managed separately in Lexy.",
      },
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
      showAs: "busy",
      sensitivity: "private",
      allowNewTimeProposals: false,
    };
    const headers: Record<string, string> = {};
    if (event?.["@odata.etag"]) headers["If-Match"] = event["@odata.etag"];
    event = await request<GraphEvent>(
      event ? `/me/events/${encodeURIComponent(event.id)}` : "/me/events",
      {
        method: event ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(
          event
            ? body
            : {
                ...body,
                transactionId: scheduleBinding(context.callerId, binding),
                attendees: [],
                singleValueExtendedProperties: [{ id: CALENDAR_BINDING, value: binding }],
              },
        ),
      },
    );
    remoteChanged = true;
  }
  return { event: eventView(event), nativeChanged, remoteChanged };
}
