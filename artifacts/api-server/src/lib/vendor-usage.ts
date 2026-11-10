import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { VendorUsageUnits } from "@workspace/db";
import { bodyReceiptUnits, headerReceiptUnits } from "./vendor-receipts";

export type UsageScope = {
  tenantId: string | null;
  area:
    | "unattributed"
    | "interview_unclassified"
    | `workflow:${string}:${string}`
    | `activity:${import("./vendor-usage-context").UsageActivity}`;
};
export const vendorUsageScope = new AsyncLocalStorage<UsageScope>();

export type Attempt = UsageScope & {
  id: string;
  createdAt?: Date;
  provider: string;
  operation: string;
  model: string | null;
  retryIndex: number | null;
  status: "started" | "succeeded" | "http_error" | "uncertain";
  httpStatus: number | null;
  latencyMs: number | null;
  units: VendorUsageUnits;
  costStatus: "unknown";
};
export type UsageSink = (attempt: Attempt) => Promise<void>;
export type MeteredProvider =
  | "recall"
  | "google_meet"
  | "zoom"
  | "openai_direct"
  | "openai_proxy"
  | "azure_openai"
  | "azure_tts"
  | "azure_stt"
  | "elevenlabs"
  | "deepgram"
  | "sarvam"
  | "heygen"
  | "serpapi"
  | "pdl"
  | "enrichlayer"
  | "ms_graph"
  | "iflytek"
  | "aws_ses";

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Whitelist provider receipts; never persist arbitrary response/body fields. */
export function receiptUnits(body: any, provider?: MeteredProvider): Record<string, number | null> {
  const usage = body?.usage;
  const duration = provider === "deepgram" ? body?.metadata?.duration : body?.duration;
  const units: Record<string, number | null> = {
    input_tokens: count(usage?.prompt_tokens ?? usage?.input_tokens),
    output_tokens: count(usage?.completion_tokens ?? usage?.output_tokens),
    cached_input_tokens: count(
      usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_token_details?.cached_tokens,
    ),
    reasoning_tokens: count(usage?.completion_tokens_details?.reasoning_tokens),
    audio_seconds:
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
  };
  const inputDetails = usage?.input_token_details ?? usage?.input_tokens_details;
  const outputDetails = usage?.output_token_details ?? usage?.output_tokens_details;
  for (const [name, value] of [
    ["input_audio_tokens", inputDetails?.audio_tokens],
    ["input_text_tokens", inputDetails?.text_tokens],
    ["output_audio_tokens", outputDetails?.audio_tokens],
    ["output_text_tokens", outputDetails?.text_tokens],
  ] as const) {
    if (value !== undefined) units[name] = count(value);
  }
  return units;
}

export async function persistUsageAttempt(
  attempt: Attempt,
  database?: typeof import("@workspace/db").dbAdmin,
): Promise<void> {
  const { dbAdmin, vendorUsageAttemptsTable } = await import("@workspace/db");
  const store = database ?? dbAdmin;
  const { eq, sql } = await import("drizzle-orm");
  if (attempt.status === "started") {
    // Snapshot the billing dimensions at observation time, not at report time.
    // Cycles, missing ancestors and tenantless work stay unknown.
    const result = attempt.tenantId
      ? await store.execute(sql`
      WITH RECURSIVE ancestry AS (
        SELECT id, parent_id, country, plan, ARRAY[id] AS path
        FROM tenants WHERE id = ${attempt.tenantId}
        UNION ALL
        SELECT t.id, t.parent_id, t.country, t.plan, a.path || t.id
        FROM ancestry a JOIN tenants t ON t.id = a.parent_id
        WHERE NOT t.id = ANY(a.path) AND cardinality(a.path) < 30
      )
      SELECT id, country, plan FROM ancestry WHERE parent_id IS NULL
    `)
      : { rows: [] };
    const root = result.rows[0];
    await store.insert(vendorUsageAttemptsTable).values({
      ...attempt,
      units: {
        ...attempt.units,
        billing_root_id: typeof root?.id === "string" ? root.id : null,
        billing_country: typeof root?.country === "string" ? root.country : null,
        billing_plan: typeof root?.plan === "string" ? root.plan : null,
      },
    });
  } else {
    await store
      .update(vendorUsageAttemptsTable)
      .set({
        ...attempt,
        // Preserve the start-time dimensions on late/final receipts.
        units: sql`${vendorUsageAttemptsTable.units} || ${JSON.stringify(attempt.units)}::jsonb`,
      })
      .where(eq(vendorUsageAttemptsTable.id, attempt.id))
      .returning({ id: vendorUsageAttemptsTable.id })
      .then((rows) => {
        if (rows.length !== 1) throw new Error("Usage start was not persisted");
      });
  }
}

