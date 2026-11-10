import { randomUUID } from "node:crypto";

export interface GraphSendInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
    contentId?: string;
  }>;
}
export type GraphMailResult = {
  transport: "graph";
  acceptance: "accepted" | "unknown" | "rejected" | "not_attempted";
  delivery: "unverified";
  clientRequestId?: string;
  providerRequestId?: string;
} & ({ ok: true; acceptance: "accepted" } | { ok: false; error: string; fallbackSafe: boolean });

const unknownError = "Outlook outcome uncertain. Review the original attempt before any resend.";
export function unknownGraphResult(): GraphMailResult {
  return {
    ok: false,
    transport: "graph",
    acceptance: "unknown",
    delivery: "unverified",
    error: unknownError,
    fallbackSafe: false,
  };
}
function requestId(value: string | null) {
  return value && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}
/** One request. Neither 202, a request ID nor Sent Items proves delivery. */
export async function submitGraphMail(
  input: GraphSendInput,
  deps: {
    token: () => Promise<string | null>;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
  },
): Promise<GraphMailResult> {
  let token: string | null;
  try {
    token = await deps.token();
  } catch {
    return {
      ok: false,
      transport: "graph",
      acceptance: "not_attempted",
      delivery: "unverified",
      error: "graph_token_unavailable",
      fallbackSafe: true,
    };
  }
  if (!token)
    return {
      ok: false,
      transport: "graph",
      acceptance: "not_attempted",
      delivery: "unverified",
      error: "no_token",
      fallbackSafe: true,
    };
  const clientRequestId = randomUUID();
  const evidence = {
    transport: "graph" as const,
    delivery: "unverified" as const,
    clientRequestId,
  };
  // Construction errors precede the provider call and cannot indicate acceptance.
  let body: string;
  try {
    const message: Record<string, unknown> = {
      subject: input.subject,
      body: input.html
        ? { contentType: "HTML", content: input.html }
        : { contentType: "Text", content: input.text || input.subject },
      toRecipients: [{ emailAddress: { address: input.to } }],
      // Opaque per-request correlation only: no candidate, tenant, room or job data.
      internetMessageHeaders: [{ name: "x-lexy-mail-attempt", value: clientRequestId }],
    };
    if (input.replyTo) message.replyTo = [{ emailAddress: { address: input.replyTo } }];
    if (input.attachments?.length)
      message.attachments = input.attachments.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename,
        contentType: a.contentType || "application/octet-stream",
        contentBytes: a.content,
        ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
      }));
    body = JSON.stringify({ message, saveToSentItems: true });
  } catch {
    return {
      ...evidence,
      ok: false,
      acceptance: "not_attempted",
      error: "graph_invalid_message",
      fallbackSafe: true,
    };
  }
  try {
    const response = await deps.fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "client-request-id": clientRequestId,
        "return-client-request-id": "true",
      },
      body,
    });
    const observed = {
      ...evidence,
      providerRequestId: requestId(response.headers.get("request-id")),
    };
    if (response.status === 202) return { ...observed, ok: true, acceptance: "accepted" };
    // Only explicit rejections permit an alternate provider. Timeouts, 5xx,
    // redirects and unexpected success responses might follow real acceptance.
    const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
    return {
      ...observed,
      ok: false,
      acceptance: rejected ? "rejected" : "unknown",
      fallbackSafe: rejected,
      error: rejected ? `graph_${response.status}` : unknownError,
    };
  } catch {
    return { ...unknownGraphResult(), ...evidence };
  }
}

/** Actual email router uses this boundary; a post-dispatch throw is held too. */
export async function routeRecruiterMail(deps: {
  healthy: () => Promise<boolean>;
  send: () => Promise<GraphMailResult>;
}): Promise<
  { kind: "fallback"; evidence?: GraphMailResult } | { kind: "complete"; evidence: GraphMailResult }
> {
  let dispatched = false;
  try {
    if (!(await deps.healthy())) return { kind: "fallback" };
    dispatched = true;
    const evidence = await deps.send();
    return evidence.ok || !evidence.fallbackSafe
      ? { kind: "complete", evidence }
      : { kind: "fallback", evidence };
  } catch {
    return dispatched ? { kind: "complete", evidence: unknownGraphResult() } : { kind: "fallback" };
  }
}
