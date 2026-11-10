import { meteredFetch, type UsageSink } from "./vendor-usage";

/** Decorate the native AWS handler, downstream of SDK retries. Keep the actual
 * output/body stream unchanged; never clone/store mail, headers or AWS IDs. */
export function meterSesHandler<
  T extends { handle: (request: any, options?: any) => Promise<{ response: any }> },
>(handler: T, sink?: UsageSink): void {
  const original = handler.handle.bind(handler);
  handler.handle = async (request, options) => {
    let result: Awaited<ReturnType<typeof original>> | undefined;
    const rawAttempt = String(request.headers?.["amz-sdk-request"] ?? "").match(/\battempt=(\d+)/);
    const attempt = rawAttempt ? Number(rawAttempt[1]) : null;
    const headers: Record<string, string> = {};
    if (attempt !== null && Number.isSafeInteger(attempt) && attempt >= 1) {
      headers["x-stainless-retry-count"] = String(attempt - 1);
    }
    await meteredFetch(
      "aws_ses",
      async () => {
        result = await original(request, options);
        // Do not consume the real response stream. SDK deserialization and
        // errors/retry decisions still receive the identical original result.
        return new Response(null, { status: result.response.statusCode });
      },
      sink,
    )("https://ses-observation.invalid/v2/email/outbound-emails", {
      headers,
      body: typeof request.body === "string" ? request.body : undefined,
    });
    return result!;
  };
}
