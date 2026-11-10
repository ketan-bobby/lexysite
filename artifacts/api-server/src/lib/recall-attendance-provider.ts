import { ReplitConnectors } from "@replit/connectors-sdk";
import { z } from "zod";
import { AttendanceError, recallBotConfiguration } from "./meeting-attendance-core";
import { boundedRecordingBody } from "./zoom-recordings-provider";
import { MAX_MEETING_BYTES } from "./meeting-notes-core";
import { meteredFetch } from "./vendor-usage";

type Gateway = Pick<ReplitConnectors, "proxy" | "listConnections">;
const uuid = z.string().uuid();
const receipt = z.object({
  id: uuid,
  metadata: z.object({ lexy_attendance: uuid, lexy_dispatch: uuid }),
  join_at: z.string().nullable().optional(),
  status_changes: z.array(z.object({ code: z.string(), created_at: z.string() })).default([]),
  recordings: z
    .array(
      z.object({
        id: uuid,
        started_at: z.string().datetime({ offset: true }).nullable().optional(),
        completed_at: z.string().datetime({ offset: true }).nullable().optional(),
        media_shortcuts: z
          .object({
            audio_mixed: z
              .object({
                status: z.object({ code: z.string() }),
                data: z.object({ download_url: z.string().url() }).nullable().optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
});
export type RecallBotReceipt = z.infer<typeof receipt>;

export function recallAttendanceProvider(gateway: Gateway = new ReplitConnectors()) {
  // The proxy still owns credentials/region. Meter only fixed operation labels,
  // never meeting URLs, consent text, IDs or arbitrary provider payloads.
  const observed = meteredFetch(
    "recall",
    async (input, init) =>
      gateway.proxy("recall-ai", new URL(String(input)).pathname + new URL(String(input)).search, {
        connectionId: (init as RequestInit & { connectionId: string }).connectionId,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      }),
    undefined,
    { operationKey: "meeting_assistant" },
  );
  async function call(connectionId: string, path: string, method = "GET", body?: unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        observed(`https://recall.invalid${path}`, {
          connectionId,
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        } as RequestInit),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AttendanceError(
                  503,
                  "Recall did not confirm the operation. Recover the existing attempt; do not dispatch another assistant.",
                ),
              ),
            12_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function read(connectionId: string, botId: string) {
    const r = await call(connectionId, `/api/v1/bot/${uuid.parse(botId)}/`);
    if (!r.ok) {
      await r.body?.cancel();
      throw new AttendanceError(503, "Recall did not confirm this assistant's current state.");
    }
    return receipt.parse(await r.json());
  }
  return {
    async connections() {
      return (await gateway.listConnections({ connector_names: "recall-ai" }))
        .filter((c) => c.connector_name === "recall-ai")
        .map((c) => ({ id: c.id }));
    },
    async probe(connectionId: string) {
      if (!(await this.connections()).some((c) => c.id === connectionId))
        throw new AttendanceError(409, "The selected Recall workspace is no longer available.");
      const r = await call(connectionId, "/api/v1/bot/?page_size=1");
      await r.body?.cancel();
      if (!r.ok)
        throw new AttendanceError(503, "Recall workspace authorization was not confirmed.");
    },
    async create(connectionId: string, input: Parameters<typeof recallBotConfiguration>[0]) {
      // Exactly one create call; no automatic retry, including non-2xx responses.
      const r = await call(connectionId, "/api/v1/bot/", "POST", recallBotConfiguration(input));
      if (!r.ok) {
        await r.body?.cancel();
        throw new AttendanceError(
          503,
          "Dispatch was not confirmed. Recover the saved attempt before any retry.",
        );
      }
      return receipt.parse(await r.json());
    },
    read,
    async recover(connectionId: string, id: string, token: string) {
      const r = await call(
        connectionId,
        `/api/v1/bot/?metadata__lexy_attendance=${uuid.parse(id)}&page_size=2`,
      );
      if (!r.ok) {
        await r.body?.cancel();
        throw new AttendanceError(503, "Recovery was not confirmed.");
      }
      const list = z
        .object({ next: z.string().nullable(), results: z.array(receipt) })
        .parse(await r.json());
      const matches = list.results.filter(
        (b) => b.metadata.lexy_attendance === id && b.metadata.lexy_dispatch === token,
      );
      if (list.next || matches.length !== 1)
        throw new AttendanceError(
          409,
          "No unique provider receipt is available yet. Keep this attempt on hold; no new assistant was sent.",
        );
      return matches[0]!;
    },
    async stop(connectionId: string, botId: string) {
      const bot = await read(connectionId, botId);
      const code = bot.status_changes.at(-1)?.code;
      if (code === "done") return "ended" as const;
      // Fatal/call-ended recordings can still be uploading. Wait for bot.done
      // before claiming deletion covers every artifact.
      if (code === "fatal" || code === "call_ended") return "pending" as const;
      // Scheduled bots must be cancelled, not sent a leave command.
      const scheduled = Boolean(
        bot.join_at &&
        !bot.status_changes.some((s) =>
          [
            "joining_call",
            "in_waiting_room",
            "in_call_not_recording",
            "in_call_recording",
          ].includes(s.code),
        ),
      );
      const r = await call(
        connectionId,
        `/api/v1/bot/${uuid.parse(botId)}/${scheduled ? "" : "leave_call/"}`,
        scheduled ? "DELETE" : "POST",
      );
      await r.body?.cancel();
      if (!r.ok)
        throw new AttendanceError(
          503,
          "Recall has not confirmed stop/cancellation. Cleanup remains pending.",
        );
      return scheduled ? ("cancelled" as const) : ("pending" as const);
    },
    async deleteMedia(connectionId: string, botId: string) {
      const r = await call(connectionId, `/api/v1/bot/${uuid.parse(botId)}/delete_media/`, "POST");
      await r.body?.cancel();
      if (!r.ok) throw new AttendanceError(503, "Provider recording deletion remains pending.");
    },
    async audio(connectionId: string, botId: string, id: string, token: string) {
      const bot = await read(connectionId, botId);
      if (
        bot.id !== botId ||
        bot.metadata.lexy_attendance !== id ||
        bot.metadata.lexy_dispatch !== token ||
        bot.status_changes.at(-1)?.code !== "done" ||
        bot.recordings.length !== 1
      )
        throw new AttendanceError(409, "A unique completed recording is not available.");
      const audio = bot.recordings[0]!.media_shortcuts?.audio_mixed;
      if (audio?.status.code !== "done" || !audio.data?.download_url)
        throw new AttendanceError(409, "Recall has not produced a downloadable audio recording.");
      const url = new URL(audio.data.download_url);
      // Recall media is hosted on regional S3; never fetch user-supplied or redirected URLs.
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        !/^[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
      )
        throw new AttendanceError(503, "Recall returned an unsupported media host.");
      const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (!r.ok) {
        await r.body?.cancel();
        throw new AttendanceError(503, "The recording could not be downloaded.");
      }
      const recording = bot.recordings[0]!;
      if (!recording.started_at || !recording.completed_at)
        throw new AttendanceError(409, "Recall has not confirmed the recording's time bounds.");
      return {
        bytes: await boundedRecordingBody(r, MAX_MEETING_BYTES),
        recordingId: recording.id,
        startedAt: recording.started_at,
        completedAt: recording.completed_at,
      };
    },
  };
}
