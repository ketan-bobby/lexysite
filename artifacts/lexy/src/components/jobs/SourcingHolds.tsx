import { useState } from "react";
import type {
  SourcingControlView,
  SourcingPolicy,
  SourcingReservation,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SourcingProfileAdmission } from "./SourcingProfileAdmission";
import { usd } from "./sourcing-controls-shared";

export interface SourcingHoldsProps {
  view: SourcingControlView;
  policy: SourcingPolicy | null;
  liveHolds: SourcingReservation[];
  canEdit: boolean;
  canApprove: boolean;
  pending: boolean;
  dirty: boolean;
  approvedFresh: boolean;
  savedMatches: boolean;
  onReserve: () => void;
  capBlocked?: boolean;
  onHold: (r: SourcingReservation, action: "pause" | "resume" | "cancel") => void;
  onStartInternal: (r: SourcingReservation) => void;
  onStartExternal: (r: SourcingReservation) => void;
  onImportProfile: (
    r: SourcingReservation,
    operationId: string,
    profileUrl: string,
    fullName: string,
    done: () => void,
  ) => void;
}

export function SourcingHolds({
  view,
  policy,
  liveHolds,
  canEdit,
  canApprove,
  pending,
  dirty,
  approvedFresh,
  savedMatches,
  onReserve: reserve,
  capBlocked = false,
  onHold: hold,
  onStartInternal,
  onStartExternal,
  onImportProfile,
}: SourcingHoldsProps) {
  const [confirmCancel, setConfirmCancel] = useState<SourcingReservation | null>(null);
  return (
    <>
      <section className="min-w-0 space-y-3">
        <h4 className="text-sm font-semibold">Test runs · advisory USD allocations</h4>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            Allocated: <b data-testid="text-allocated">{usd(view.allocatedCents)}</b>
          </span>
          <span>
            Remaining planning allocation:{" "}
            <b data-testid="text-available">{usd(view.availableCents)}</b>
          </span>
          <span>
            Outstanding holds: <b>{liveHolds.length}</b>
            {policy ? ` of ${policy.limits.maxRuns}` : ""}
          </span>
        </div>
        {canApprove && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-auto min-h-8 max-w-full whitespace-normal text-left"
              onClick={reserve}
              disabled={pending || !approvedFresh || dirty || !savedMatches || capBlocked}
              data-testid="button-prepare-hold"
            >
              Prepare test run
              {policy ? ` (${usd(policy.limits.runBudgetCents)})` : ""}
            </Button>
            {!approvedFresh && (
              <span className="text-xs text-muted-foreground">Requires fresh approved limits.</span>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          USD allocations are informational during internal testing, not payment limits.
        </p>
        {view.reservations.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-holds">
            No holds prepared. Prepare a hold to start local-only internal discovery.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="list-holds">
            {view.reservations.map((r) => (
              <li
                key={r.id}
                className="min-w-0 rounded-lg border border-border p-2 sm:p-3 space-y-2"
                data-testid={`hold-${r.id}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <b>{usd(r.reservedCents)}</b>
                  <Badge variant="outline" data-testid={`status-hold-${r.id}`}>
                    {r.status}
                    {r.stale ? " (stale)" : ""}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    policy revision {r.policyRevision}, hold revision {r.revision}, prepared{" "}
                    {new Date(r.createdAt).toLocaleString()} by {r.createdById}
                  </span>
                </div>
                {(() => {
                  const run = view.internalRuns?.find((run) => run.reservationId === r.id);
                  return (
                    <div className="space-y-2 text-sm" data-testid={`internal-run-${r.id}`}>
                      <p role="status">
                        Internal discovery: <b>{run?.status ?? "ready"}</b>
                        {run?.deadline &&
                          ` · original deadline ${new Date(run.deadline).toLocaleString()}`}
                      </p>
                      {canEdit &&
                        view.internalDiscoveryEnabled &&
                        r.status !== "cancelled" &&
                        run?.status !== "completed" && (
                          <Button
                            size="sm"
                            className="h-auto min-h-8 max-w-full whitespace-normal text-left"
                            onClick={() => onStartInternal(r)}
                            disabled={
                              pending ||
                              dirty ||
                              r.stale ||
                              !approvedFresh ||
                              run?.status === "running" ||
                              view.costOperations.some((op) => op.reservationId === r.id) ||
                              (!!run?.deadline && new Date(run.deadline).getTime() <= Date.now())
                            }
                            data-testid={`button-start-internal-${r.id}`}
                          >
                            {run?.startedAt || r.status === "paused"
                              ? "Resume internal discovery"
                              : "Start internal discovery"}
                          </Button>
                        )}
                      {run?.status === "interrupted" && (
                        <p className="text-xs text-muted-foreground">
                          No active worker. Resume uses the original approved scope and deadline.
                        </p>
                      )}
                      {canApprove && r.limits.allowExternal && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-auto min-h-8 max-w-full whitespace-normal text-left"
                          onClick={() => onStartExternal(r)}
                          disabled={
                            pending ||
                            dirty ||
                            r.stale ||
                            !approvedFresh ||
                            r.status !== "reserved" ||
                            !view.externalDispatch?.ready ||
                            !!run?.startedAt ||
                            view.externalRuns?.some(
                              (attempt) =>
                                attempt.reservationId === r.id && attempt.status !== "skipped",
                            ) ||
                            view.costOperations.some(
                              (op) => op.reservationId === r.id && op.status !== "prepared",
                            )
                          }
                          data-testid={`button-start-native-${r.id}`}
                        >
                          Run native discovery and enrichment
                        </Button>
                      )}
                      {view.externalRuns
                        ?.filter((result) => result.reservationId === r.id)
                        .map((result) => (
                          <div
                            key={result.operationId}
                            className="min-w-0 break-words space-y-2 rounded border p-2 sm:p-3"
                            data-testid={`native-result-${result.operationId}`}
                          >
                            <p>
                              {result.provider === "pdl"
                                ? "PDL"
                                : result.provider === "enrichlayer"
                                  ? "EnrichLayer"
                                  : "SerpAPI"}{" "}
                              · Request status: {result.status ?? "succeeded"} · Provider cost:
                              unknown. Discovery saves profile references; adding one to Sourced
                              requires a separate confirmation below. Discovery does not assess or
                              contact candidates. Executed requests are never automatically resent.
                            </p>
                            {result.reason && <p>{result.reason}</p>}
                            {!result.profiles.length && result.status === "succeeded" && (
                              <p>No matching public profile references returned.</p>
                            )}
                            {result.profiles.map((profile) => (
                              <div key={profile.url}>
                                <a
                                  className="break-all underline"
                                  href={profile.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {profile.title}
                                </a>
                                <p className="text-muted-foreground">{profile.snippet}</p>
                                {canApprove &&
                                  approvedFresh &&
                                  !r.stale &&
                                  result.status === "succeeded" &&
                                  (result.provider === "pdl" || result.provider === "serp") && (
                                    <SourcingProfileAdmission
                                      url={profile.url}
                                      imported={
                                        !!profile.imported ||
                                        !!view.externalRuns?.some(
                                          (x) =>
                                            x.reservationId === r.id &&
                                            x.profiles.some(
                                              (q) => q.url === profile.url && q.imported,
                                            ),
                                        )
                                      }
                                      disabled={pending || dirty}
                                      onAdmit={(name, done) =>
                                        onImportProfile(
                                          r,
                                          result.operationId,
                                          profile.url,
                                          name,
                                          done,
                                        )
                                      }
                                    />
                                  )}
                              </div>
                            ))}
                          </div>
                        ))}
                      {run?.status === "completed" && (
                        <>
                          <p className="text-xs text-muted-foreground">
                            Saved shortlist · {run.candidates.length} currently visible candidates.
                            Local skill/title matching only, not an AI assessment. No candidate was
                            linked, contacted or advanced.
                          </p>
                          {run.candidates.length ? (
                            <ul className="list-disc pl-5">
                              {run.candidates.map((c) => (
                                <li key={c.id}>
                                  {c.name}
                                  {c.title ? ` — ${c.title}` : ""}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>No eligible internal candidates to display.</p>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}
                {r.status !== "cancelled" && canEdit && (
                  <div className="flex flex-wrap gap-2">
                    {r.status === "reserved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => hold(r, "pause")}
                        data-testid={`button-pause-hold-${r.id}`}
                      >
                        Pause
                      </Button>
                    )}
                    {r.status === "paused" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => hold(r, "resume")}
                        data-testid={`button-resume-hold-${r.id}`}
                      >
                        Resume hold only
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setConfirmCancel(r)}
                      data-testid={`button-cancel-hold-${r.id}`}
                    >
                      Cancel hold
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <AlertDialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <AlertDialogContent data-testid="dialog-cancel-hold">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this allocation hold?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels the hold
              {confirmCancel ? ` of ${usd(confirmCancel.reservedCents)}` : ""} and releases only its
              unused allocation. It cannot be resumed. Costs already dispatched or uncertain stay
              counted until billing evidence resolves them, and nothing is refunded or recalled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-hold-dismiss">
              Keep hold
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-cancel-hold-confirm"
              onClick={() => {
                if (confirmCancel) hold(confirmCancel, "cancel");
                setConfirmCancel(null);
              }}
            >
              Release hold
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
