import { randomUUID } from "node:crypto";
import type { SendEmailResult } from "./email";

export const uncertainMailPrefix = "provider_outcome_uncertain:";
export function isUncertainMailReason(reason: string | null | undefined) {
  return (
    !!reason &&
    (reason.startsWith(uncertainMailPrefix) || reason.startsWith("Outlook outcome uncertain."))
  );
}
export const heldMailError = "Original provider outcome needs human review before any resend.";
/**
 * The durable CAS claim must precede provider I/O. It remains in place through
 * post-send bookkeeping; an exception or failed final write cannot release it.
 */
export async function guardedOutreachMail(deps: {
  claim: (marker: string) => Promise<boolean>;
  invoke: () => Promise<SendEmailResult>;
  finish: (result: SendEmailResult, marker: string, held: boolean) => Promise<boolean>;
}): Promise<SendEmailResult> {
  const marker = `${uncertainMailPrefix}${randomUUID()}`;
  const held: SendEmailResult = { ok: false, error: heldMailError, reviewRequired: true };
  try {
    if (!(await deps.claim(marker))) return held;
  } catch {
    return held;
  } // No provider call after failed/ambiguous claim persistence.
  let result: SendEmailResult;
  try {
    result = await deps.invoke();
  } catch {
    result = held;
  }
  const needsReview =
    !result.ok &&
    (result.reviewRequired === true ||
      (result.acceptance !== "rejected" && result.acceptance !== "not_attempted"));
  try {
    if (!(await deps.finish(result, marker, needsReview))) return held;
  } catch {
    return held;
  } // Keep the pre-existing claim, never overwrite it with a generic error.
  return needsReview ? held : result;
}
