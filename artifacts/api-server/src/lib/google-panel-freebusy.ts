import { z } from "zod/v4";
import { googlePanelUnknown } from "./google-panel-times";
import type { PanelBusyInterval } from "./panel-calendar-slots";

const instant = z.iso.datetime({ offset: true });
const interval = z.object({ start: instant, end: instant });
/** Owned primary calendar only. The project connector is never used. */
export async function readGooglePanelCalendar(
  token: string,
  start: string,
  end: string,
  request: typeof fetch = fetch,
): Promise<PanelBusyInterval[]> {
  async function read(url: string, body?: unknown) {
    try {
      const response = await request(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!response.ok) throw googlePanelUnknown();
      return await response.json();
    } catch {
      throw googlePanelUnknown();
    }
  }
  const primary = z
    .object({ id: z.string().min(1).max(1024) })
    .safeParse(await read("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id"));
  if (!primary.success) throw googlePanelUnknown();
  const id = primary.data.id;
  const result = z
    .object({
      timeMin: instant,
      timeMax: instant,
      groups: z.record(z.string(), z.unknown()).optional(),
      calendars: z.record(
        z.string(),
        z.object({
          errors: z.array(z.unknown()).max(0).optional(),
          busy: z.array(interval).max(2048),
        }),
      ),
    })
    .safeParse(
      await read("https://www.googleapis.com/calendar/v3/freeBusy", {
        timeMin: start,
        timeMax: end,
        timeZone: "UTC",
        calendarExpansionMax: 1,
        items: [{ id }],
      }),
    );
  if (
    !result.success ||
    Date.parse(result.data.timeMin) !== Date.parse(start) ||
    Date.parse(result.data.timeMax) !== Date.parse(end) ||
    Object.keys(result.data.calendars).length !== 1 ||
    !result.data.calendars[id] ||
    Object.keys(result.data.groups ?? {}).length
  )
    throw googlePanelUnknown();
  return result.data.calendars[id].busy.map((p) => {
    if (
      Date.parse(p.end) <= Date.parse(p.start) ||
      Date.parse(p.end) <= Date.parse(start) ||
      Date.parse(p.start) >= Date.parse(end)
    )
      throw googlePanelUnknown();
    return {
      showAs: "busy",
      start: { dateTime: new Date(p.start).toISOString(), timeZone: "UTC" },
      end: { dateTime: new Date(p.end).toISOString(), timeZone: "UTC" },
    };
  });
}
