import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetJobSourcingControls,
  getGetJobSourcingControlsQueryKey,
  useCommandJobSourcingControls,
  getGetJobWorkflowStateQueryKey,
} from "@workspace/api-client-react";
import type {
  JobWorkflowState,
  SourcingControlCommand,
  SourcingReservation,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";
import { DEFAULT_FORM, toForm, validate, type FormState } from "./sourcing-controls-shared";
import { SourcingLimitsForm } from "./SourcingLimitsForm";
import { useAuth } from "@/lib/auth-context";
import { MonthlySourcingPackages } from "./MonthlySourcingPackages";
import { SourcingProviderCosts } from "./SourcingProviderCosts";
import { SourcingHolds } from "./SourcingHolds";
import { SourcingCostLedger } from "./SourcingCostLedger";

export function SourcingControls({ jobId, state }: { jobId: string; state: JobWorkflowState }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === "platform_admin";
  const idem = useIdempotency();
  const journeySig = state.journeys.map((j) => `${j.id}:${j.status}:${j.stale}`).join("|");
  const query = useGetJobSourcingControls(jobId, {
    query: {
      queryKey: [...getGetJobSourcingControlsQueryKey(jobId), state.briefHash, journeySig],
      enabled: !!jobId,
      refetchInterval: 5000,
    },
  });
  const cmd = useCommandJobSourcingControls();
  const view = query.isError ? undefined : query.data;
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const syncedKey = useRef<string | null>(null);

  const policy = view?.policy ?? null;
  const serverKey = view ? JSON.stringify([policy?.revision ?? 0, policy?.limits ?? null]) : null;
  useEffect(() => {
    if (!view || serverKey === syncedKey.current) return;
    if (dirty) return; // never overwrite in-progress edits
    syncedKey.current = serverKey;
    setForm(policy ? toForm(policy.limits) : DEFAULT_FORM);
  }, [view, serverKey, dirty, policy]);

  const employees = view?.sourcingScope === "client_current_employees";
  const { limits, errors } = useMemo(() => validate(form, !!employees), [form, employees]);

  const currentJourney = state.journeys.find((j) => j.status === "approved" && !j.stale);

  const set = (patch: Partial<FormState>) => {
    setDirty(true);
    setNotice(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const run = (
    body: SourcingControlCommand,
    done: string,
    resetForm = false,
    after?: () => void,
  ) => {
    setCmdError(null);
    setNotice(null);
    const sig = JSON.stringify({ ...body, idempotencyKey: undefined });
    cmd.mutate(
      { jobId, data: { ...body, idempotencyKey: idem.get(sig) } },
      {
        onSuccess: () => {
          idem.clear();
          if (resetForm) {
            setDirty(false);
            syncedKey.current = null;
          }
          setNotice(done);
          qc.invalidateQueries({ queryKey: getGetJobSourcingControlsQueryKey(jobId) });
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
          after?.();
        },
        onError: (e) => {
          setCmdError(errText(e));
          // A failed continuation can still leave a successfully resumed hold.
          // Read the real persisted state instead of keeping the old paused UI.
          qc.invalidateQueries({ queryKey: getGetJobSourcingControlsQueryKey(jobId) });
        },
      },
    );
  };

  const pending = cmd.isPending;
  const canEdit = !!view?.canEdit;
  const canApprove = !!view?.canApprove;
  const rev = policy?.revision ?? 0;
  const stale = !!policy?.stale || (!!policy && policy.briefHash !== view?.briefHash);
  const live = (r: SourcingReservation) => r.status !== "cancelled";
  const liveHolds = view?.reservations.filter(live) ?? [];
  const startInternal = (reservation: SourcingReservation) => {
    const start = (revision: number) =>
      run(
        {
          action: "start_internal",
          reservationId: reservation.id,
          expectedRevision: revision,
          idempotencyKey: "",
        },
        "Internal discovery completed. The saved shortlist is ready for human review; no paid provider or outreach was called.",
      );
    if (reservation.status === "paused") {
      run(
        {
          action: "resume",
          reservationId: reservation.id,
          expectedRevision: reservation.revision,
          idempotencyKey: "",
        },
        "Hold resumed; continuing internal discovery.",
        false,
        () => start(reservation.revision + 1),
      );
    } else start(reservation.revision);
  };
  const approvedFresh = policy?.status === "approved" && !stale;
  const savedMatches =
    !!policy &&
    !!limits &&
    JSON.stringify(toForm(policy.limits)) === JSON.stringify(toForm(limits));

  const save = () => {
    if (!view || !limits) return;
    run(
      {
        action: "save",
        expectedRevision: rev,
        expectedBriefHash: view.briefHash,
        limits,
        idempotencyKey: "",
      },
      "Limits saved. Any earlier approval was revoked; approve again to bind the current journey.",
      true,
    );
  };
  const approve = () => {
    if (!view || !currentJourney) return;
    run(
      {
        action: "approve",
        expectedRevision: rev,
        expectedBriefHash: view.briefHash,
        journeyId: currentJourney.id,
        idempotencyKey: "",
      },
      "Limits approved for the current journey and brief. Nothing was activated.",
    );
  };
  const reserve = () => {
    if (!view) return;
    run(
      {
        action: "reserve",
        expectedRevision: rev,
        expectedBriefHash: view.briefHash,
        idempotencyKey: "",
      },
      "Allocation hold prepared. This is bookkeeping only; no money moved.",
    );
  };
  const hold = (r: SourcingReservation, action: "pause" | "resume" | "cancel") =>
    run(
      { action, reservationId: r.id, expectedRevision: r.revision, idempotencyKey: "" },
      action === "cancel"
        ? "Hold cancelled. Only unused allocation was released; any dispatched or uncertain cost stays counted."
        : action === "pause"
          ? "Hold paused."
          : "Hold resumed.",
    );

  const statusLabel = !policy
    ? "No limits saved"
    : stale
      ? `${policy.status} (stale)`
      : policy.status;

  return (
    <div
      className="min-w-0 max-w-full break-words rounded-xl border border-border bg-card p-3 sm:p-5 space-y-4"
      data-testid="sourcing-controls"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Sourcing limits and allocation holds</h3>
        <Badge
          variant="outline"
          className="h-auto max-w-full gap-1 whitespace-normal"
          data-testid="status-dispatch-locked"
        >
          <Lock className="w-3 h-3" /> Internal testing · provider costs unknown
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="text-sourcing-foundation-note">
        Approved holds can run local-only internal talent discovery and save a shortlist for human
        review. It uses existing tenant records and skill/title matching, not paid providers or AI
        assessments. No candidate is linked, contacted or advanced. The runner checks the approved
        scope, candidate limit and original runtime deadline. External sourcing is available through
        the existing Source Candidates action. A separate native SerpAPI-only search port is now
        connected to these holds for internal testing without a pricing prerequisite. This port
        returns discovery references and is separate from existing sourcing and interview features.
        Provider costs remain unknown. Planning allocations are not vendor quotes, payments or
        guaranteed spending caps.
      </p>
      {view?.externalDispatch && (
        <div
          className="min-w-0 break-words rounded-lg border p-2 text-sm space-y-1 sm:p-3"
          data-testid="native-sourcing-readiness"
        >
          <p className="font-medium">
            Native discovery and enrichment: {view.externalDispatch.ready ? "ready" : "needs setup"}
          </p>
          <p>{view.externalDispatch.note}</p>
          {view.externalDispatch.providers
            ?.filter((p) => p.selected)
            .map((p) => (
              <p key={p.provider} data-testid={`native-provider-${p.provider}`}>
                {p.provider === "pdl" ? "PDL" : p.provider === "serp" ? "SerpAPI" : "EnrichLayer"}:{" "}
                {p.available ? "available" : p.note}
              </p>
            ))}
          {view.externalDispatch.blockers.map((reason) => (
            <p key={reason} className="text-muted-foreground">
              {reason}
            </p>
          ))}
        </div>
      )}

      {query.isLoading && (
        <div className="space-y-2" data-testid="sourcing-loading">
          <div className="h-4 w-1/2 skeleton-shimmer rounded" />
          <div className="h-24 skeleton-shimmer rounded" />
        </div>
      )}
      {query.isError && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive" data-testid="text-sourcing-error">
            Could not load sourcing controls: {errText(query.error)} Controls are hidden until the
            current state can be read.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => query.refetch()}
            data-testid="button-sourcing-retry"
          >
            Retry
          </Button>
        </div>
      )}

      {view && (
        <>
          <MonthlySourcingPackages packages={view.monthlyPackages} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span>
              Policy: <b data-testid="status-sourcing-policy">{statusLabel}</b>
              {policy && ` (revision ${policy.revision})`}
            </span>
            <span>
              Scope:{" "}
              <b data-testid="text-sourcing-scope">
                {employees ? "client current employees (internal only)" : "known non-employees"}
              </b>
            </span>
            <span>Authority: human review</span>
            <span>Monthly plan price: shown above; dispatch quote: unverified</span>
            <span>
              External execution from these holds:{" "}
              {view.executionEnabled ? "reported enabled" : "not connected"}; outreach from these
              holds: {view.outreachEnabled ? "reported enabled" : "not connected"}
            </span>
          </div>
          {!canEdit && !canApprove && (
            <p className="text-xs text-muted-foreground" data-testid="text-sourcing-readonly">
              Read-only view for your role. You can see limits and holds but not change them.
            </p>
          )}
          {canEdit && !canApprove && (
            <p className="text-xs text-muted-foreground">
              You can save limits and manage holds. Approval and preparing a hold need approver
              permission.
            </p>
          )}
          {view.blockers.length > 0 && (
            <ul
              className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5"
              data-testid="list-sourcing-blockers"
            >
              {view.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {stale && (
            <p role="alert" className="text-xs text-destructive" data-testid="text-sourcing-stale">
              The saved limits or approval are stale against the current brief or journey. Review,
              save, and approve again. Stale policies cannot prepare new holds.
            </p>
          )}

          <SourcingLimitsForm
            form={form}
            errors={errors}
            limits={limits}
            policy={policy}
            employees={!!employees}
            canEdit={canEdit}
            canApprove={canApprove}
            pending={pending}
            dirty={dirty}
            stale={stale}
            approvedFresh={approvedFresh}
            currentJourney={currentJourney}
            set={set}
            showAccountRates={isPlatformAdmin}
            onSave={save}
            onApprove={approve}
            onDiscard={() => {
              setDirty(false);
              syncedKey.current = null;
            }}
          />
          {view.costAnalysis.exceedsRunCap && !isPlatformAdmin && (
            <p role="alert" className="text-xs text-destructive" data-testid="text-exceeds-cap">
              Entered planning rates exceed this allocation. This is informational during internal
              testing and does not block a search.
            </p>
          )}
          {isPlatformAdmin && (
            <details data-testid="advanced-costing">
              <summary className="cursor-pointer text-sm font-semibold">Advanced costing</summary>
              <div className="mt-3">
                <SourcingProviderCosts analysis={view.costAnalysis} />
              </div>
            </details>
          )}
          <SourcingCostLedger view={view} />
          <SourcingHolds
            view={view}
            policy={policy}
            liveHolds={liveHolds}
            canEdit={canEdit}
            canApprove={canApprove}
            pending={pending}
            dirty={dirty}
            approvedFresh={approvedFresh}
            savedMatches={savedMatches}
            onReserve={reserve}
            onStartExternal={(reservation) =>
              run(
                {
                  action: "start_external",
                  reservationId: reservation.id,
                  expectedRevision: reservation.revision,
                  idempotencyKey: "",
                },
                "Search request processed. Provider cost is unknown; review its saved status and references. No candidates were imported or contacted.",
              )
            }
            onImportProfile={(reservation, operationId, profileUrl, fullName, done) =>
              run(
                {
                  action: "import_profile",
                  reservationId: reservation.id,
                  operationId,
                  profileUrl,
                  fullName,
                  expectedRevision: reservation.revision,
                  expectedBriefHash: view.briefHash,
                  idempotencyKey: "",
                },
                "Profile linked to this work order. No AI scoring, assessment, enrichment, invitation or outreach was started.",
                false,
                () => {
                  done();
                  qc.invalidateQueries({
                    predicate: (q) => {
                      const k = JSON.stringify(q.queryKey);
                      return k.includes(jobId) || k.includes('"/api/candidates"');
                    },
                  });
                },
              )
            }
            capBlocked={false}
            onHold={hold}
            onStartInternal={startInternal}
          />
        </>
      )}

      {notice && (
        <p
          role="status"
          className="text-sm text-muted-foreground"
          data-testid="text-sourcing-notice"
        >
          {notice}
        </p>
      )}
      <ErrorLine message={cmdError} testId="text-sourcing-command-error" />
      {cmdError && (
        <p className="text-xs text-muted-foreground">
          If the state changed underneath you, reload with the button below, then repeat the action.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setCmdError(null);
              query.refetch();
            }}
            data-testid="button-sourcing-reload"
          >
            Reload current state
          </button>
        </p>
      )}
    </div>
  );
}
