// A native status can be set by staff or by the candidate. It is not evidence
// of who confirmed it, an external calendar reservation, or invitation delivery.
export function nativeScheduleStatusLabel(status: string): string {
  switch (status) {
    case "confirmed":
      return "Time confirmed in Lexy";
    case "pending":
      return "Awaiting time confirmation";
    case "scheduled":
      return "Scheduled in Lexy";
    case "rescheduled":
      return "Rescheduled in Lexy";
    case "cancelled":
      return "Cancelled in Lexy";
    case "completed":
      return "Completed in Lexy";
    case "no_show":
      return "No-show recorded in Lexy";
    default:
      return "Unrecognized schedule status";
  }
}

export const COORDINATOR_REFRESH_INTERVAL = 30_000;
