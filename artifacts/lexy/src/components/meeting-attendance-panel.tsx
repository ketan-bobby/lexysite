/**
 * MeetingAttendancePanel — optional, visible, silent Lexy meeting capture for
 * original-host Zoom appointments. Every live action is an explicit staff click:
 * approval (participant consent + staff approval), then a separate dispatch.
 * Captured media is private, unprocessed staff source material. Nothing here
 * scores, assesses or publishes to an ATS.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMeetingAttendance,
  getGetMeetingAttendanceQueryKey,
  useApproveMeetingAttendance,
  useAuthorizeMeetingWorkspace,
  useRevokeMeetingWorkspace,
  useActOnMeetingAttendance,
  useImportMeetingAttendance,
  type MeetingAttendanceAttempt,
  type MeetingAttendanceView,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  AlertTriangle,
  CircleStop,
  Download,
  KeyRound,
  Loader2,
  Lock,
  Radio,
  RefreshCw,
  ShieldCheck,
  Video,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Attempt = MeetingAttendanceAttempt;
type State = Attempt["state"];

const ACTIVE: State[] = [
  "dispatching",
  "scheduled",
  "joining",
  "waiting",
  "recording",
  "processing",
];

const STATE_META: Record<State, { label: string; cls: string }> = {
  approved: {
    label: "Approved - not dispatched",
    cls: "bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-300",
  },
  dispatching: { label: "Dispatching", cls: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  unknown: { label: "Outcome unknown", cls: "bg-amber-500/10 text-amber-700 border-amber-500/25" },
  scheduled: { label: "Scheduled", cls: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  joining: { label: "Joining", cls: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  waiting: { label: "In waiting room", cls: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  recording: { label: "Recording", cls: "bg-red-500/10 text-red-600 border-red-500/25" },
  processing: {
    label: "Provider processing",
    cls: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  },
  done: {
    label: "Recording available",
    cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  },
  failed: { label: "Failed", cls: "bg-red-500/10 text-red-600 border-red-500/20" },
  stopping: {
    label: "Stop requested - cleanup pending",
    cls: "bg-amber-500/10 text-amber-700 border-amber-500/25",
  },
  stopped: {
    label: "Stopped",
    cls: "bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-300",
  },
  deleted: {
    label: "Provider media deleted",
    cls: "bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-300",
  },
};

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Request failed.";
}
function errStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}
function fmt(d: string) {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleString();
}

/** Keyed on signed-in identity + scope so any change clears local state. */
export function MeetingAttendancePanel({
  jobId,
  candidateId,
}: {
  jobId: string;
  candidateId: string;
}) {
  const { user } = useAuth();
  const ident = `${(user as { id?: string } | null)?.id ?? "anon"}:${user?.role ?? ""}`;
  if (!user) return null;
  return (
    <Inner key={`${ident}::${jobId}::${candidateId}`} jobId={jobId} candidateId={candidateId} />
  );
}

export default MeetingAttendancePanel;

