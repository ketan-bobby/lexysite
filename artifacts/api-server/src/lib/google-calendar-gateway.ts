import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  assertGoogleReadOperation,
  type GoogleCalendarReadGateway,
  GoogleCalendarReadError,
} from "./google-calendar-read";

/** Server-only, explicit project-connection selection; never an end-user OAuth binding. */
export function googleCalendarReadGateway(): GoogleCalendarReadGateway {
  const sdk = new ReplitConnectors();
  return {
    connections: () => sdk.listConnections({ connector_names: "google-calendar" }),
    async read(connectionId, path, options) {
      assertGoogleReadOperation(path, options);
      return sdk.proxy("google-calendar", path, {
        connectionId,
        method: options.method,
        body: options.body,
      });
    },
  };
}

/** Bound waiting for diagnostics. A late read cannot enable writes or publish calendar data. */
export async function boundedGoogleRead<T>(work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GoogleCalendarReadError("read_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
