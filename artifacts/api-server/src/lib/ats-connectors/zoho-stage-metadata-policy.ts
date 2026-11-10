import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import { zohoImportId } from "./zoho-intake-record";
import { zohoApplicationIdentity } from "./zoho-application-identity";

const text = z
  .string()
  .min(1)
  .max(100)
  .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
const invalid = () =>
  new CalendarError(
    409,
    "zoho_stage_metadata_invalid",
    "Zoho stage metadata could not be verified. No status was changed.",
  );
export const stageMetadataInput = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});
export function applicationBinding(
  payload: unknown,
  jobId: string,
  applicationId: string,
  candidateId: string,
) {
  const parsed = z
    .object({
      data: z.array(z.unknown()).length(1),
    })
    .safeParse(payload);
  if (!parsed.success) throw invalid();
  const record = parsed.data.data[0];
  const identity = zohoApplicationIdentity(record);
  const status = z.object({ Application_Status: text }).safeParse(record);
  if (
    !identity ||
    !status.success ||
    identity.applicationId !== applicationId ||
    identity.jobId !== jobId ||
    identity.candidateId !== candidateId
  )
    throw invalid();
  return {
    ...identity,
    currentStatus: status.data.Application_Status,
  };
}
export function stageCatalogPage(payload: unknown, page: number) {
  // The shared transport represents HTTP 204 as data:[].
  if (z.strictObject({ data: z.array(z.never()).length(0) }).safeParse(payload).success)
    return { statuses: [], stages: [], moreRecords: false };
  const status = z.object({ id: zohoImportId, actual_value: text, display_value: text });
  const parsed = z
    .object({
      stages: z
        .array(
          z.object({
            id: z.union([zohoImportId, z.literal("-1")]),
            name: text,
            status: z.array(status).max(200).optional(),
          }),
        )
        .max(200),
      info: z.object({ page: z.number().int(), more_records: z.boolean() }),
    })
    .safeParse(payload);
  if (!parsed.success || parsed.data.info.page !== page) throw invalid();
  const stages = parsed.data.stages;
  if (new Set(stages.map((s) => s.id)).size !== stages.length) throw invalid();
  const statuses = stages.flatMap((s) =>
    (s.status ?? []).map((r) => ({
      id: r.id,
      value: r.actual_value,
      label: r.display_value,
      stageId: s.id,
      stageName: s.name,
    })),
  );
  if (new Set(statuses.map((s) => s.id)).size !== statuses.length) throw invalid();
  return { statuses, stages: stages.map((s) => s.id), moreRecords: parsed.data.info.more_records };
}
export type StageStatus = ReturnType<typeof stageCatalogPage>["statuses"][number];
export function matchStageMappings(
  mapping: { advance: string | null; hold: string | null; decline: string | null },
  statuses: StageStatus[],
) {
  return (["advance", "hold", "decline"] as const).map((decision) => {
    const targetStatus = mapping[decision];
    // Match canonical values only. Display labels and case-insensitive guesses are not IDs.
    const matches = statuses.filter((s) => s.value === targetStatus);
    const item = matches.length === 1 ? matches[0] : null;
    // These checks never authorize a write, including offers and employment outcomes.
    const restricted =
      !!item &&
      (["Offered", "Hired", "Archived"].includes(item.stageName) ||
        /offer|hired|joined|onboarding|converted|employee/i.test(item.value));
    const result: "unset" | "ambiguous" | "missing" | "restricted" | "matched" = !targetStatus
      ? "unset"
      : matches.length > 1
        ? "ambiguous"
        : !item
          ? "missing"
          : restricted
            ? "restricted"
            : "matched";
    return {
      decision,
      targetStatus,
      result,
      statusId: item?.id ?? null,
      stageId: item?.stageId ?? null,
    };
  });
}
