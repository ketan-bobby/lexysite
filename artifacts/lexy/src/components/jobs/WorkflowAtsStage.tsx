import { useEffect, useState } from "react";
import type { AtsImportedRecord } from "@workspace/api-client-react";
import { atsStageDisplay } from "@/lib/ats-stage-display";

const FRESHNESS_LABEL: Record<string, string> = {
  recent: "Saved check within 24h (not live)",
  outdated: "Outdated: last saved check 24h+ ago",
  unchecked: "Imported, not refreshed since",
  unavailable:
    "Not returned at latest check; showing last-known values (not proof of deletion or rejection)",
  unknown: "Freshness unknown",
};

function fmt(v: string | null) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

export function WorkflowAtsStage({ record }: { record: AtsImportedRecord }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const d = atsStageDisplay(record, now);
  const observed = fmt(d.observedAt);
  const checked = fmt(d.checkedAt);
  const id = record.id;

  return (
    <div
      className="mt-1 space-y-0.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 [overflow-wrap:anywhere]"
      data-testid={`ats-stage-${id}`}
    >
      <p>
        <span className="font-medium">Greenhouse stage:</span>{" "}
        <span data-testid={`ats-stage-name-${id}`}>{d.stage}</span>
        {" · "}
        <span className="font-medium">Greenhouse application status:</span>{" "}
        <span data-testid={`ats-stage-status-${id}`}>{d.status}</span>
      </p>
      <p
        className={d.freshness === "recent" ? "text-muted-foreground" : "text-foreground"}
        data-testid={`ats-stage-freshness-${id}`}
      >
        {FRESHNESS_LABEL[d.freshness] ?? FRESHNESS_LABEL.unknown}
      </p>
      <p className="text-muted-foreground">
        Last successful stage observation: {observed ?? "unknown"} · Latest check:{" "}
        {checked ?? "unknown"}
      </p>
      <p className="text-muted-foreground">
        External Greenhouse data, separate from the Lexy workflow stage. Read-only: Lexy does not
        change Greenhouse stages or offers.
      </p>
    </div>
  );
}
