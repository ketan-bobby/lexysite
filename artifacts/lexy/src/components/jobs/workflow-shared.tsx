import { useRef } from "react";
import { Badge } from "@/components/ui/badge";
import type { PlannedCandidateWorkflow } from "@workspace/api-client-react";

export const FINAL_STEP = "hiring_decision";
export const CONCRETE_PATHS = ["ai", "human", "ai_then_human", "human_then_ai"] as const;
export type ConcretePath = (typeof CONCRETE_PATHS)[number];
const PATH_LABEL: Record<string, string> = {
  ai: "AI interview",
  human: "Human interview",
  ai_then_human: "AI then Human",
  human_then_ai: "Human then AI",
  recruiter_choice: "Recruiter choice per candidate",
};
export const pathLabel = (p: string) => PATH_LABEL[p] ?? p;
export const errText = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");

/** Retains one idempotency key per distinct payload until it succeeds or the payload changes. */
export function useIdempotency() {
  const ref = useRef<{ sig: string; key: string } | null>(null);
  return {
    get(sig: string) {
      if (!ref.current || ref.current.sig !== sig) {
        ref.current = { sig, key: crypto.randomUUID() };
      }
      return ref.current.key;
    },
    clear() {
      ref.current = null;
    },
  };
}

export function ErrorLine({ message, testId }: { message: string | null; testId: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive" data-testid={testId}>
      {message} You can retry; the same request key is reused if the outcome was uncertain.
    </p>
  );
}

export function StepList({ steps }: { steps: PlannedCandidateWorkflow["steps"] }) {
  return (
    <ol className="space-y-1 text-sm">
      {steps.map((s, i) => (
        <li key={s.key} className="flex min-w-0 flex-wrap gap-x-2" data-testid={`step-${s.key}`}>
          <span className="text-muted-foreground">{i + 1}.</span>
          <span className="font-medium">{s.label}</span>
          <Badge variant="outline" className="text-[10px]">
            {s.status.replace("_", " ")}
          </Badge>
          <span className="text-xs text-muted-foreground">authority: human review</span>
          {s.evidence && (
            <span className="w-full min-w-0 pl-5 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {s.evidence}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
