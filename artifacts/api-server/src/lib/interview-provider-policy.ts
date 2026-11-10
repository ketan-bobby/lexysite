import { createHash } from "node:crypto";
import { parseSesDelivery } from "./offer-provider-events";

const names = [
  "lexy_interview_attempt",
  "lexy_interview_session",
  "lexy_interview_job",
  "lexy_interview_workflow",
] as const;
const safe = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
export function invitationEmailTags(action: unknown, metadata?: Record<string, unknown> | null) {
  const values = [metadata?.attemptId, metadata?.sessionId, metadata?.jobId, metadata?.workflowId];
  if (action !== "interview.greenhouse.invite" || !values.every(safe)) return undefined;
  return names.map((Name, i) => ({ Name, Value: values[i] as string }));
}
export function parseInvitationProviderEvent(payload: unknown) {
  const mail = (payload as { mail?: { tags?: Record<string, unknown> } })?.mail;
  const ids = names.map((name) => {
    const value = mail?.tags?.[name];
    return Array.isArray(value) && value.length === 1 ? value[0] : null;
  });
  if (!ids.every(safe)) return null;
  const facts = parseSesDelivery(payload);
  if (!facts || facts.recipients.length !== 1) return null;
  const [attemptId, sessionId, jobId, workflowId] = ids as string[];
  const id = createHash("sha256")
    .update(JSON.stringify([ids, facts]))
    .digest("hex");
  return { ...facts, attemptId, sessionId, jobId, workflowId, id };
}
export type InvitationProviderEvent = NonNullable<ReturnType<typeof parseInvitationProviderEvent>>;
export const invitationDeliveryRank = {
  accepted: 0,
  delayed: 1,
  delivered: 2,
  bounced: 3,
  rejected: 4,
  complained: 5,
} as const;
