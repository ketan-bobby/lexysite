/**
 * Actual local-only discovery, not a simulation of external AI/provider work.
 * No candidate linking, scoring model, email or stage transition happens here.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  candidatesTable,
  sourcingExecutionLeasesTable as leases,
  sourcingReservationsTable as holds,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import type { InternalSourcingRun } from "@workspace/api-zod";
import { searchInternalDatabase } from "../routes/sourcing";
import type { SearchContext } from "./external-sourcing";
import { readBrief, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { checkpointInternalSourcing, renewMeterLease } from "./sourcing-meter";
import { runLeasedSourcingWork } from "./sourcing-worker";
import { internalSourcingPlanHash } from "./sourcing-worker-plan";

export async function getInternalSourcingRuns(
  scope: WorkflowScope,
): Promise<InternalSourcingRun[]> {
  const reservations = await dbAdmin
    .select()
    .from(holds)
    .where(and(eq(holds.jobId, scope.jobId), eq(holds.tenantId, scope.tenantId)));
  const workers = await dbAdmin
    .select()
    .from(leases)
    .where(and(eq(leases.jobId, scope.jobId), eq(leases.tenantId, scope.tenantId)));
  const completed = await dbAdmin
    .select()
    .from(events)
    .where(
      and(
        eq(events.jobId, scope.jobId),
        eq(events.tenantId, scope.tenantId),
        eq(events.action, "sourcing.internal_completed"),
      ),
    );
  const current = await readBrief(dbAdmin, scope);
  const ids = [...new Set(workers.flatMap((w) => w.candidateIds))];
  // Retrospective privacy/compliance: saved IDs do not grant permanent visibility.
  const visible = ids.length
    ? await dbAdmin
        .select({
          id: candidatesTable.id,
          firstName: candidatesTable.firstName,
          lastName: candidatesTable.lastName,
          title: candidatesTable.currentTitle,
        })
        .from(candidatesTable)
        .where(
          and(
            eq(candidatesTable.tenantId, scope.tenantId),
            eq(candidatesTable.pool, "tenant"),
            inArray(candidatesTable.id, ids),
            isNull(candidatesTable.dataErasedAt),
            or(isNull(candidatesTable.doNotContact), ne(candidatesTable.doNotContact, true)),
            current.job.internalMobility
              ? eq(candidatesTable.isCurrentEmployee, true)
              : or(
                  isNull(candidatesTable.isCurrentEmployee),
                  ne(candidatesTable.isCurrentEmployee, true),
                ),
          ),
        )
    : [];
  const byId = new Map(
    visible.map((c) => [
      c.id,
      {
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        title: c.title,
      },
    ]),
  );
  return reservations.map((hold) => {
    const worker = workers.find(
      (w) =>
        w.reservationId === hold.id &&
        w.owner.startsWith(`sourcing-plan:${internalSourcingPlanHash(hold)}:`),
    );
    const done = completed.find((e) => e.note === hold.id);
    return {
      reservationId: hold.id,
      status:
        hold.status === "cancelled"
          ? "cancelled"
          : done
            ? "completed"
            : hold.status === "paused"
              ? "paused"
              : worker
                ? worker.leaseUntil > new Date()
                  ? "running"
                  : "interrupted"
                : "ready",
      startedAt: worker?.startedAt ?? null,
      deadline: worker?.deadline ?? null,
      completedAt: done?.createdAt ?? null,
      candidates: done
        ? (worker?.candidateIds ?? []).flatMap((id) => {
            const candidate = byId.get(id);
            return candidate ? [candidate] : [];
          })
        : [],
    };
  });
}

export async function startInternalSourcing(
  scope: WorkflowScope,
  reservationId: string,
  expectedRevision: number,
) {
  const [hold] = await dbAdmin
    .select()
    .from(holds)
    .where(
      and(
        eq(holds.id, reservationId),
        eq(holds.jobId, scope.jobId),
        eq(holds.tenantId, scope.tenantId),
      ),
    );
  if (!hold) throw new WorkflowConflict("Not found", 404);
  const owner = `sourcing-plan:${internalSourcingPlanHash(hold)}:${randomUUID()}`;
  return runLeasedSourcingWork(
    scope,
    reservationId,
    owner,
    async (lease, signal) => {
      const [done] = await dbAdmin
        .select()
        .from(events)
        .where(
          and(
            eq(events.jobId, scope.jobId),
            eq(events.tenantId, scope.tenantId),
            eq(events.action, "sourcing.internal_completed"),
            eq(events.note, reservationId),
          ),
        );
      if (done)
        return { id: reservationId, replayed: true, autonomyExecutionEnabled: false as const };
      const current = await readBrief(dbAdmin, scope);
      const icp = current.brief.icp as Record<string, unknown> | null;
      const strings = (key: string) =>
        Array.isArray(icp?.[key])
          ? (icp[key] as unknown[]).filter((v): v is string => typeof v === "string")
          : [];
      const ctx: SearchContext = {
        jobTitle: current.job.title,
        alternateTitles: strings("alternateTitles"),
        requiredSkills: strings("requiredSkills"),
        preferredSkills: strings("preferredSkills"),
        requiredCertifications: strings("requiredCertifications"),
        toolsAndSystems: strings("toolsAndSystems"),
        compliance: strings("compliance"),
        negativeKeywords: strings("negativeKeywords"),
        domain: typeof icp?.domain === "string" ? icp.domain : null,
        roleFamily: typeof icp?.roleFamily === "string" ? icp.roleFamily : null,
        seniority: typeof icp?.seniority === "string" ? icp.seniority : null,
        languages: strings("languages"),
        location: icp
          ? typeof icp.location === "string"
            ? icp.location
            : ""
          : (current.job.location ?? ""),
        workType: current.job.workType,
        booleanSearchString: null,
        maxResults: hold.limits.maxCandidates,
      };
      signal.throwIfAborted();
      // Bound the local query too. Cancelling cannot recall a DB query, but its
      // timeout and the fenced checkpoint prevent an unbounded run/result commit.
      const result = await dbAdmin.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('statement_timeout','10000',true)`);
        return searchInternalDatabase(
          ctx,
          scope.tenantId,
          tx as unknown as typeof dbAdmin,
          current.job.internalMobility ? "internal_mobility" : "known_talent",
        );
      });
      signal.throwIfAborted();
      await renewMeterLease(scope, lease, true);
      // Shared internal search emits stable internal_<canonical-id> identities.
      const ids = result.candidates
        .slice(0, hold.limits.maxCandidates)
        .flatMap((c) => (c.id.startsWith("internal_") ? [c.id.slice("internal_".length)] : []));
      await checkpointInternalSourcing(scope, lease, ids);
      return { id: reservationId, replayed: false, autonomyExecutionEnabled: false as const };
    },
    { internalOnly: true, expectedRevision },
  );
}
