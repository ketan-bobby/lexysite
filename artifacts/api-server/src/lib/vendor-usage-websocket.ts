import { randomUUID } from "node:crypto";
import { attemptWriter, vendorUsageScope, type Attempt, type UsageSink } from "./vendor-usage";

/** One iFlytek recognition session, not individual PCM frames or HTTP calls.
 * No fabricated HTTP receipt, seconds, transcript or signed connection URL. */
export async function observeWebsocketStt<T>(
  audioBytes: number,
  recognize: () => Promise<T>,
  sink?: UsageSink,
): Promise<T> {
  const attempt: Attempt = {
    ...(vendorUsageScope.getStore() ?? { tenantId: null, area: "unattributed" }),
    id: randomUUID(),
    createdAt: new Date(),
    provider: "iflytek",
    operation: "stt",
    model: null,
    retryIndex: null,
    status: "started",
    httpStatus: null,
    latencyMs: null,
    units: {
      observed_websocket_sessions: 1,
      audio_bytes: Number.isSafeInteger(audioBytes) && audioBytes >= 0 ? audioBytes : null,
      audio_seconds: null,
    },
    costStatus: "unknown",
  };
  const write = attemptWriter(attempt, sink);
  await write();
  const started = Date.now();
  try {
    const result = await recognize();
    attempt.status = "succeeded";
    return result;
  } catch (error) {
    attempt.status = "uncertain";
    throw error;
  } finally {
    attempt.latencyMs = Date.now() - started;
    await write();
  }
}
