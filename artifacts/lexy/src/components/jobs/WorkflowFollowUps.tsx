import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWorkflowFollowUps,
  useControlWorkflowFollowUp,
  getGetWorkflowFollowUpsQueryKey,
  type PlannedCandidateWorkflow,
  type WorkflowFollowUpInput,
  type WorkflowFollowUp,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorLine, errText } from "./workflow-shared";

const localTime = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export function WorkflowFollowUps({
  wf,
  jobId,
  canEdit,
  canApprove,
}: {
  wf: PlannedCandidateWorkflow;
  jobId: string;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const qc = useQueryClient();
  const query = useGetWorkflowFollowUps(jobId, wf.id, {
    query: {
      queryKey: getGetWorkflowFollowUpsQueryKey(jobId, wf.id),
      refetchInterval: 15_000,
      staleTime: 0,
    },
  });
  const mutation = useControlWorkflowFollowUp({});
  const [editor, setEditor] = useState(false);
  const [editing, setEditing] = useState<WorkflowFollowUp | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [schedule, setSchedule] = useState("");
  const [ackId, setAckId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = query.data;
  const blocked = wf.status !== "ready" || wf.stale || !!data?.blockedReason;
  const begin = (
    value?: WorkflowFollowUp,
    held?: { subject: string | null; body: string | null },
  ) => {
    setEditing(value ?? null);
    setSubject(value?.subject ?? held?.subject ?? "Following up from Lexy");
    setBody(value?.body ?? held?.body ?? "");
    setSchedule(localTime(value?.scheduledAt ?? new Date(Date.now() + 120_000).toISOString()));
    setAckId(null);
    setError(null);
    setEditor(true);
  };
  const act = (input: Omit<WorkflowFollowUpInput, "expectedRevision" | "idempotencyKey">) => {
    setError(null);
    mutation.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          ...input,
          expectedRevision: wf.revision,
          idempotencyKey: crypto.randomUUID(),
        },
      },
      {
        onSuccess: () => {
          setEditor(false);
          setEditing(null);
          setAckId(null);
          qc.invalidateQueries({ queryKey: getGetWorkflowFollowUpsQueryKey(jobId, wf.id) });
        },
        onError: (e) => {
          setError(errText(e));
          qc.invalidateQueries({ queryKey: getGetWorkflowFollowUpsQueryKey(jobId, wf.id) });
        },
      },
    );
  };
  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="Workflow follow-ups"
    >
      <h4 className="text-sm font-medium">Separately approved follow-ups</h4>
      <p className="text-xs text-muted-foreground">
        Pilot check-ins only. No AI generation, invitation links or token changes. Each approval
        covers one exact message to the current controlled inbox. Scheduled delivery is checked
        every 15 minutes.
      </p>
      {query.isLoading && (
        <p role="status" className="text-xs">
          Loading saved follow-ups…
        </p>
      )}
      {query.error && (
        <ErrorLine message={errText(query.error)} testId={`followup-read-error-${wf.id}`} />
      )}
      {data && (
        <>
          <p className="text-xs">
            Recipient: <b>{data.recipient}</b>
          </p>
          {data.blockedReason && (
            <p role="status" className="text-xs text-amber-600">
              {data.blockedReason}
            </p>
          )}
          {data.held.map((held) => (
            <div key={held.id} className="space-y-1 border-l-2 border-border pl-2">
              <p className="text-xs font-medium">
                Held legacy message: {held.subject ?? "No subject"}
              </p>
              <p className="text-xs text-muted-foreground">{held.reason}</p>
              {held.body && (
                <p className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{held.body}</p>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || mutation.isPending}
                  onClick={() => begin(undefined, held)}
                >
                  Prepare separate check-in draft
                </Button>
              )}
            </div>
          ))}
          {data.followUps.length === 0 && (
            <p className="text-xs text-muted-foreground">No separately approved follow-ups yet.</p>
          )}
          {data.followUps.map((item) => (
            <article key={item.id} className="space-y-2 rounded border border-border p-2">
              <div className="text-xs">
                <b>{item.subject}</b> · {item.status}
              </div>
              <p className="text-xs">
                To {item.recipient} · {new Date(item.scheduledAt).toLocaleString()}
              </p>
              <p className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{item.body}</p>
              {item.blockedReason && (
                <p role="status" className="text-xs text-amber-600">
                  {item.blockedReason}
                </p>
              )}
              {["claimed", "unknown"].includes(item.status) && (
                <p className="text-xs text-amber-600">
                  Outcome unconfirmed. This message cannot be edited, cancelled or resent
                  automatically.
                </p>
              )}
              {item.status === "sent" && (
                <p className="text-xs text-muted-foreground">
                  Provider accepted this message; inbox delivery is not confirmed.
                </p>
              )}
              {["draft", "approved"].includes(item.status) && (
                <div className="space-y-2">
                  {canApprove && (
                    <label className="flex items-start gap-2 text-xs">
                      <Checkbox
                        checked={ackId === `${item.id}:${item.version}`}
                        onCheckedChange={(checked) =>
                          setAckId(checked === true ? `${item.id}:${item.version}` : null)
                        }
                      />
                      I reviewed this exact recipient, message and schedule, and authorize one email
                      with unknown provider charges.
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked || mutation.isPending}
                        onClick={() => begin(item)}
                      >
                        Edit draft
                      </Button>
                    )}
                    {canApprove && (
                      <Button
                        size="sm"
                        disabled={
                          blocked || mutation.isPending || ackId !== `${item.id}:${item.version}`
                        }
                        onClick={() =>
                          act({
                            action: "approve",
                            id: item.id,
                            expectedVersion: item.version,
                            acknowledgeUnknownCost: true,
                          })
                        }
                      >
                        {item.status === "approved"
                          ? "Approve again"
                          : "Approve one scheduled email"}
                      </Button>
                    )}
                    {canApprove && item.status === "approved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          blocked ||
                          mutation.isPending ||
                          !!item.blockedReason ||
                          Date.parse(item.scheduledAt) > Date.now()
                        }
                        onClick={() =>
                          act({
                            action: "send",
                            id: item.id,
                            expectedVersion: item.version,
                          })
                        }
                      >
                        Send approved email now
                      </Button>
                    )}
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() =>
                          act({
                            action: "cancel",
                            id: item.id,
                            expectedVersion: item.version,
                          })
                        }
                      >
                        Cancel follow-up
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </article>
          ))}
          {canEdit && !editor && (
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || mutation.isPending}
              onClick={() => begin()}
            >
              New check-in draft
            </Button>
          )}
          {editor && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!schedule || !Number.isFinite(Date.parse(schedule))) {
                  setError("Choose a valid schedule.");
                  return;
                }
                act({
                  action: "draft",
                  ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}),
                  subject,
                  body,
                  scheduledAt: new Date(schedule).toISOString(),
                });
              }}
            >
              <label className="block text-xs">
                Subject
                <Input
                  aria-label="Follow-up subject"
                  required
                  maxLength={160}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </label>
              <label className="block text-xs">
                Message
                <Textarea
                  aria-label="Follow-up message"
                  required
                  maxLength={4000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <label className="block text-xs">
                Send at (your local time)
                <Input
                  aria-label="Follow-up schedule"
                  type="datetime-local"
                  required
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Saving an edit removes approval. No message is sent until separately approved. Links
                and verification codes are not allowed in check-ins.
              </p>
              <div className="flex gap-2">
                <Button size="sm" type="submit" disabled={blocked || mutation.isPending}>
                  Save unapproved draft
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setEditor(false)}>
                  Close
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      <ErrorLine message={error} testId={`followup-error-${wf.id}`} />
    </section>
  );
}
