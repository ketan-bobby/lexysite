import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateRecruitingConfiguration,
  getGetJobQueryKey,
  getListJobsQueryKey,
  type Job,
  type RecruitingMode,
  type InterviewPath,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@workspace/react-hooks/use-toast";

export const DEFAULT_RECRUITING_MODE: RecruitingMode = "human_assisted";
export const DEFAULT_INTERVIEW_PATH: InterviewPath = "recruiter_choice";

const MODES: { value: RecruitingMode; label: string; hint: string }[] = [
  {
    value: "human_assisted",
    label: "Human Assisted",
    hint: "Recruiters run each step with Lexy's assistance.",
  },
  {
    value: "lexy_autonomous",
    label: "Lexy Autonomous (planned)",
    hint: "Recorded as intent only. Nothing runs autonomously.",
  },
];
const PATHS: { value: InterviewPath; label: string }[] = [
  { value: "ai", label: "AI interview" },
  { value: "human", label: "Human interview" },
  { value: "ai_then_human", label: "AI then Human" },
  { value: "human_then_ai", label: "Human then AI" },
  { value: "recruiter_choice", label: "Recruiter choice per candidate" },
];
const modeLabel = (m?: string) => MODES.find((x) => x.value === m)?.label ?? MODES[0].label;
const pathLabel = (p?: string) => PATHS.find((x) => x.value === p)?.label ?? PATHS[4].label;

export function RecruitingConfigurationFields({
  mode,
  path,
  onMode,
  onPath,
  disabled,
  idPrefix = "recruiting",
}: {
  mode: RecruitingMode;
  path: InterviewPath;
  onMode: (m: RecruitingMode) => void;
  onPath: (p: InterviewPath) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-4" data-testid={`${idPrefix}-settings`}>
      <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-config-only-note`}>
        Configuration only—autonomous execution is not enabled. Changing these settings does not
        start agents, contact candidates, or create interviews; existing assisted actions remain
        available.
      </p>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-medium mb-1">Recruiting mode</legend>
        {MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-mode`}
              className="mt-1"
              checked={mode === m.value}
              onChange={() => onMode(m.value)}
              data-testid={`${idPrefix}-mode-${m.value}`}
            />
            <span>
              <span className="font-medium">{m.label}</span>
              <span className="block text-xs text-muted-foreground">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-medium mb-1">Planned interview path</legend>
        {PATHS.map((p) => (
          <label key={p.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-path`}
              checked={path === p.value}
              onChange={() => onPath(p.value)}
              data-testid={`${idPrefix}-path-${p.value}`}
            />
            {p.label}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          The interview path is distinct from the assessment type (behavioral, technical, etc.).
          Progression remains Human review, and final hiring decisions stay human-owned.
        </p>
      </fieldset>
    </div>
  );
}

export function RecruitingConfigurationCard({
  job,
  canEdit,
}: {
  job: Pick<Job, "id" | "recruitingMode" | "interviewPath">;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const savedMode: RecruitingMode = job.recruitingMode ?? DEFAULT_RECRUITING_MODE;
  const savedPath: InterviewPath = job.interviewPath ?? DEFAULT_INTERVIEW_PATH;
  const [mode, setMode] = useState(savedMode);
  const [path, setPath] = useState(savedPath);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const mutation = useUpdateRecruitingConfiguration();

  // Sync from persisted values only while the draft is clean.
  useEffect(() => {
    if (!dirty.current) {
      setMode(savedMode);
      setPath(savedPath);
      setError(null);
    }
  }, [savedMode, savedPath]);

  const changed = mode !== savedMode || path !== savedPath;
  const save = () => {
    setError(null);
    mutation.mutate(
      { jobId: job.id, data: { recruitingMode: mode, interviewPath: path } },
      {
        onSuccess: (updated) => {
          dirty.current = false;
          qc.setQueryData<Job>(getGetJobQueryKey(job.id), (old) =>
            old ? { ...old, ...updated } : updated,
          );
          qc.invalidateQueries({ queryKey: getGetJobQueryKey(job.id) });
          qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
          toast({
            title: "Recruiting settings saved",
            description: "Configuration only. No agents were started.",
          });
        },
        onError: (e) =>
          setError(e instanceof Error ? e.message : "Could not save recruiting settings."),
      },
    );
  };

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 space-y-4"
      data-testid="recruiting-config-summary"
    >
      <h3 className="text-sm font-semibold">Recruiting configuration</h3>
      <p className="text-sm" data-testid="text-recruiting-saved">
        Mode: <b>{modeLabel(savedMode)}</b> · Interview path: <b>{pathLabel(savedPath)}</b> ·
        Progression: Human review
      </p>
      {canEdit ? (
        <>
          <RecruitingConfigurationFields
            mode={mode}
            path={path}
            idPrefix="job-recruiting"
            disabled={mutation.isPending}
            onMode={(m) => {
              dirty.current = true;
              setMode(m);
            }}
            onPath={(p) => {
              dirty.current = true;
              setPath(p);
            }}
          />
          {error && (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-testid="text-recruiting-error"
            >
              {error}
            </p>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={!changed || mutation.isPending}
            data-testid="button-save-recruiting-settings"
          >
            {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
            Save recruiting settings
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Configuration only—autonomous execution is not enabled. Settings are view-only for your
          role.
        </p>
      )}
    </div>
  );
}
