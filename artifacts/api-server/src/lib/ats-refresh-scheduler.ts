import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, asc } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  usersTable,
  atsRefreshSchedulesTable as schedules,
  atsRefreshRunsTable as runs,
  atsImportedApplicationsTable as imports,
} from "@workspace/db";
import { resolveWorkflowJobAccess, candidateAllowed } from "../routes/recruiting-workflows";
import { WorkflowConflict } from "./recruiting-workflows";
import { lock } from "./ats-imports";
import { authorizedAtsPreview } from "./ats-verification";
import { atsPreviewIdentity } from "./ats-preview";
import { scheduleAdmin } from "./ats-refresh-schedules";
import { refreshAtsImport } from "./ats-import-refresh";
import { greenhouseGateway, type GreenhouseGateway } from "./ats-connectors/greenhouse-gateway";
import { logger } from "./logger";

type Schedule = typeof schedules.$inferSelect;
type Run = typeof runs.$inferSelect;
const lockName = "ats-refresh-scheduler";
const scopeOf = (s: Schedule) => ({
  tenantId: s.tenantId,
  jobId: s.jobId,
  actorId: s.ownerUserId,
  actorName: "Employer-approved ATS refresh",
  canEdit: true,
  canApprove: false,
});
const scheduleWhere = (s: Schedule) =>
  and(eq(schedules.id, s.id), eq(schedules.tenantId, s.tenantId));
const runWhere = (r: Run) => and(eq(runs.id, r.id), eq(runs.tenantId, r.tenantId));

async function pauseIfUnchanged(
  h: Parameters<typeof authorizedAtsPreview>[0],
  s: Schedule,
  reason: string,
) {
  await h
    .update(schedules)
    .set({
      status: "paused",
      nextRunAt: null,
      blockedReason: reason,
      revision: s.revision + 1,
      updatedAt: new Date(),
    })
    .where(and(scheduleWhere(s), eq(schedules.revision, s.revision)));
}

async function blockBeforeRead(s: Schedule) {
  await dbAdmin.transaction(async (tx) => {
    await lock(tx, scopeOf(s), s.workflowId);
    const [current] = await tx.select().from(schedules).where(scheduleWhere(s));
    if (!current || current.revision !== s.revision || current.status !== "enabled") return;
    const message =
      "Authority, mapping or selected records changed before provider reads. Review and reapprove.";
    await pauseIfUnchanged(tx, s, message);
    await tx.insert(runs).values({
      id: randomUUID(),
      tenantId: s.tenantId,
      jobId: s.jobId,
      workflowId: s.workflowId,
      scheduleId: s.id,
      scheduleRevision: s.revision,
      status: "stopped",
      items: [],
      message,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
  });
}

async function execute(s: Schedule, gateway: GreenhouseGateway, lease: () => Promise<void>) {
  let gate: Awaited<ReturnType<typeof resolveWorkflowJobAccess>>;
  let run: Run;
  const scope = scopeOf(s);
  try {
    const [actor] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, s.ownerUserId));
    if (!actor) throw new WorkflowConflict("Owner unavailable");
    gate = await resolveWorkflowJobAccess(actor, s.jobId);
    if (gate.scope.tenantId !== s.tenantId) throw new WorkflowConflict("Job changed");
    const visible = (h: Parameters<typeof authorizedAtsPreview>[0], id: string) =>
      candidateAllowed(h, gate, id);
    run = await dbAdmin.transaction(async (tx) => {
      await lock(tx, scope, s.workflowId);
      await lease();
      await scheduleAdmin(tx, scope, s.workflowId, visible);
      const [current] = await tx.select().from(schedules).where(scheduleWhere(s));
      if (!current || current.revision !== s.revision || current.status !== "enabled")
        throw new WorkflowConflict("Schedule changed");
      const allocation = await authorizedAtsPreview(tx, scope, s.workflowId, visible, {
        expectedWorkflowRevision: s.workflowRevision,
        expectedBindingRevision: s.bindingRevision,
      });
      if (
        atsPreviewIdentity(scope, s.workflowId, s.workflowRevision, allocation) !== s.authorityHash
      )
        throw new WorkflowConflict("Authority changed");
      const selected = await tx
        .select()
        .from(imports)
        .where(
          and(
            eq(imports.tenantId, s.tenantId),
            eq(imports.jobId, s.jobId),
            eq(imports.accountRef, allocation.binding.accountRef),
            eq(imports.externalJobId, allocation.mapping.externalJobId),
            inArray(imports.id, s.recordIds),
          ),
        );
      if (selected.length !== s.recordIds.length || !selected.length || selected.length > 10)
        throw new WorkflowConflict("Selected records changed");
      const [claimed] = await tx
        .insert(runs)
        .values({
          id: randomUUID(),
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: s.workflowId,
          scheduleId: s.id,
          scheduleRevision: s.revision,
          status: "running",
          items: s.recordIds.map((id) => ({
            recordId: id,
            expectedRevision: selected.find((r) => r.id === id)!.refreshRevision,
            status: "pending" as const,
            checkedAt: null,
          })),
          startedAt: new Date(),
        })
        .returning();
      await tx.update(schedules).set({ nextRunAt: null }).where(scheduleWhere(s));
      return claimed;
    });
  } catch {
    await blockBeforeRead(s);
    return;
  }
  const visible = (h: Parameters<typeof authorizedAtsPreview>[0], id: string) =>
    candidateAllowed(h, gate, id);
  const fence = async (h: Parameters<typeof authorizedAtsPreview>[0]) => {
    await lease();
    const [current] = await h.select().from(schedules).where(scheduleWhere(s));
    const [claimed] = await h.select().from(runs).where(runWhere(run));
    if (
      !current ||
      current.status !== "enabled" ||
      current.revision !== s.revision ||
      !claimed ||
      claimed.status !== "running"
    )
      throw new WorkflowConflict("Schedule paused or run interrupted");
    await scheduleAdmin(h, scope, s.workflowId, visible);
  };
  let failed = false;
  for (const item of run.items) {
    if (failed) {
      item.status = "not_started";
      continue;
    }
    try {
      await fence(dbAdmin);
      item.status = "checking";
      await dbAdmin
        .update(runs)
        .set({ items: run.items })
        .where(and(runWhere(run), eq(runs.status, "running")));
      const result = await refreshAtsImport(
        scope,
        s.workflowId,
        item.recordId,
        {
          expectedWorkflowRevision: s.workflowRevision,
          expectedBindingRevision: s.bindingRevision,
          expectedRecordRevision: item.expectedRevision,
          idempotencyKey: `schedule:${run.id}:${item.recordId}`,
        },
        visible,
        gateway,
        fence,
      );
      item.status = result.record.availability === "unavailable" ? "unavailable" : "available";
      item.checkedAt = result.record.lastCheckedAt;
    } catch {
      failed = true;
      // A remote read/local commit may have completed before connection loss.
      item.status = item.status === "checking" ? "unconfirmed" : "not_started";
    }
    await dbAdmin
      .update(runs)
      .set({ items: run.items })
      .where(and(runWhere(run), eq(runs.status, "running")));
  }
  await dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, s.workflowId);
    await lease();
    const message = failed
      ? "Stopped after a failed or unconfirmed check. Review record history before reapproving."
      : null;
    await tx
      .update(runs)
      .set({
        items: run.items,
        status: failed ? "stopped" : "completed",
        message,
        finishedAt: new Date(),
      })
      .where(and(runWhere(run), eq(runs.status, "running")));
    if (failed) await pauseIfUnchanged(tx, s, message!);
    else
      await tx
        .update(schedules)
        .set({
          nextRunAt: new Date(Date.now() + s.intervalMinutes * 60_000),
        })
        .where(
          and(
            scheduleWhere(s),
            eq(schedules.revision, s.revision),
            eq(schedules.status, "enabled"),
          ),
        );
  });
}

