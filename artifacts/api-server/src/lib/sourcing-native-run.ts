import { and, eq, desc } from "drizzle-orm";
import {
  dbAdmin,
  sourcingReservationsTable as holds,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import {
  readBrief,
  fingerprint,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { NATIVE_SOURCING_ADAPTERS } from "./sourcing-providers";
import { withActiveSourcingLease, type CostRequest } from "./sourcing-meter";
import {
  dispatchInternalNativeSourcing,
  internalSourcingAttempts,
} from "./sourcing-internal-dispatch";
import { snapshotWorkerPlan } from "./sourcing-worker-plan";
import { runLeasedSourcingWork } from "./sourcing-worker";
import { vendorUsageScope } from "./vendor-usage";

import {
  NATIVE_DISCOVERY_ACTION as ACTION,
  NativeDiscoveryRecord as Result,
  NATIVE_IMPORT_ACTION,
  NativeImportRecord,
} from "./sourcing-native-records";

export function nativeSourcingReadiness(
  limits:
    | {
        allowExternal: boolean;
        providers: readonly string[];
      }
    | undefined,
  internalMobility: boolean,
) {
  const selected = limits?.providers ?? [];
  const providers = (["pdl", "serp", "enrichlayer"] as const).map((id) => {
    const port = NATIVE_SOURCING_ADAPTERS[id];
    return {
      provider: id,
      selected: selected.includes(id),
      available: port.isEnabled() && port.isConfigured(),
      kind: id === "enrichlayer" ? ("enrichment" as const) : ("discovery" as const),
      note: !port.isEnabled()
        ? "Disabled by configuration"
        : !port.isConfigured()
          ? "Provider credentials are not configured"
          : "Available",
    };
  });
  const blockers: string[] = [];
  if (!limits?.allowExternal)
    blockers.push("External discovery must be included in the approved search scope.");
  if (internalMobility) blockers.push("Internal Mobility never uses external discovery.");
  if (!providers.some((p) => p.selected && p.available && p.kind === "discovery"))
    blockers.push("Select a configured native discovery provider: PDL or SerpAPI.");
  return {
    adapter: "native:discovery-and-enrichment:v2",
    ready: !blockers.length,
    blockers,
    providers,
    upperMicros: null,
    note:
      "Selected discovery runs PDL then SerpAPI; selected EnrichLayer enriches their deduplicated profile references. Each request has its own record. Missing credentials are reported, not replaced by invented results. No billing prerequisite, automatic retries, candidate import, scoring or contact during discovery. Saved references may be added to Sourced through a separate human approval with a confirmed name." +
      (selected.includes("github")
        ? " GitHub remains available through existing assisted sourcing, not this native run."
        : ""),
  };
}

export async function getNativeSourcingRuns(scope: WorkflowScope) {
  const imported = (
    await dbAdmin
      .select({ note: events.note })
      .from(events)
      .where(
        and(
          eq(events.jobId, scope.jobId),
          eq(events.tenantId, scope.tenantId),
          eq(events.action, NATIVE_IMPORT_ACTION),
        ),
      )
  ).map((r) => NativeImportRecord.parse(JSON.parse(r.note!)));
  const rows = await dbAdmin
    .select({ note: events.note })
    .from(events)
    .where(
      and(
        eq(events.jobId, scope.jobId),
        eq(events.tenantId, scope.tenantId),
        eq(events.action, ACTION),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(100);
  const saved = rows.map((row) => {
    try {
      return Result.parse(JSON.parse(row.note ?? ""));
    } catch {
      throw new WorkflowConflict("Native discovery history needs reconciliation.");
    }
  });
  const attempts = await internalSourcingAttempts(scope);
  return [
    ...saved
      .filter((row) => !attempts.some((a) => a.id === row.operationId))
      .map((row) => ({ ...row })),
    ...attempts.map((attempt) => ({
      reservationId: attempt.reservationId,
      operationId: attempt.id,
      status: attempt.status,
      provider: attempt.provider,
      reason:
        saved.find((row) => row.operationId === attempt.id)?.reason ??
        (attempt.status === "succeeded" && !saved.some((row) => row.operationId === attempt.id)
          ? "Provider request succeeded, but its saved profile results are unavailable. Do not resend the original request."
          : undefined),
      profiles: saved.find((row) => row.operationId === attempt.id)?.profiles ?? [],
    })),
  ].map((run) => ({
    ...run,
    profiles: run.profiles.map((profile) => ({
      ...profile,
      imported: imported.some((r) => r.profileUrl.toLowerCase() === profile.url.toLowerCase()),
    })),
  }));
}

export async function startNativeSourcing(
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
  const current = await readBrief(dbAdmin, scope);
  const readiness = nativeSourcingReadiness(hold.limits, current.job.internalMobility);
  if (!readiness.ready) throw new WorkflowConflict(readiness.blockers.join(" "));
  const prior = (await internalSourcingAttempts(scope)).filter(
    (a) => a.reservationId === reservationId,
  );
  if (prior.length) return { id: reservationId, replayed: true, autonomyExecutionEnabled: false };
  const clean = (value: string) => value.replace(/["\\]/g, " ").trim().slice(0, 400);
  const location =
    current.job.workType === "remote"
      ? null
      : current.brief.icp
        ? current.brief.icp.location
        : current.job.location;
  const size = Math.min(10, hold.limits.maxCandidates);
  const requests: CostRequest[] = [];
  if (hold.limits.providers.includes("pdl"))
    requests.push({
      provider: "pdl",
      operationKey: "native-pdl-discovery-v1",
      request: { title: clean(current.job.title), location: location || null, size },
    });
  if (hold.limits.providers.includes("serp"))
    requests.push({
      provider: "serp",
      operationKey: "native-serp-discovery-v1",
      request: {
        q: `site:linkedin.com/in "${clean(current.job.title)}"${typeof location === "string" && location ? ` "${clean(location)}"` : ""}`,
        num: size,
      },
    });
  const { plan, owner } = snapshotWorkerPlan(requests);
  return runLeasedSourcingWork(
    scope,
    reservationId,
    owner,
    async (lease, signal) => {
      const refs = new Map<string, { title: string; url: string; snippet: string }>();
      const save = async (
        provider: "serp" | "pdl" | "enrichlayer",
        operationId: string,
        profiles: { title: string; url: string; snippet: string }[],
        status: "succeeded" | "skipped" = "succeeded",
        reason?: string,
      ) => {
        await dbAdmin.insert(events).values({
          jobId: scope.jobId,
          tenantId: scope.tenantId,
          actorId: scope.actorId,
          journeyId: hold.journeyId,
          action: ACTION,
          note: JSON.stringify(
            Result.parse({
              reservationId,
              operationId,
              profiles,
              provider,
              status,
              reason,
            }),
          ),
        });
      };
      const run = async (request: CostRequest) => {
        signal.throwIfAborted();
        await withActiveSourcingLease(scope, lease, async () => {});
        const provider = request.provider as "serp" | "pdl" | "enrichlayer";
        const availability = readiness.providers.find((p) => p.provider === provider)!;
        if (!availability.available) {
          await save(provider, randomUUID(), [], "skipped", availability.note);
          return;
        }
        try {
          const operation = await vendorUsageScope.run(
            {
              tenantId: scope.tenantId,
              area: `workflow:sourcing-reservation-${reservationId}:${provider === "enrichlayer" ? "enrichment" : "discovery"}`,
            },
            () => dispatchInternalNativeSourcing(scope, lease, request, signal),
          );
          if (!operation.discovery) return;
          await save(provider, operation.id, operation.discovery.profiles);
          if (provider !== "enrichlayer")
            for (const profile of operation.discovery.profiles)
              if (refs.size < size && !refs.has(profile.url)) refs.set(profile.url, profile);
        } catch (error) {
          if (signal.aborted) throw error;
          await withActiveSourcingLease(scope, lease, async () => {});
          const claimed = (await internalSourcingAttempts(scope)).some(
            (a) => a.reservationId === reservationId && a.operationKey === request.operationKey,
          );
          if (!claimed)
            await save(
              provider,
              randomUUID(),
              [],
              "skipped",
              "Request could not start; no provider effect was recorded. Check provider setup.",
            );
          // Permanent claims/outcomes expose failures. Other approved providers
          // may continue, but the failed request is never automatically repeated.
        }
      };
      for (const request of plan) await run(request);
      if (hold.limits.providers.includes("enrichlayer")) {
        const enrichment = readiness.providers.find((p) => p.provider === "enrichlayer")!;
        if (!enrichment.available)
          await save("enrichlayer", randomUUID(), [], "skipped", enrichment.note);
        else if (!refs.size)
          await save(
            "enrichlayer",
            randomUUID(),
            [],
            "skipped",
            "No usable discovery seeds; no enrichment request was sent.",
          );
        else
          for (const url of refs.keys())
            await run({
              provider: "enrichlayer",
              operationKey: `native-enrichlayer:${fingerprint(url)}`,
              request: { url },
            });
      }
      await withActiveSourcingLease(scope, lease, async () => {});
      return { id: reservationId, replayed: false, autonomyExecutionEnabled: false };
    },
    { expectedRevision },
  );
}
