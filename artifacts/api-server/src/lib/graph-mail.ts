/**
 * graph-mail.ts — Send email from a recruiter's own mailbox via Microsoft Graph
 *
 * Used by the send-router in email.ts when an eligible message (manual 1:1 or the
 * first/approved outreach step for an owned candidate) should go out "as the
 * recruiter" instead of from the shared SES sender. Failures return { ok:false }
 * so the caller transparently falls back to SES.
 *
 * Graph `POST /me/sendMail` returns 202 Accepted with no message id and files the
 * message in the recruiter's Sent Items (saveToSentItems). Candidate replies
 * therefore land in the recruiter's Outlook inbox — Phase D syncs those back.
 */
import { logger } from "./logger.js";
import { getAccessTokenForUser } from "./graph-auth.js";

export interface GraphSendInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

export async function sendViaGraph(
  userId: string,
  input: GraphSendInput,
): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const token = await getAccessTokenForUser(userId);
  if (!token) return { ok: false, error: "no_token" };

  const message: Record<string, any> = {
    subject: input.subject,
    body: input.html
      ? { contentType: "HTML", content: input.html }
      : { contentType: "Text", content: input.text || input.subject },
    toRecipients: [{ emailAddress: { address: input.to } }],
  };
  if (input.replyTo) {
    message.replyTo = [{ emailAddress: { address: input.replyTo } }];
  }
  if (input.attachments?.length) {
    message.attachments = input.attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.contentType || "application/octet-stream",
      contentBytes: a.content, // already base64
    }));
  }

  try {
    const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (resp.status === 202) {
      logger.info({ userId, to: input.to }, "[graph] mail sent");
      return { ok: true };
    }
    const errText = await resp.text().catch(() => "");
    logger.warn(
      { userId, status: resp.status, errText: errText.slice(0, 300) },
      "[graph] sendMail failed",
    );
    return { ok: false, error: `graph_${resp.status}` };
  } catch (err: any) {
    logger.error({ userId, err: err?.message }, "[graph] sendMail threw");
    return { ok: false, error: err?.message || "graph_send_error" };
  }
}
