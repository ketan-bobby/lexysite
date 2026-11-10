/**
 * graph-mail.ts — Send email from a recruiter's own mailbox via Microsoft Graph
 *
 * Used by the send-router in email.ts when an eligible message (manual 1:1 or the
 * first/approved outreach step for an owned candidate) should go out "as the
 * recruiter" instead of from the shared SES sender. Only known non-attempts or
 * rejections permit fallback. Uncertain provider processing requires review.
 *
 * Graph `POST /me/sendMail` returns 202 Accepted with no message id and files the
 * message in the recruiter's Sent Items (saveToSentItems). Candidate replies
 * therefore land in the recruiter's Outlook inbox — Phase D syncs those back.
 */
import { logger } from "./logger.js";
import { meteredFetch } from "./vendor-usage";
import { getAccessTokenForUser } from "./graph-auth.js";
import { submitGraphMail, type GraphMailResult } from "./graph-mail-transport";

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

export async function sendViaGraph(
  userId: string,
  input: GraphSendInput,
): Promise<GraphMailResult> {
  const result = await submitGraphMail(input, {
    token: () => getAccessTokenForUser(userId),
    fetch: meteredFetch("ms_graph"),
  });
  logger.info(
    {
      userId,
      acceptance: result.acceptance,
      clientRequestId: result.clientRequestId,
      providerRequestId: result.providerRequestId,
    },
    "[graph] mail processing observation; delivery unverified",
  );
  return result;
}
