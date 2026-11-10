import type {
  OutlookScheduleActionInput,
  OutlookScheduleReceipt,
} from "@workspace/api-client-react";
import { requireScheduleVersion } from "./schedule-edit";

export interface CalendarScheduleView {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  version?: string;
}

export function readCalendarReceipt(
  value: unknown,
  requireReadVersion = false,
): OutlookScheduleReceipt {
  if (!value || typeof value !== "object" || !("event" in value))
    throw new Error("The calendar response could not be verified. Refresh before continuing.");
  const receipt = value as OutlookScheduleReceipt;
  if (requireReadVersion) requireScheduleVersion({ version: receipt.scheduleVersion });
  if (receipt.event !== null) {
    const event = receipt.event;
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.start !== "string" ||
      typeof event.end !== "string" ||
      !Number.isFinite(Date.parse(event.start)) ||
      !Number.isFinite(Date.parse(event.end)) ||
      !Number.isInteger(event.durationMinutes) ||
      event.durationMinutes < 5 ||
      event.durationMinutes > 480 ||
      Date.parse(event.end) - Date.parse(event.start) !== event.durationMinutes * 60_000 ||
      typeof event.cancelled !== "boolean" ||
      !(event.webLink === null || typeof event.webLink === "string")
    )
      throw new Error("The Outlook event response could not be verified.");
    if (event.webLink !== null) {
      const link = new URL(event.webLink);
      if (
        link.protocol !== "https:" ||
        link.username ||
        link.password ||
        !["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(link.hostname)
      )
        throw new Error("The Outlook event link could not be verified.");
    }
  }
  return receipt;
}

export function calendarActionInput(
  action: OutlookScheduleActionInput["action"],
  shown: CalendarScheduleView,
  read: OutlookScheduleReceipt,
): OutlookScheduleActionInput {
  const expectedVersion = requireScheduleVersion(shown);
  if (read.scheduleVersion !== expectedVersion)
    throw new Error(
      "This Lexy schedule changed. Close this dialog and review the latest schedule before continuing.",
    );
  return { action, confirm: true, expectedScheduledAt: shown.scheduledAt, expectedVersion };
}

export function verifyCalendarActionReceipt(
  value: unknown,
  action: OutlookScheduleActionInput["action"],
): OutlookScheduleReceipt {
  const receipt = readCalendarReceipt(value);
  if (
    typeof receipt.nativeChanged !== "boolean" ||
    typeof receipt.remoteChanged !== "boolean" ||
    (action === "cancel" && (receipt.event !== null || !receipt.nativeChanged)) ||
    (action === "pull" && (!receipt.event || !receipt.nativeChanged)) ||
    ((action === "create" || action === "update") &&
      (!receipt.event || receipt.event.cancelled || receipt.nativeChanged)) ||
    (action === "update" && !receipt.remoteChanged)
  )
    throw new Error(
      "The calendar action was not confirmed. Outlook may have changed; refresh both views before retrying.",
    );
  return receipt;
}
