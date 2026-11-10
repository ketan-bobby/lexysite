import { z } from "zod/v4";
import {
  stageWriteBlocker,
  stageWriteSnapshotSchema,
  type StageWriteAcknowledgment,
  type StageWriteSnapshot,
} from "./zoho-stage-write-core";

const origins = {
  us: "https://recruit.zoho.com",
  in: "https://recruit.zoho.in",
} as const;
const numericId = z.string().regex(/^[1-9]\d{0,39}$/);
const success = z.strictObject({
  data: z
    .array(
      z
        .array(
          z.object({
            code: z.literal("SUCCESS"),
            status: z.literal("success"),
            details: z.object({ id: numericId }),
          }),
        )
        .length(1),
    )
    .length(1),
});

/**
 * Candidate+job payload from Zoho Recruit's Change Status Sample Input #2:
 * https://www.zoho.com/recruit/developer-guide/apiv2/change-status.html
 *
 * This encodes the documented wire shape, NOT proof that a specific employer's
 * Applications/Blueprint configuration supports it. No default fetch or token
 * source: callers must explicitly wire verified, authorized custody later.
 */
export function zohoStageWriteHttp({
  region,
  token,
  request,
  now = Date.now,
}: {
  region: keyof typeof origins;
  token: string;
  request: typeof fetch;
  now?: () => number;
}) {
  const origin = origins[z.enum(["us", "in"]).parse(region)];
  z.string().min(1).max(16384).parse(token);
  return {
    async change(raw: StageWriteSnapshot): Promise<StageWriteAcknowledgment> {
      const snapshot = stageWriteSnapshotSchema.parse(raw);
      if (stageWriteBlocker(snapshot, now())) return "rejected";
      let response: Response;
      try {
        // Exactly one candidate and one job. Never fall back to a global candidate
        // update, generic record update, Offers, or Blueprint-revoke endpoint.
        response = await request(`${origin}/recruit/v2/Candidates/status`, {
          method: "PUT",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: [
              {
                ids: [snapshot.binding.candidateId],
                jobids: [snapshot.binding.jobId],
                Candidate_Status: snapshot.targetStatus,
                comments: "Human-approved Lexy application-stage handoff.",
              },
            ],
          }),
        });
      } catch {
        return "uncertain";
      }
      if (!response.body || response.redirected) return "uncertain";
      const reader = response.body.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 128_000) return "uncertain";
          chunks.push(chunk.value);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!response.ok) {
          const error = z
            .object({
              code: z.enum([
                "OAUTH_SCOPE_MISMATCH",
                "NO_PERMISSION",
                "AUTHORIZATION_FAILED",
                "INVALID_TOKEN",
                "INVALID_DATA",
                "RECORD_LOCKED",
              ]),
            })
            .safeParse(body);
          return response.status >= 400 && response.status < 500 && error.success
            ? "rejected"
            : "uncertain";
        }
        const parsed = success.safeParse(body);
        return parsed.success && parsed.data.data[0][0].details.id === snapshot.binding.candidateId
          ? "accepted"
          : "uncertain";
      } catch {
        return "uncertain";
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
