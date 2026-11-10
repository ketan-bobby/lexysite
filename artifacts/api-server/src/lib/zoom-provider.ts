import { z } from "zod/v4";
import { CalendarError } from "./outlook-calendar-core";
import { zoomJoinUrl } from "./staff-zoom-link";

export type ZoomAppConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  settingsUrl: string;
};

/** Customer OAuth, never a project connector or a server-to-server account grant. */
export function zoomAppConfig(env = process.env): ZoomAppConfig | null {
  const clientId = env.ZOOM_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.ZOOM_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.ZOOM_OAUTH_REDIRECT_URI?.trim();
  const settingsUrl = env.ZOOM_OAUTH_SETTINGS_URL?.trim();
  if (!clientId || !clientSecret || !redirectUri || !settingsUrl || !env.SESSION_SECRET)
    return null;
  try {
    const callback = new URL(redirectUri);
    const settings = new URL(settingsUrl);
    if (
      callback.protocol !== "https:" ||
      callback.pathname !== "/api/zoom-account/callback" ||
      settings.protocol !== "https:" ||
      !settings.pathname.endsWith("/settings/calendar") ||
      callback.search ||
      settings.search ||
      callback.hash ||
      settings.hash ||
      callback.username ||
      settings.username ||
      callback.password ||
      settings.password
    )
      return null;
    return { clientId, clientSecret, redirectUri, settingsUrl };
  } catch {
    return null;
  }
}

const errorMessages: Record<string, string> = {
  zoom_evidence_unavailable:
    "Zoom evidence does not prove this exact operation succeeded. The operation remains unresolved. Check the original host, meeting and appointment; do not create a replacement automatically.",
  zoom_setup_required: "Zoom app setup is required before staff can connect.",
  zoom_reconnect_required: "Reconnect the original Zoom host account before continuing.",
  zoom_needs_review:
    "Zoom may have accepted this operation. Check it in Zoom before retrying; automatic retries are blocked.",
  zoom_meetings_active:
    "Cancel or reconcile your active managed Zoom meetings before disconnecting this account.",
  zoom_existing_host_required:
    "Connect the original Zoom host account while its managed meetings are still active.",
  zoom_account_changed: "Your Zoom authorization changed. Reload and review again.",
  zoom_consent_required: "Explicit confirmation is required.",
};
export const zoomProviderError = (code = "zoom_provider_unavailable", status = 503) =>
  new CalendarError(
    status,
    code,
    errorMessages[code] ??
      "Zoom could not confirm this operation. Reload its status before taking another action.",
  );
const token = z
  .object({
    access_token: z.string().min(1).max(16384),
    refresh_token: z.string().min(1).max(16384),
  })
  .passthrough();
const account = z
  .object({
    id: z.string().min(1).max(255),
    email: z.email().max(254),
  })
  .passthrough();
const meeting = z
  .object({
    id: z.union([z.string().regex(/^\d{9,15}$/), z.number().int().positive()]),
    join_url: z.string().min(1).max(2048),
    start_time: z.iso.datetime({ offset: true }).optional(),
  })
  .passthrough();
export type ZoomMeetingReceipt = { meetingId: string; joinUrl: string };
export const zoomOperationMarker = (operationId: string) => `Lexy operation: ${operationId}`;
export type ZoomMeetingEvidence = ZoomMeetingReceipt & {
  hostZoomId: string;
  topic: string;
  startTime: string;
  durationMinutes: number;
  agenda: string;
};

