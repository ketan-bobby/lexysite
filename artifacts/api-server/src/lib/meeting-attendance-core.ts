import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class AttendanceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const attendanceApprovalInput = z
  .object({
    scheduleId: z.string().uuid(),
    consent: z.literal(true),
    consentStatement: z.string().trim().min(20).max(1500),
  })
  .strict();
export const attendanceWorkspaceInput = z
  .object({
    connectionId: z.string().min(1).max(255),
    authorized: z.literal(true),
  })
  .strict();
export const attendanceImportInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
    consent: z.literal(true),
    consentStatement: z.string().trim().min(20).max(1500),
    plannedQuestions: z.string().max(6000).default(""),
  })
  .strict();
export const attendanceHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function zoomAttendanceUrl(raw: string, meetingId: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    !(u.hostname === "zoom.us" || u.hostname.endsWith(".zoom.us")) ||
    u.pathname !== `/j/${meetingId}` ||
    [...u.searchParams.keys()].some((key) => key !== "pwd")
  )
    throw new AttendanceError(409, "The managed Zoom meeting link is not valid for capture.");
  return u.toString();
}
export function recallBotConfiguration(
  input: {
    id: string;
    token: string;
    joinUrl: string;
    meetingId: string;
    scheduledAt: Date;
    durationMinutes: number;
  },
  now = Date.now(),
) {
  if (
    input.durationMinutes < 1 ||
    input.durationMinutes > 60 ||
    input.scheduledAt.getTime() + input.durationMinutes * 60_000 <= now
  )
    throw new AttendanceError(409, "Choose an upcoming appointment of up to 60 minutes.");
  return {
    meeting_url: zoomAttendanceUrl(input.joinUrl, input.meetingId),
    bot_name: "Lexy — Interview Assistant",
    ...(input.scheduledAt.getTime() > now + 60_000
      ? { join_at: input.scheduledAt.toISOString() }
      : {}),
    metadata: { lexy_attendance: input.id, lexy_dispatch: input.token },
    recording_config: {
      audio_mixed_mp3: {},
      video_mixed_mp4: null,
      participant_events: null,
      meeting_metadata: null,
      transcript: null,
      realtime_endpoints: [],
      retention: { type: "timed", hours: 24 },
    },
    breakout_room: { mode: "join_main_room" },
    chat: {
      on_bot_join: {
        send_to: "everyone",
        message:
          "Lexy is capturing audio for private, human-reviewed interview notes with participant consent. Ask the host to stop Lexy at any time.",
      },
      on_participant_join: {
        exclude_host: false,
        message:
          "Lexy is capturing audio for private interview notes with participant consent. Ask the host to stop Lexy at any time.",
      },
    },
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 600,
      in_call_not_recording_timeout: 120,
      recording_permission_denied_timeout: 30,
      in_call_recording_timeout: input.durationMinutes * 60,
    },
  };
}
export function verifyRecallWebhook(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  now = Date.now(),
) {
  const modern = headers["webhook-id"] !== undefined;
  const prefix = modern ? "webhook" : "svix";
  const id = headers[`${prefix}-id`],
    timestamp = headers[`${prefix}-timestamp`],
    signatures = headers[`${prefix}-signature`];
  if (
    !secret?.startsWith("whsec_") ||
    typeof id !== "string" ||
    id.length > 255 ||
    typeof timestamp !== "string" ||
    !/^\d{10,12}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    typeof signatures !== "string" ||
    signatures.length > 4096
  )
    throw new AttendanceError(401, "Recall webhook verification failed.");
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
  const valid = signatures.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const bytes = Buffer.from(sig, "base64");
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
  if (!valid) throw new AttendanceError(401, "Recall webhook verification failed.");
  return attendanceHash(id);
}
export const recallEventInput = z.object({
  event: z.string().max(100),
  data: z.object({
    data: z.object({
      code: z.string().max(100),
      updated_at: z.string().datetime({ offset: true }),
    }),
    bot: z.object({
      id: z.string().uuid(),
      metadata: z.object({ lexy_attendance: z.string().uuid(), lexy_dispatch: z.string().uuid() }),
    }),
  }),
});
export const recallState = (code: string) =>
  ({
    joining_call: "joining",
    in_waiting_room: "waiting",
    in_call_not_recording: "joining",
    in_call_recording: "recording",
    call_ended: "processing",
    done: "done",
    fatal: "failed",
  })[code] ?? null;
