import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useResolveWorkflowIdentity,
  getGetJobWorkflowStateQueryKey,
  getGetVerificationStatusQueryKey,
  getGetCandidateQueryKey,
  getListCandidatesQueryKey,
  type PlannedCandidateWorkflow,
  type WorkflowIdentityResolutionInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { errText, useIdempotency } from "./workflow-shared";

export function WorkflowIdentityResolution({
  wf,
  jobId,
}: {
  wf: PlannedCandidateWorkflow;
  jobId: string;
}) {
  const qc = useQueryClient();
  const mutation = useResolveWorkflowIdentity({});
  const idem = useIdempotency();
  const [decision, setDecision] = useState<WorkflowIdentityResolutionInput["decision"] | "">("");
  const [evidence, setEvidence] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const source = wf.runtimeEvidence?.find(
    (entry) => entry.stepKey === "verification" && entry.sourceType === "identity_verification",
  );
  if (
    wf.identityResolutionAllowed === false ||
    wf.status !== "ready" ||
    wf.stale ||
    wf.steps.find((s) => s.status !== "completed")?.key !== "verification" ||
    !source
  )
    return null;
  const internal = decision === "internal_test";
  const submit = () => {
    if (!decision || !ack || evidence.trim().length < 30) return;
    setError(null);
    setSaved(null);
    mutation.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          expectedRevision: wf.revision,
          idempotencyKey: idem.get(
            JSON.stringify([
              wf.id,
              wf.revision,
              source.sourceId,
              source.occurredAt,
              decision,
              evidence.trim(),
            ]),
          ),
          recordId: source.sourceId,
          recordUpdatedAt: source.occurredAt,
          decision,
          evidence: evidence.trim(),
          acknowledge: ack,
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          setAck(false);
          setSaved(
            decision === "unresolved"
              ? "Identity remains unresolved. Contact stays blocked."
              : internal
                ? "Synthetic test clearance saved. Identity remains unverified; no email was sent."
                : "Human identity review saved. No agent was run and no email was sent.",
          );
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
          qc.invalidateQueries({ queryKey: getGetVerificationStatusQueryKey(wf.candidateId) });
          qc.invalidateQueries({ queryKey: getGetCandidateQueryKey(wf.candidateId) });
          qc.invalidateQueries({ queryKey: getListCandidatesQueryKey() });
        },
        onError: (e) => {
          setError(errText(e));
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
      },
    );
  };
  return (
    <section
      className="space-y-3 rounded-md border bg-card p-3 text-card-foreground"
      data-testid={`identity-resolution-${wf.id}`}
    >
      <h4 className="text-sm font-semibold">Resolve identity review</h4>
      <p className="text-xs text-card-foreground/80">
        Model advice is not identity proof. Review corroboration yourself, or explicitly clear a
        synthetic controlled-inbox fixture for this isolated pilot only. This saves the human
        review; it does not activate outreach.
      </p>
      <label className="block text-sm" htmlFor={`identity-decision-${wf.id}`}>
        Review decision
      </label>
      <select
        id={`identity-decision-${wf.id}`}
        className="w-full rounded-md border bg-background p-2 text-sm text-foreground"
        value={decision}
        disabled={mutation.isPending}
        onChange={(e) => {
          setDecision(e.target.value as WorkflowIdentityResolutionInput["decision"]);
          setAck(false);
          setSaved(null);
        }}
      >
        <option value="">Choose a decision</option>
        <option value="corroborated">Corroborated identity — real candidate</option>
        {wf.livePilot?.eligible && (
          <option value="internal_test">
            Synthetic controlled-inbox test only — not verified identity
          </option>
        )}
        <option value="unresolved">Keep unresolved — block contact</option>
      </select>
      <label className="block text-sm" htmlFor={`identity-evidence-${wf.id}`}>
        {internal
          ? "Why this is an authorised internal fixture"
          : "Evidence reviewed and any unresolved concerns"}
      </label>
      <Textarea
        id={`identity-evidence-${wf.id}`}
        value={evidence}
        maxLength={2000}
        disabled={mutation.isPending}
        onChange={(e) => {
          setEvidence(e.target.value);
          setAck(false);
        }}
        placeholder="Describe the source and what you personally checked (at least 30 characters). Do not paste government ID numbers or credentials."
      />
      <label className="flex gap-2 text-xs">
        <Checkbox
          checked={ack}
          disabled={!decision || mutation.isPending}
          onCheckedChange={(v) => setAck(v === true)}
        />
        <span>
          {internal
            ? "This is a synthetic fixture using an authorised staff inbox or an explicitly approved test-recipient permission. I understand this does not verify identity or authorise any other candidate or workflow."
            : decision === "corroborated"
              ? "I personally checked independent corroboration for this real person. This is not our synthetic fixture, and I am not relying on model advice alone."
              : "I understand identity remains unresolved and candidate contact stays blocked."}
        </span>
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={!decision || !ack || evidence.trim().length < 30 || mutation.isPending}
        onClick={submit}
        data-testid={`button-save-identity-${wf.id}`}
      >
        {mutation.isPending ? "Saving…" : "Save human decision"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-xs">
          {saved}
        </p>
      )}
    </section>
  );
}