function ErrorLine({
  msg,
  onDismiss,
  testId,
}: {
  msg: string;
  onDismiss: () => void;
  testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-xs text-red-600"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{msg}</span>
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Inner({ jobId, candidateId }: { jobId: string; candidateId: string }) {
  const qc = useQueryClient();
  const queryKey = getGetMeetingAttendanceQueryKey(jobId, candidateId);
  const q = useGetMeetingAttendance(jobId, candidateId, {
    query: { queryKey, refetchInterval: 15000, retry: false },
  });
  const refresh = () => qc.invalidateQueries({ queryKey });

  const denied = [401, 403].includes(errStatus(q.error ?? q.failureReason) ?? 0);
  const failed = q.isError || q.failureReason != null;
  const view: MeetingAttendanceView | undefined = failed ? undefined : q.data;

  return (
    <Card className="border-border/50" data-testid="panel-meeting-attendance">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-2">
          <Video className="mt-0.5 h-4 w-4 text-primary" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Lexy meeting capture (optional)</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A visible, silent Lexy participant can record an original-host Zoom appointment, only
              after participant consent and staff approval. This is not Zoom cloud recording.
              Captured media stays private and unprocessed until a person imports and processes it.
            </p>
          </div>
        </div>

        {q.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : failed || !view ? (
          <div
            className="rounded-xl border border-red-500/30 p-4 text-center"
            data-testid="status-attendance-unavailable"
          >
            {denied ? (
              <Lock className="mx-auto mb-1.5 h-5 w-5 text-red-500" />
            ) : (
              <AlertTriangle className="mx-auto mb-1.5 h-5 w-5 text-red-500" />
            )}
            <p className="text-sm font-medium" role="alert">
              {denied
                ? "You do not have access to meeting capture for this candidate"
                : "Could not load meeting capture"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {denied
                ? "Capture details are hidden until access is confirmed again."
                : errMsg(q.error ?? q.failureReason)}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 gap-1.5"
              disabled={q.isFetching}
              onClick={() => q.refetch()}
              data-testid="button-retry-attendance"
            >
              {q.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Retry
            </Button>
          </div>
        ) : (
          <Body view={view} jobId={jobId} candidateId={candidateId} onChanged={refresh} />
        )}
      </CardContent>
    </Card>
  );
}

function Body({
  view,
  jobId,
  candidateId,
  onChanged,
}: {
  view: MeetingAttendanceView;
  jobId: string;
  candidateId: string;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "platform_admin" || user?.role === "tenant_admin";
  const [actErr, setActErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    attempt: Attempt;
    action: "dispatch" | "stop" | "recover";
  } | null>(null);
  const [importFor, setImportFor] = useState<string | null>(null);

  const act = useActOnMeetingAttendance({
    mutation: {
      onMutate: () => setActErr(null),
      onError: (e) => setActErr(errMsg(e)),
      onSettled: () => onChanged(),
    },
  });

  const doneBySchedule = new Map<string, number>();
  for (const a of view.attempts)
    if (a.state === "done" && !a.mediaDeleted)
      doneBySchedule.set(a.scheduleId, (doneBySchedule.get(a.scheduleId) ?? 0) + 1);

  return (
    <div className="space-y-4">
      <WorkspaceSection
        view={view}
        jobId={jobId}
        candidateId={candidateId}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />

      {!view.webhookConfigured && (
        <div
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
          data-testid="status-webhook-missing"
        >
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">Signed callback setup pending.</span>{" "}
            Dispatch stays disabled until RECALL_WEBHOOK_SECRET is configured and Recall signed
            status callbacks point at Lexy. Stop and recovery controls remain available.
          </p>
        </div>
      )}

      <ApprovalSection view={view} jobId={jobId} candidateId={candidateId} onChanged={onChanged} />

      <section aria-label="Capture attempts" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Capture attempts
        </h4>
        {actErr && (
          <ErrorLine
            msg={actErr}
            onDismiss={() => setActErr(null)}
            testId="text-attendance-action-error"
          />
        )}
        {view.attempts.length === 0 ? (
          <p
            className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground"
            data-testid="text-no-attempts"
          >
            No approved captures. Nothing joins a meeting until staff approve and then dispatch.
          </p>
        ) : (
          <ul className="space-y-2">
            {view.attempts.map((a) => {
              const meta = STATE_META[a.state] ?? STATE_META.unknown;
              const busy = act.isPending && act.variables?.attendanceId === a.id;
              const canStop =
                !a.stopRequested &&
                (ACTIVE.includes(a.state) ||
                  a.state === "done" ||
                  a.state === "failed" ||
                  a.state === "approved");
              const uniqueDone =
                a.state === "done" &&
                !a.mediaDeleted &&
                !a.importedNoteId &&
                doneBySchedule.get(a.scheduleId) === 1;
              return (
                <li
                  key={a.id}
                  className="rounded-xl border border-border/50 p-3"
                  data-testid={`row-attempt-${a.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn("gap-1 text-[10px] font-semibold", meta.cls)}
                      data-testid={`status-attempt-${a.id}`}
                    >
                      {a.state === "recording" && <Radio className="h-2.5 w-2.5" />}
                      {(a.state === "dispatching" || a.state === "stopping") && (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      )}
                      {a.stopRequested &&
                      a.state !== "stopping" &&
                      a.state !== "stopped" &&
                      a.state !== "deleted"
                        ? "Stop requested - cleanup pending"
                        : meta.label}
                    </Badge>
                    {a.providerState && (
                      <span className="text-[11px] text-muted-foreground">
                        Provider: {a.providerState}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      Updated {fmt(a.updatedAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Appointment {a.scheduleId} · approved {fmt(a.approvedAt)}
                    {a.mediaDeleted && " · provider media deleted"}
                    {a.importedNoteId && " · imported as private meeting note"}
                  </p>
                  {a.state === "unknown" && (
                    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                      Lexy did not receive a definite provider answer. Recover the saved receipt; a
                      new request is never resent.
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {a.state === "approved" && !a.stopRequested && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={busy || !view.webhookConfigured || !view.workspaceAuthorized}
                        title={
                          !view.webhookConfigured
                            ? "Signed callback setup pending"
                            : !view.workspaceAuthorized
                              ? "Workspace not authorized"
                              : undefined
                        }
                        onClick={() => setConfirm({ attempt: a, action: "dispatch" })}
                        data-testid={`button-dispatch-${a.id}`}
                      >
                        <Video className="h-3.5 w-3.5" /> Dispatch capture
                      </Button>
                    )}
                    {a.state === "unknown" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={busy}
                        onClick={() => setConfirm({ attempt: a, action: "recover" })}
                        data-testid={`button-recover-${a.id}`}
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Recover saved receipt
                      </Button>
                    )}
                    {(canStop || a.state === "unknown") && !a.stopRequested && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 border-red-500/30 text-red-600"
                        disabled={busy}
                        onClick={() => setConfirm({ attempt: a, action: "stop" })}
                        data-testid={`button-stop-${a.id}`}
                      >
                        <CircleStop className="h-3.5 w-3.5" /> Stop and request cleanup
                      </Button>
                    )}
                    {uniqueDone && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => setImportFor(importFor === a.id ? null : a.id)}
                        data-testid={`button-open-import-${a.id}`}
                      >
                        <Download className="h-3.5 w-3.5" /> Review and import
                      </Button>
                    )}
                    {busy && (
                      <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />
                    )}
                  </div>
                  {a.state === "done" && !a.importedNoteId && !uniqueDone && !a.mediaDeleted && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Import is unavailable: more than one completed recording exists for this
                      appointment.
                    </p>
                  )}
                  {importFor === a.id && uniqueDone && (
                    <ImportForm
                      jobId={jobId}
                      candidateId={candidateId}
                      attempt={a}
                      onDone={() => {
                        setImportFor(null);
                        onChanged();
                        qc.invalidateQueries({ queryKey: ["meeting-notes", jobId, candidateId] });
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "dispatch"
                ? "Dispatch Lexy meeting capture?"
                : confirm?.action === "stop"
                  ? "Stop capture and request cleanup?"
                  : "Recover saved receipt?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "dispatch"
                ? "A visible, silent Lexy participant will be sent to this appointment and will record it. Confirm participants have consented."
                : confirm?.action === "stop"
                  ? "Lexy will request that the provider leave the meeting and delete its media. Deletion is not immediate; the status will show cleanup pending until the provider confirms."
                  : "Lexy will look up the saved provider receipt for this attempt. No new capture request is sent."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-attempt-action">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-attempt-action"
              onClick={() => {
                if (confirm)
                  act.mutate({
                    jobId,
                    candidateId,
                    attendanceId: confirm.attempt.id,
                    action: confirm.action,
                  });
                setConfirm(null);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WorkspaceSection({
  view,
  jobId,
  candidateId,
  isAdmin,
  onChanged,
}: {
  view: MeetingAttendanceView;
  jobId: string;
  candidateId: string;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [connectionId, setConnectionId] = useState(view.connections[0]?.id ?? "");
  const [attest, setAttest] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const authorize = useAuthorizeMeetingWorkspace({
    mutation: {
      onMutate: () => setErr(null),
      onSuccess: () => setAttest(false),
      onError: (e) => setErr(errMsg(e)),
      onSettled: () => onChanged(),
    },
  });
  const revoke = useRevokeMeetingWorkspace({
    mutation: {
      onMutate: () => setErr(null),
      onError: (e) => setErr(errMsg(e)),
      onSettled: () => onChanged(),
    },
  });

  return (
    <div className="space-y-2 rounded-xl border border-border/50 p-3">
      <div className="flex items-center gap-2 text-xs">
        <ShieldCheck
          className={cn(
            "h-3.5 w-3.5",
            view.workspaceAuthorized ? "text-emerald-600" : "text-muted-foreground",
          )}
        />
        <span className="font-semibold" data-testid="status-workspace-authorized">
          {view.workspaceAuthorized
            ? "Employer capture workspace authorized"
            : "Employer capture workspace not authorized"}
        </span>
        {view.workspaceAuthorized && isAdmin && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-red-600"
            disabled={revoke.isPending}
            onClick={() => setRevokeOpen(true)}
            data-testid="button-revoke-workspace"
          >
            {revoke.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Revoke
          </Button>
        )}
      </div>
      {err && <ErrorLine msg={err} onDismiss={() => setErr(null)} testId="text-workspace-error" />}
      {!view.workspaceAuthorized && view.canAuthorizeWorkspace && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (connectionId && attest)
              authorize.mutate({ jobId, candidateId, data: { connectionId, authorized: true } });
          }}
        >
          {view.connections.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No Recall connection is available to authorize.
            </p>
          ) : (
            <>
              <Label htmlFor="ma-conn" className="text-xs">
                Recall connection
              </Label>
              <select
                id="ma-conn"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                data-testid="select-workspace-connection"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {view.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="ma-attest"
                  checked={attest}
                  onCheckedChange={(v) => setAttest(v === true)}
                  data-testid="checkbox-workspace-attest"
                />
                <Label htmlFor="ma-attest" className="text-xs font-normal leading-relaxed">
                  I attest this Recall workspace is owned or controlled by this employer and that
                  the employer has authorized Lexy meeting capture through it.
                </Label>
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={!connectionId || !attest || authorize.isPending}
                data-testid="button-authorize-workspace"
              >
                {authorize.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Authorize workspace
              </Button>
            </>
          )}
        </form>
      )}
      {!view.workspaceAuthorized && !view.canAuthorizeWorkspace && (
        <p className="text-xs text-muted-foreground">
          A platform administrator must authorize the employer workspace before captures can be
          dispatched.
        </p>
      )}
      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke workspace authorization?</AlertDialogTitle>
            <AlertDialogDescription>
              New dispatches will be blocked. Lexy will request that active captures stop and that
              provider media be cleaned up. Deletion is not immediate and depends on provider
              confirmation. Stop controls remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revoke.mutate({ jobId, candidateId })}
              data-testid="button-confirm-revoke"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ApprovalSection({
  view,
  jobId,
  candidateId,
  onChanged,
}: {
  view: MeetingAttendanceView;
  jobId: string;
  candidateId: string;
  onChanged: () => void;
}) {
  const [scheduleId, setScheduleId] = useState("");
  const [consent, setConsent] = useState(false);
  const [approve, setApprove] = useState(false);
  const [statement, setStatement] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const m = useApproveMeetingAttendance({
    mutation: {
      onMutate: () => setErr(null),
      onSuccess: () => {
        setScheduleId("");
        setConsent(false);
        setApprove(false);
        setStatement("");
      },
      onError: (e) => setErr(errMsg(e)),
      onSettled: () => onChanged(),
    },
  });
  const len = statement.trim().length;
  const ok =
    !!scheduleId &&
    view.appointments.some((a) => a.scheduleId === scheduleId) &&
    consent &&
    approve &&
    len >= 20 &&
    len <= 1500 &&
    !m.isPending;

  if (view.appointments.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="text-no-appointments">
        No upcoming Zoom appointments where Lexy is the original host. Capture is only available for
        those.
      </p>
    );
  }
  return (
    <form
      className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok)
          m.mutate({
            jobId,
            candidateId,
            data: { scheduleId, consent: true, consentStatement: statement.trim() },
          });
      }}
    >
      <h4 className="text-xs font-semibold">Approve a capture</h4>
      <div className="space-y-1">
        <Label htmlFor="ma-sched" className="text-xs">
          Original-host appointment
        </Label>
        <select
          id="ma-sched"
          value={scheduleId}
          onChange={(e) => setScheduleId(e.target.value)}
          data-testid="select-attendance-appointment"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">Select appointment</option>
          {view.appointments.map((a) => (
            <option key={a.scheduleId} value={a.scheduleId}>
              {fmt(a.scheduledAt)} · {a.durationMinutes} min
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ma-stmt" className="text-xs">
          How participants consented ({len}/1500, min 20)
        </Label>
        <Textarea
          id="ma-stmt"
          rows={3}
          maxLength={1500}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          data-testid="input-attendance-consent-statement"
          placeholder="e.g. Candidate and interviewers agreed in writing on the invitation to a visible recording participant."
        />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="ma-consent"
          checked={consent}
          onCheckedChange={(v) => setConsent(v === true)}
          data-testid="checkbox-attendance-consent"
        />
        <Label htmlFor="ma-consent" className="text-xs font-normal leading-relaxed">
          All participants have explicitly consented to being recorded. Notice alone is not consent.
        </Label>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="ma-approve"
          checked={approve}
          onCheckedChange={(v) => setApprove(v === true)}
          data-testid="checkbox-attendance-approve"
        />
        <Label htmlFor="ma-approve" className="text-xs font-normal leading-relaxed">
          I approve this capture as staff. Approval does not dispatch anything; dispatch is a
          separate step.
        </Label>
      </div>
      {err && <ErrorLine msg={err} onDismiss={() => setErr(null)} testId="text-approval-error" />}
      <Button type="submit" size="sm" disabled={!ok} data-testid="button-approve-attendance">
        {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Approve capture
      </Button>
    </form>
  );
}

function ImportForm({
  jobId,
  candidateId,
  attempt,
  onDone,
}: {
  jobId: string;
  candidateId: string;
  attempt: Attempt;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("en");
  const [statement, setStatement] = useState("");
  const [planned, setPlanned] = useState("");
  const [consent, setConsent] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = useImportMeetingAttendance({
    mutation: {
      onMutate: () => setErr(null),
      onSuccess: () => onDone(),
      onError: (e) => setErr(errMsg(e)),
    },
  });
  const len = statement.trim().length;
  const langOk = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language);
  const ok =
    title.trim().length >= 1 &&
    title.trim().length <= 160 &&
    langOk &&
    len >= 20 &&
    len <= 1500 &&
    planned.length <= 6000 &&
    consent &&
    reviewed &&
    !m.isPending;

  return (
    <form
      className="mt-3 space-y-2 rounded-lg border border-border/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        m.mutate({
          jobId,
          candidateId,
          attendanceId: attempt.id,
          data: {
            title: title.trim(),
            language,
            consent: true,
            consentStatement: statement.trim(),
            ...(planned.trim() ? { plannedQuestions: planned.trim() } : {}),
          },
        });
      }}
    >
      <p className="text-[11px] text-muted-foreground">
        Imported evidence becomes a private, unprocessed meeting note. It is not assessed, scored or
        published to an ATS.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`mi-title-${attempt.id}`} className="text-xs">
            Title
          </Label>
          <Input
            id={`mi-title-${attempt.id}`}
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="input-import-title"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`mi-lang-${attempt.id}`} className="text-xs">
            Language code
          </Label>
          <Input
            id={`mi-lang-${attempt.id}`}
            value={language}
            onChange={(e) => setLanguage(e.target.value.trim())}
            data-testid="input-import-language"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`mi-stmt-${attempt.id}`} className="text-xs">
          Consent statement ({len}/1500, min 20)
        </Label>
        <Textarea
          id={`mi-stmt-${attempt.id}`}
          rows={2}
          maxLength={1500}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          data-testid="input-import-consent-statement"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`mi-plan-${attempt.id}`} className="text-xs">
          Planned questions (optional)
        </Label>
        <Textarea
          id={`mi-plan-${attempt.id}`}
          rows={2}
          maxLength={6000}
          value={planned}
          onChange={(e) => setPlanned(e.target.value)}
          data-testid="input-import-planned"
        />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`mi-rev-${attempt.id}`}
          checked={reviewed}
          onCheckedChange={(v) => setReviewed(v === true)}
          data-testid="checkbox-import-reviewed"
        />
        <Label htmlFor={`mi-rev-${attempt.id}`} className="text-xs font-normal">
          I reviewed that this is the only completed recording for this appointment and it belongs
          to this candidate and job.
        </Label>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`mi-con-${attempt.id}`}
          checked={consent}
          onCheckedChange={(v) => setConsent(v === true)}
          data-testid="checkbox-import-consent"
        />
        <Label htmlFor={`mi-con-${attempt.id}`} className="text-xs font-normal">
          Participants explicitly consented to this recording.
        </Label>
      </div>
      {err && <ErrorLine msg={err} onDismiss={() => setErr(null)} testId="text-import-error" />}
      <Button type="submit" size="sm" disabled={!ok} data-testid="button-import-attendance">
        {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Import as private note
      </Button>
    </form>
  );
}