/** The dedicated session lock excludes every worker, including during recovery. */
export async function runAtsRefreshTick(
  gateway: GreenhouseGateway = greenhouseGateway(),
  scheduleIds?: string[],
) {
  if (scheduleIds?.length === 0) return { busy: false, processed: 0, interrupted: 0 };
  const client = await pool.connect();
  let healthy = true;
  let locked = false;
  const lost = () => {
    healthy = false;
  };
  client.on("error", lost);
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      [lockName],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return { busy: true, processed: 0, interrupted: 0 };
    const lease = async () => {
      if (!healthy) throw new Error("Scheduler lease lost");
      await client.query("SELECT 1");
    };
    const abandoned = await dbAdmin
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.status, "running"),
          scheduleIds ? inArray(runs.scheduleId, scheduleIds) : undefined,
        ),
      );
    for (const old of abandoned) {
      await lease();
      const [s] = await dbAdmin
        .select()
        .from(schedules)
        .where(and(eq(schedules.id, old.scheduleId), eq(schedules.tenantId, old.tenantId)));
      if (!s) continue;
      await dbAdmin.transaction(async (tx) => {
        await lock(tx, scopeOf(s), s.workflowId);
        const message =
          "Worker interrupted. No automatic replay; inspect saved record history and reapprove.";
        await tx
          .update(runs)
          .set({
            status: "interrupted",
            message,
            finishedAt: new Date(),
            items: old.items.map((i) => ({
              ...i,
              status:
                i.status === "checking"
                  ? "unconfirmed"
                  : i.status === "pending"
                    ? "not_started"
                    : i.status,
            })),
          })
          .where(and(runWhere(old), eq(runs.status, "running")));
        if (s.revision === old.scheduleRevision) await pauseIfUnchanged(tx, s, message);
      });
    }
    const due = await dbAdmin
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, "enabled"),
          lte(schedules.nextRunAt, new Date()),
          scheduleIds ? inArray(schedules.id, scheduleIds) : undefined,
        ),
      )
      .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
      .limit(10);
    for (const s of due) {
      await lease();
      await execute(s, gateway, lease);
    }
    return { busy: false, processed: due.length, interrupted: abandoned.length };
  } finally {
    try {
      if (locked && healthy)
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]);
    } finally {
      client.removeListener("error", lost);
      client.release(true);
    }
  }
}

export function startAtsRefreshScheduler() {
  const tick = () =>
    runAtsRefreshTick().catch(() =>
      logger.error("[ats-refresh] Tick failed; prior run requires recovery."),
    );
  setInterval(tick, 60_000).unref();
  void tick();
}
