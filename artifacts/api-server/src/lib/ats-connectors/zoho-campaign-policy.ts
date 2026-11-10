import { z } from "zod/v4";
import { fingerprint } from "../recruiting-workflows";
import type { SendEmailResult } from "../email";

export const campaignSelection = z.strictObject({
  revision: z.uuid(),
  jobId: z.string().min(1).max(200),
  planId: z.string().min(1).max(200),
  requestId: z.uuid(),
  confirm: z.literal(true),
});
export const campaignAction = z.strictObject({
  action: z.enum(["approve", "cancel"]),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});
export const campaignClaimStates = [
  "queued",
  "preparing",
  "sending",
  "sent",
  "blocked",
  "review_required",
  "simulated",
];
export function campaignJobIsOpen(payload: unknown) {
  const parsed = z
    .object({ data: z.array(z.object({ Job_Opening_Status: z.string() })).length(1) })
    .safeParse(payload);
  return (
    parsed.success &&
    ["in-progress", "in progress", "open", "active"].includes(
      parsed.data.data[0].Job_Opening_Status.trim().toLowerCase(),
    )
  );
}
export function campaignApplicationIsEligible(payload: unknown) {
  const parsed = z.object({ Application_Status: z.string() }).safeParse(payload);
  return (
    parsed.success &&
    ["new", "applied", "application received", "associated", "in review", "screening"].includes(
      parsed.data.Application_Status.trim().toLowerCase(),
    )
  );
}
export function campaignRecipients(applications: { applicationId: string; candidateId: string }[]) {
  // Application order must not affect the approved snapshot; one interview per person/job.
  return [...applications]
    .sort((a, b) => a.applicationId.localeCompare(b.applicationId))
    .filter(
      (app, index, rows) => rows.findIndex((r) => r.candidateId === app.candidateId) === index,
    );
}
export function campaignBrief(
  job: {
    id: string;
    tenantId: string;
    status: string;
    title: string;
    description: string;
    language: string | null;
  },
  plan: {
    id: string;
    tenantId: string;
    jobId: string;
    title: string;
    questions: unknown;
    language: string;
    interviewType: string;
    culturalConfig: unknown;
    focusDirective: string | null;
    estimatedDurationMinutes: number;
  },
) {
  return fingerprint({
    job: {
      id: job.id,
      tenantId: job.tenantId,
      status: job.status,
      title: job.title,
      description: job.description,
      language: job.language,
    },
    plan: {
      id: plan.id,
      tenantId: plan.tenantId,
      jobId: plan.jobId,
      title: plan.title,
      questions: plan.questions,
      language: plan.language,
      interviewType: plan.interviewType,
      culturalConfig: plan.culturalConfig,
      focusDirective: plan.focusDirective,
      estimatedDurationMinutes: plan.estimatedDurationMinutes,
    },
  });
}
export function campaignDelivery(result: SendEmailResult) {
  if (result.simulated || result.suppressed) return { state: "simulated", reason: "no_real_email" };
  if (result.ok && result.messageId) return { state: "sent", reason: null };
  return { state: "review_required", reason: "delivery_uncertain" };
}