export function zoomProvider(config: ZoomAppConfig, request: typeof fetch = fetch) {
  async function send(url: string, init: RequestInit, allowNotFound = false) {
    let res: Response;
    try {
      res = await request(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw zoomProviderError();
    }
    if (res.status === 401 || res.status === 403)
      throw zoomProviderError("zoom_reconnect_required", 409);
    if (!res.ok && !(allowNotFound && res.status === 404)) throw zoomProviderError();
    return res;
  }
  async function exchange(params: Record<string, string>) {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await send("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
    try {
      return token.parse(await res.json());
    } catch {
      throw zoomProviderError();
    }
  }
  async function api(
    accessToken: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    allowNotFound = false,
  ) {
    return send(
      `https://api.zoom.us/v2${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      allowNotFound,
    );
  }
  const details = (raw: unknown): ZoomMeetingReceipt => {
    try {
      const parsed = meeting.parse(raw);
      return {
        meetingId: String(parsed.id),
        joinUrl: zoomJoinUrl(parsed.join_url),
      };
    } catch {
      throw zoomProviderError("zoom_receipt_invalid");
    }
  };
  return {
    authorizeUrl(state: string) {
      const url = new URL("https://zoom.us/oauth/authorize");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        state,
      }).toString();
      return url.toString();
    },
    async authorize(code: string) {
      const credentials = await exchange({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      });
      const res = await api(credentials.access_token, "GET", "/users/me");
      let identity: z.infer<typeof account>;
      try {
        identity = account.parse(await res.json());
      } catch {
        throw zoomProviderError("zoom_identity_unverified");
      }
      return {
        zoomUserId: identity.id,
        email: identity.email,
        refreshToken: credentials.refresh_token,
      };
    },
    refresh: (refreshToken: string) =>
      exchange({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async create(
      accessToken: string,
      topic: string,
      start: string,
      duration: number,
      operationId?: string,
    ) {
      const res = await api(accessToken, "POST", "/users/me/meetings", {
        topic,
        type: 2,
        start_time: start,
        duration,
        timezone: "UTC",
        ...(operationId ? { agenda: zoomOperationMarker(operationId) } : {}),
        settings: { waiting_room: true, join_before_host: false },
      });
      return details(await res.json());
    },
    async read(accessToken: string, meetingId: string) {
      const res = await api(accessToken, "GET", `/meetings/${encodeURIComponent(meetingId)}`);
      const receipt = details(await res.json());
      if (receipt.meetingId !== meetingId) throw zoomProviderError("zoom_receipt_invalid");
      return receipt;
    },
    async inspect(accessToken: string, meetingId: string): Promise<ZoomMeetingEvidence | null> {
      const res = await api(
        accessToken,
        "GET",
        `/meetings/${encodeURIComponent(meetingId)}`,
        undefined,
        true,
      );
      const raw = await res.json().catch(() => null);
      if (res.status === 404) {
        // Only Zoom's documented missing-meeting result proves absence.
        // Generic 404s, permission failures and invalid JSON remain unknown.
        if (z.object({ code: z.literal(3001) }).safeParse(raw).success) return null;
        throw zoomProviderError("zoom_evidence_unavailable", 409);
      }
      const parsed = z
        .object({
          host_id: z.string().min(1).max(255),
          type: z.literal(2),
          topic: z.string().max(1000),
          start_time: z.iso.datetime({ offset: true }),
          duration: z.number().int().positive(),
          agenda: z.string().max(8192).optional(),
        })
        .safeParse(raw);
      const receipt = details(raw);
      if (!parsed.success || receipt.meetingId !== meetingId)
        throw zoomProviderError("zoom_evidence_unavailable", 409);
      return {
        ...receipt,
        hostZoomId: parsed.data.host_id,
        topic: parsed.data.topic,
        startTime: parsed.data.start_time,
        durationMinutes: parsed.data.duration,
        agenda: parsed.data.agenda ?? "",
      };
    },
    async update(
      accessToken: string,
      meetingId: string,
      start: string,
      duration: number,
      operationId?: string,
    ) {
      await api(accessToken, "PATCH", `/meetings/${encodeURIComponent(meetingId)}`, {
        start_time: start,
        duration,
        timezone: "UTC",
        ...(operationId ? { agenda: zoomOperationMarker(operationId) } : {}),
      });
      return this.read(accessToken, meetingId);
    },
    async remove(accessToken: string, meetingId: string) {
      await api(accessToken, "DELETE", `/meetings/${encodeURIComponent(meetingId)}`);
    },
  };
}
