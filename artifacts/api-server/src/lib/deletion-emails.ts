/**
 * lib/deletion-emails.ts — Notification emails for the right-to-erasure flow
 *
 * Two outbound mails:
 *   • sendDeletionRequestNotificationToLegal — fired when a candidate submits a
 *     deletion request via /portal/candidate/deletion-request. Goes to the
 *     internal legal / privacy mailbox so the SLA clock starts at a known
 *     human (GDPR Art. 12(3): one month, extendable to three).
 *   • sendDeletionFulfilledConfirmationToCandidate — fired after the admin
 *     Fulfil action commits successfully. Goes to the email snapshot we
 *     captured on the request itself (the candidates row no longer exists
 *     post-cascade, so this snapshot is the only address we have).
 *
 * Both use the existing transactional sendEmail() helper in lib/email.ts so
 * they get the same SES wiring, audit-trail row, and dev-simulation
 * behaviour as every other tenant-facing email.
 *
 * Recipient configuration:
 *   LEGAL_NOTIFICATION_EMAIL env var — falls back to "legal@lexy.ai" so dev
 *   never silently mis-routes; in prod the env var must be set.
 */
import { sendEmail } from "./email";
import { logger } from "./logger";

const LEGAL_RECIPIENT = process.env.LEGAL_NOTIFICATION_EMAIL || "legal@lexy.ai";

export async function sendDeletionRequestNotificationToLegal(args: {
  requestId: string;
  candidateId: string;
  candidateEmail: string | null;
  jurisdiction: string;
  reason: string | null;
}): Promise<void> {
  const { requestId, candidateId, candidateEmail, jurisdiction, reason } = args;
  const subject = `[Lexy] New ${jurisdiction.toUpperCase()} deletion request — ${candidateEmail ?? candidateId}`;
  const text = [
    `A candidate has submitted a data-deletion request.`,
    ``,
    `Request ID:    ${requestId}`,
    `Candidate ID:  ${candidateId}`,
    `Email:         ${candidateEmail ?? "(unknown)"}`,
    `Jurisdiction:  ${jurisdiction}`,
    `Reason:        ${reason ?? "(none provided)"}`,
    ``,
    `Review and fulfil in the admin tool:`,
    `  /admin/deletion-requests`,
    ``,
    `SLA (GDPR Art. 12(3)): respond within 30 calendar days, extendable to 90`,
    `with notice. CCPA: 45 calendar days, one 45-day extension.`,
    `Runbook: docs/RUNBOOK_DATA_DELETION.md`,
  ].join("\n");

  const result = await sendEmail({
    to: LEGAL_RECIPIENT,
    subject,
    text,
    audit: {
      actorLabel: "Deletion request submitter",
      subjectType: "candidate",
      subjectId: candidateId,
      subjectLabel: candidateEmail ?? null,
      action: "deletion.notification_to_legal",
      metadata: { requestId, jurisdiction },
    },
  });
  if (!result.ok) {
    /* We do NOT throw — failing the candidate's submission because our
     * own notification mail bounced would be a bad UX. The audit row from
     * sendEmail() already records the failure for ops to investigate. */
    logger.error(
      { requestId, candidateId, err: result.error },
      "[deletion] failed to notify legal of new deletion request",
    );
  }
}

export async function sendDeletionFulfilledConfirmationToCandidate(args: {
  requestId: string;
  candidateEmailSnapshot: string | null;
  jurisdiction: string;
  fulfilledAt: Date;
}): Promise<boolean> {
  const { requestId, candidateEmailSnapshot, jurisdiction, fulfilledAt } = args;
  if (!candidateEmailSnapshot) {
    logger.warn(
      { requestId },
      "[deletion] cannot send candidate confirmation — no email snapshot on request",
    );
    return false;
  }
  const subject = `Your Lexy candidate-profile erasure is complete`;
  const text = [
    `Hello,`,
    ``,
    `Your candidate-profile erasure request in Lexy has been completed`,
    `on ${fulfilledAt.toISOString().slice(0, 10)} (UTC).`,
    ``,
    `What we deleted: your candidate profile, linked interview records,`,
    `referenced Lexy-held recordings and resume, AI consent records,`,
    `and candidate recommendation, outreach and activity records.`,
    ``,
    `What we retained: a record of this deletion (request ID ${requestId},`,
    `jurisdiction ${jurisdiction}), required decision history and financial`,
    `records may be retained where required by law. Profile erasure does`,
    `not certify deletion of every login-account identifier or copies`,
    `independently held by employers or other providers.`,
    ``,
    `If you believe any data has been retained outside what is described`,
    `above, please reply to this email or contact privacy@lexy.ai within`,
    `30 days and we will investigate.`,
    ``,
    `— Lexy`,
  ].join("\n");

  const result = await sendEmail({
    to: candidateEmailSnapshot,
    subject,
    text,
    audit: {
      actorLabel: "Lexy Privacy",
      subjectType: "external",
      subjectId: null,
      subjectLabel: candidateEmailSnapshot,
      action: "deletion.confirmation_to_candidate",
      metadata: { requestId, jurisdiction },
    },
  });
  if (!result.ok) {
    logger.error(
      { requestId, err: result.error },
      "[deletion] failed to send candidate fulfilment confirmation",
    );
  }
  return result.ok;
}
