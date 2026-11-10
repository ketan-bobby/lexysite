import type {
  AtsImportHistory,
  AtsImportedRecord,
  AtsRefreshInput,
} from "@workspace/api-client-react";

// An operational bound for one explicit action, not a plan/credit entitlement.
export const MAX_ATS_REFRESH_BATCH = 10;

export type AtsRefreshBatchItem = {
  recordId: string;
  applicationId: string;
  state: "queued" | "checking" | "available" | "unavailable" | "failed" | "not_started";
  checkedAt?: string;
  message?: string;
};

type Options = {
  records: readonly AtsImportedRecord[];
  expectedBindingRevision: number;
  expectedWorkflowRevision: number;
  refresh: (recordId: string, input: AtsRefreshInput) => Promise<AtsImportHistory>;
  shouldStop: () => boolean;
  onProgress: (items: AtsRefreshBatchItem[]) => void;
  createKey?: () => string;
};

/**
 * Sequential client-side orchestration over the same authorized single-record
 * endpoint. No scheduler, retries, batch-wide atomicity, or resumable job claim.
 * Persisted per-record checkpoints remain the source of truth after navigation.
 */
export async function runAtsRefreshBatch(options: Options): Promise<AtsRefreshBatchItem[]> {
  const records = options.records.map((record) => ({
    id: record.id,
    revision: record.refreshRevision,
    applicationId: record.application.id,
  }));
  if (
    records.length < 1 ||
    records.length > MAX_ATS_REFRESH_BATCH ||
    new Set(records.map((r) => r.id)).size !== records.length ||
    records.some((r) => !r.id || !Number.isSafeInteger(r.revision) || r.revision < 0) ||
    !Number.isSafeInteger(options.expectedBindingRevision) ||
    options.expectedBindingRevision < 1 ||
    !Number.isSafeInteger(options.expectedWorkflowRevision) ||
    options.expectedWorkflowRevision < 0
  ) {
    throw new Error("Select one to ten distinct current imported records.");
  }
  // Freeze the exact authority and revisions chosen at click time.
  const bindingRevision = options.expectedBindingRevision;
  const workflowRevision = options.expectedWorkflowRevision;
  const items: AtsRefreshBatchItem[] = records.map((record) => ({
    recordId: record.id,
    applicationId: record.applicationId,
    state: "queued",
  }));
  const emit = () => options.onProgress(items.map((item) => ({ ...item })));
  let failed = false;
  emit();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const item = items[index];
    if (failed || options.shouldStop()) {
      item.state = "not_started";
      item.message = failed
        ? "Not started because an earlier check failed. Review saved history before trying again."
        : "Not started. Stopping does not undo completed checks.";
      emit();
      continue;
    }
    item.state = "checking";
    emit();
    try {
      const result = await options.refresh(record.id, {
        expectedBindingRevision: bindingRevision,
        expectedWorkflowRevision: workflowRevision,
        expectedRecordRevision: record.revision,
        idempotencyKey: (options.createKey ?? (() => crypto.randomUUID()))(),
      });
      if (
        result.record.id !== record.id ||
        !["available", "unavailable"].includes(result.record.availability) ||
        !result.record.lastCheckedAt ||
        !Number.isFinite(Date.parse(result.record.lastCheckedAt)) ||
        result.record.refreshRevision <= record.revision
      ) {
        throw new Error("Unrecognized refresh response");
      }
      item.state = result.record.availability as "available" | "unavailable";
      item.checkedAt = result.record.lastCheckedAt;
      item.message =
        item.state === "unavailable"
          ? "Not returned at this check; last-known metadata retained. Not proof of deletion."
          : "Saved metadata checked; no hiring-stage changes.";
    } catch (error) {
      failed = true;
      item.state = "failed";
      const status =
        typeof error === "object" && error !== null && "status" in error ? error.status : null;
      item.message =
        status === 401 || status === 403 || status === 404 || status === 409
          ? "Access or saved revisions changed. Reload before starting another batch."
          : "Check failed or its outcome could not be confirmed. Check saved history before retrying.";
    }
    emit();
  }
  return items.map((item) => ({ ...item }));
}
