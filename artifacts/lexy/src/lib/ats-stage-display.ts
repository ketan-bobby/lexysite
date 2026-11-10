import type { AtsImportedRecord } from "@workspace/api-client-react";

export const ATS_STAGE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type StageRecord = Pick<
  AtsImportedRecord,
  "application" | "availability" | "observedAt" | "lastCheckedAt"
>;

/**
 * Display policy only: a recent saved observation is never proof of a live stage.
 * Missing provider records do not establish deletion or any hiring outcome.
 */
export function atsStageDisplay(record: StageRecord, now = Date.now()) {
  const validTime = (value: string | null) => {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && time <= now + 60_000 ? new Date(time).toISOString() : null;
  };
  const checkedAt = validTime(record.lastCheckedAt);
  const observedAt =
    record.availability === "available"
      ? checkedAt
      : record.availability === "unchecked"
        ? validTime(record.observedAt)
        : null;
  const freshness: "recent" | "outdated" | "unchecked" | "unavailable" | "unknown" =
    record.availability === "unavailable"
      ? "unavailable"
      : record.availability === "unchecked"
        ? "unchecked"
        : !observedAt
          ? "unknown"
          : now - Date.parse(observedAt) >= ATS_STAGE_STALE_AFTER_MS
            ? "outdated"
            : "recent";
  return {
    stage: record.application.stageName?.trim() || "Not supplied",
    status: record.application.status?.trim() || "Not supplied",
    freshness,
    observedAt,
    checkedAt,
  };
}
