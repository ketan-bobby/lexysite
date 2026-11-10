import { and, eq } from "drizzle-orm";
import { sourcingCostOperationsTable as ops } from "@workspace/db";
import { readBrief, type WorkflowScope } from "./recruiting-workflows";

export const MICROS_PER_CENT = 10_000;
type Handle = Parameters<typeof readBrief>[0];
export const operationWhere = (scope: WorkflowScope) =>
  and(eq(ops.jobId, scope.jobId), eq(ops.tenantId, scope.tenantId));
export function committedMicros(row: typeof ops.$inferSelect) {
  return row.status === "settled"
    ? row.actualMicros!
    : row.status === "void"
      ? 0
      : Math.max(row.upperMicros, row.reportedMicros ?? 0);
}
export async function readCostSummary(tx: Handle, scope: WorkflowScope) {
  const operations = await tx.select().from(ops).where(operationWhere(scope));
  const spentMicros = operations
    .filter((r) => r.status === "settled")
    .reduce((n, r) => n + r.actualMicros!, 0);
  const uncertainMicros = operations
    .filter((r) => ["uncertain", "dispatching"].includes(r.status))
    .reduce((n, r) => n + committedMicros(r), 0);
  const pendingMicros = operations
    .filter((r) => r.status === "prepared")
    .reduce((n, r) => n + r.upperMicros, 0);
  return { operations, spentMicros, uncertainMicros, pendingMicros };
}
export async function allocatedCents(
  tx: Handle,
  scope: WorkflowScope,
  rows: { id: string; status: string; reservedCents: number }[],
) {
  const { operations } = await readCostSummary(tx, scope);
  let micros = 0;
  for (const row of rows) {
    const cost = operations
      .filter((o) => o.reservationId === row.id)
      .reduce((n, o) => n + committedMicros(o), 0);
    micros +=
      row.status === "cancelled" ? cost : Math.max(row.reservedCents * MICROS_PER_CENT, cost);
  }
  // Round UP once, never erase sub-cent costs at cancellation.
  return Math.ceil(micros / MICROS_PER_CENT);
}