/** Shared ordered, best-effort persistence for HTTP and WebSocket observations. */
export function attemptWriter(
  attempt: Attempt,
  sink: UsageSink = persistUsageAttempt,
): () => Promise<void> {
  let persistence = Promise.resolve();
  return async () => {
    const snapshot = { ...attempt, units: { ...attempt.units } };
    persistence = persistence
      .then(() => sink(snapshot))
      .catch(async () => {
        try {
          const { logger } = await import("./logger");
          logger.warn(
            { provider: attempt.provider, operation: attempt.operation },
            "Vendor usage persistence failed; coverage incomplete",
          );
        } catch {
          // Even a logging failure must not change provider execution.
        }
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      persistence,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };
}

/** Transport-level observation catches individual SDK retry requests, not just
 * the final helper result. It does NOT enable calls, infer costs or reserve USD.
 * A start surviving without a receipt is uncertain, never a zero-cost success.
 */
export function meteredFetch(
  provider: MeteredProvider,
  transport: typeof fetch = (...args) => fetch(...args),
  sink: UsageSink = persistUsageAttempt,
  observations: {
    inputCharacters?: number;
    model?: string;
    audioBytes?: number;
    operationKey?: string;
    accountRef?: string;
  } = {},
): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const pathname = new URL(rawUrl).pathname;
    const operation = pathname.includes("/chat/completions")
      ? "chat"
      : pathname.endsWith("/embeddings")
        ? "embedding"
        : provider === "aws_ses" || (provider === "ms_graph" && pathname.endsWith("/sendMail"))
          ? "email"
          : provider === "serpapi" || provider === "pdl"
            ? "search"
            : provider === "enrichlayer"
              ? "enrichment"
              : provider === "heygen"
                ? pathname.includes("/video/generate")
                  ? "video_generate"
                  : pathname.includes("/video_status")
                    ? "video_status"
                    : pathname.includes("/talking_photo")
                      ? "video_upload"
                      : pathname.endsWith("/voices")
                        ? "voice_list"
                        : "other"
                : pathname.includes("/audio/transcriptions") ||
                    provider === "azure_stt" ||
                    pathname.includes("/speech-to-text") ||
                    provider === "deepgram"
                  ? "stt"
                  : pathname.includes("/audio/speech") ||
                      provider === "azure_tts" ||
                      pathname.includes("/text-to-speech")
                    ? "tts"
                    : "other";
    const scope: UsageScope = vendorUsageScope.getStore() ?? {
      tenantId: null,
      area: "unattributed",
    };
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const retryHeader = headers.get("x-stainless-retry-count");
    const retryIndex =
      retryHeader !== null && /^\d+$/.test(retryHeader) ? count(Number(retryHeader)) : null;
    // SDK JSON is inspected transiently; never retain text, messages, URLs,
    // headers, multipart/audio bytes or arbitrary provider response fields.
    // Only whitelisted non-secret receipt IDs are retained separately.
    let model: string | null =
      observations.model && /^[\w.:-]{1,100}$/.test(observations.model) ? observations.model : null;
    let characters: number | null = count(observations.inputCharacters);
    let emailRecipients: number | null = null;
    try {
      const raw =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request && headers.get("content-type")?.includes("application/json")
            ? await input.clone().text()
            : null;
      if (raw) {
        const body = JSON.parse(raw);
        const requestedModel = body.model ?? body.model_id;
        if (typeof requestedModel === "string" && /^[\w.:-]{1,100}$/.test(requestedModel)) {
          model = requestedModel;
        }
        const speechInput = body.input ?? body.text;
        if (operation === "tts" && typeof speechInput === "string") {
          characters = [...speechInput].length;
        }
        if (operation === "email" && body.Destination) {
          const lists = ["ToAddresses", "CcAddresses", "BccAddresses"].map(
            (key) => body.Destination[key] ?? [],
          );
          if (lists.every(Array.isArray)) {
            emailRecipients = count(lists.reduce((sum, list) => sum + list.length, 0));
          }
        }
        if (operation === "email" && provider === "ms_graph" && body.message) {
          const lists = ["toRecipients", "ccRecipients", "bccRecipients"].map(
            (key) => body.message[key] ?? [],
          );
          if (lists.every(Array.isArray)) {
            emailRecipients = count(lists.reduce((sum, list) => sum + list.length, 0));
          }
        }
      }
    } catch {
      // Unknown metadata is not a request failure, and is never priced as free.
    }
    const attempt: Attempt = {
      ...scope,
      id: randomUUID(),
      createdAt: new Date(),
      provider,
      operation,
      model,
      retryIndex,
      status: "started",
      httpStatus: null,
      latencyMs: null,
      units: {
        input_characters: characters,
        audio_bytes: count(observations.audioBytes),
        observed_api_requests: 1,
        account_ref: /^[a-zA-Z0-9_-]{1,64}$/.test(
          observations.accountRef ??
            (provider === "azure_stt"
              ? ""
              : (process.env[`VENDOR_USAGE_ACCOUNT_${provider.toUpperCase()}`] ?? "")),
        )
          ? (observations.accountRef ??
            process.env[`VENDOR_USAGE_ACCOUNT_${provider.toUpperCase()}`]!)
          : null,
        ...(observations.operationKey && /^[a-zA-Z0-9:_-]{1,128}$/.test(observations.operationKey)
          ? { observed_operation_key: observations.operationKey }
          : {}),
        ...(operation === "email" ? { observed_email_recipients: emailRecipients } : {}),
      },
      costStatus: "unknown",
    };
    const write = attemptWriter(attempt, sink);
    await write();
    const started = Date.now();
    let response: Response;
    try {
      // Node fetch requires duplex for streaming multipart bodies. OpenAI's SDK
      // adds it for its built-in transport, but not for a custom fetch wrapper.
      // Do not consume/rebuild the stream: boundary, bytes, signal and headers
      // must reach the provider unchanged.
      const body = init?.body;
      const streamed =
        body && typeof body === "object" && ("getReader" in body || Symbol.asyncIterator in body);
      const transportInit = streamed ? { ...init, duplex: "half" as const } : init;
      response = await transport(input, transportInit);
    } catch (error) {
      attempt.status = "uncertain";
      attempt.latencyMs = Date.now() - started;
      await write();
      throw error; // Preserve SDK fallback/retry semantics and original errors.
    }
    attempt.httpStatus = response.status;
    attempt.status = response.ok ? "succeeded" : "http_error";
    attempt.latencyMs = Date.now() - started;
    attempt.units = { ...attempt.units, ...headerReceiptUnits(provider, response.headers) };
    const capture = (async () => {
      try {
        // Meet metadata contains recording evidence, not a usage receipt.
        // Leave its body to the provider's bounded reader; cloning it here
        // would bypass that memory bound and retain private file metadata.
        if (
          provider !== "google_meet" &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const body: any = await response.clone().json();
          // Requested deployment/alias is retained in model; returned dated
          // version is separate. Neither a provider ID nor text is a model.
          const returnedModel = body?.model;
          const receipt = receiptUnits(body, provider);
          if (operation !== "stt") receipt.audio_seconds = null;
          attempt.units = {
            ...attempt.units,
            ...receipt,
            ...bodyReceiptUnits(provider, body),
            returned_model:
              typeof returnedModel === "string" && /^[\w.:-]{1,100}$/.test(returnedModel)
                ? returnedModel
                : null,
          };
        }
      } catch {
        // Streaming/malformed/missing receipts remain unknown, not fabricated.
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const captured = await Promise.race([
      capture.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 250);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // Return the original response even when its receipt body is slow. A late
    // capture updates this same attempt; it never sends another provider call.
    await write();
    if (!captured) void capture.then(() => write());
    return response;
  };
}
