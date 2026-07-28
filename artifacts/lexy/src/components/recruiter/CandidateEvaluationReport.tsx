/**
 * CandidateEvaluationReport — in-app, recruiter-editable, client-facing candidate
 * evaluation for ONE candidate × ONE role.
 *
 * Flow mirrors the outreach draft-edit-before-approval pattern: the AI produces a
 * draft, the recruiter chooses which competencies appear, edits every section and
 * adds notes, then APPROVES. Only a draft is editable; the PDF renders the merged
 * (approved) content. Verdict band / confidence / verification state are
 * deterministic server-side — the recruiter annotates but does not fabricate them.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  Lock,
  Unlock,
  Download,
  Plus,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { scoreBand, SCORE_BAND_PILL } from "@/lib/score-band";
import { downloadEvaluationReportPdf } from "@/lib/evaluation-report-pdf";
import type {
  Evaluation,
  EvaluationGetResponse,
  EvaluationLibrary,
  EvaluationHumanEdits,
  EvalBehavioral,
  EvalObservation,
  EvalDevelopment,
  EvalCompetency,
  RecommendationBand,
} from "@/lib/evaluation-types";
import { recommendationWorkflowLabel } from "@/lib/evaluation-types";

interface Props {
  jobId: string;
  candidateId: string;
  candidateName: string;
  jobTitle?: string | null;
  companyName?: string | null;
  preparedBy?: string | null;
}

const BAND_STYLE: Record<RecommendationBand, string> = {
  strongly_recommend:
    "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  recommend: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  recommend_with_reservations:
    "text-orange-700 dark:text-orange-400 bg-orange-500/10 border-orange-500/30",
  further_assessment: "text-orange-700 dark:text-orange-400 bg-orange-500/10 border-orange-500/30",
  not_recommended: "text-destructive bg-destructive/10 border-destructive/30",
};

const IMPACTS: EvalDevelopment["impact"][] = ["high", "medium", "low"];

/* ── Working (editable) copy of the merged content ───────────────────────────── */
interface Working {
  competencyKeys: string[];
  competencies: Record<string, EvalCompetency>;
  headline: string;
  executiveSummary: string;
  roleAlignment: string;
  behavioralInsights: EvalBehavioral[];
  observations: EvalObservation[];
  developmentOpportunities: EvalDevelopment[];
  concerns: string[];
  toValidate: string[];
  verificationSummary: string;
  recommendationBand: RecommendationBand;
  recommendationRationale: string;
  recruiterComments: string;
}

function toWorking(ev: Evaluation): Working {
  const c = ev.content;
  const competencies: Record<string, EvalCompetency> = {};
  for (const comp of c.competencies) competencies[comp.key] = { ...comp };
  return {
    competencyKeys: [...ev.competencyKeys],
    competencies,
    headline: c.headline ?? "",
    executiveSummary: c.executiveSummary ?? "",
    roleAlignment: c.roleAlignment ?? "",
    behavioralInsights: (c.behavioralInsights ?? []).map((b) => ({ ...b })),
    observations: (c.observations ?? []).map((o) => ({
      ...o,
      followUps: [...(o.followUps ?? [])],
    })),
    developmentOpportunities: (c.developmentOpportunities ?? []).map((d) => ({ ...d })),
    concerns: [...(c.riskAssessment?.concerns ?? [])],
    toValidate: [...(c.riskAssessment?.toValidate ?? [])],
    verificationSummary: c.verification?.summary ?? "",
    recommendationBand: c.recommendation?.band ?? ev.recommendationBand,
    recommendationRationale: c.recommendation?.rationale ?? "",
    recruiterComments: c.recruiterComments ?? "",
  };
}

const arrEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Build the sparse overlay by diffing the working copy against ai_content. */
function computeHumanEdits(w: Working, ev: Evaluation): EvaluationHumanEdits {
  const ai = ev.aiContent;
  const he: EvaluationHumanEdits = {};
  if (w.headline.trim() !== (ai.headline ?? "")) he.headline = w.headline.trim();
  if (w.executiveSummary.trim() !== (ai.executiveSummary ?? ""))
    he.executiveSummary = w.executiveSummary.trim();
  if (w.roleAlignment.trim() !== (ai.roleAlignment ?? ""))
    he.roleAlignment = w.roleAlignment.trim();

  const behavioral = w.behavioralInsights.filter((b) => b.dimension.trim() || b.descriptor.trim());
  if (!arrEq(behavioral, ai.behavioralInsights ?? [])) he.behavioralInsights = behavioral;

  const observations = w.observations
    .map((o) => ({ ...o, followUps: o.followUps.filter((f) => f.trim()) }))
    .filter((o) => o.observed.trim() || o.whyItMatters.trim());
  if (!arrEq(observations, ai.observations ?? [])) he.observations = observations;

  const development = w.developmentOpportunities.filter((d) => d.area.trim());
  if (!arrEq(development, ai.developmentOpportunities ?? []))
    he.developmentOpportunities = development;

  const concerns = w.concerns.map((s) => s.trim()).filter(Boolean);
  const toValidate = w.toValidate.map((s) => s.trim()).filter(Boolean);
  const risk: { concerns?: string[]; toValidate?: string[] } = {};
  if (!arrEq(concerns, ai.riskAssessment?.concerns ?? [])) risk.concerns = concerns;
  if (!arrEq(toValidate, ai.riskAssessment?.toValidate ?? [])) risk.toValidate = toValidate;
  if (Object.keys(risk).length) he.riskAssessment = risk;

  if (w.verificationSummary.trim() !== (ai.verification?.summary ?? "")) {
    he.verification = { summary: w.verificationSummary.trim() };
  }

  // The recommendation BAND is deterministic (server-derived) and is never
  // recruiter-editable — only the rationale narrative can be annotated.
  if (w.recommendationRationale.trim() !== (ai.recommendation?.rationale ?? "")) {
    he.recommendation = { rationale: w.recommendationRationale.trim() };
  }

  // Per-competency overrides vs ai_content.
  const aiByKey = new Map((ai.competencies ?? []).map((c) => [c.key, c]));
  const overrides: NonNullable<EvaluationHumanEdits["competencyOverrides"]> = {};
  for (const key of w.competencyKeys) {
    const cur = w.competencies[key];
    if (!cur) continue;
    const base = aiByKey.get(key);
    const evidence = cur.evidence.trim();
    const rationale = cur.rationale.trim();
    const score = cur.score;
    const changed =
      !base ||
      base.score !== score ||
      (base.evidence ?? "") !== evidence ||
      (base.rationale ?? "") !== rationale;
    if (changed && (base || evidence || rationale || score != null)) {
      overrides[key] = {
        score,
        insufficientEvidence: score == null,
        evidence,
        rationale,
      };
    }
  }
  if (Object.keys(overrides).length) he.competencyOverrides = overrides;

  if (w.recruiterComments.trim()) he.recruiterComments = w.recruiterComments.trim();

  return he;
}

export function CandidateEvaluationReport({
  jobId,
  candidateId,
  candidateName,
  jobTitle,
  companyName,
  preparedBy,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const evalKey = ["evaluation", jobId, candidateId];

  const libQuery = useQuery<EvaluationLibrary>({
    queryKey: ["evaluation-library"],
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/evaluations/library`);
      if (!res.ok) throw new Error("Failed to load competency library");
      return res.json();
    },
  });

  const evalQuery = useQuery<EvaluationGetResponse>({
    queryKey: evalKey,
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/evaluations/${jobId}/${candidateId}`);
      if (!res.ok) throw new Error("Failed to load evaluation");
      return res.json();
    },
    enabled: !!jobId && !!candidateId,
  });

  const evaluation = evalQuery.data?.evaluation ?? null;
  const isDraft = evaluation?.approvalState === "draft";
  const [working, setWorking] = useState<Working | null>(null);
  const [selectKeys, setSelectKeys] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  // Reset the working copy whenever a fresh evaluation lands (and not mid-edit).
  useEffect(() => {
    if (evaluation && !dirty) {
      setWorking(toWorking(evaluation));
      setSelectKeys([...evaluation.competencyKeys]);
    }
  }, [evaluation, dirty]);

  // Pre-select default competencies when there is no evaluation yet.
  useEffect(() => {
    if (!evaluation && evalQuery.data?.defaultCompetencyKeys) {
      setSelectKeys(evalQuery.data.defaultCompetencyKeys);
    }
  }, [evaluation, evalQuery.data]);

  const bandLabel = useMemo(() => {
    const bands = libQuery.data?.bands ?? [];
    const m = new Map(bands.map((b) => [b.value, b.label]));
    return (b: RecommendationBand) => m.get(b) ?? b.replace(/_/g, " ");
  }, [libQuery.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: evalKey });

  const generateMut = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${apiBase}/evaluations/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateId, competencyKeys: selectKeys }),
      });
      if (!res.ok)
        throw new Error((await res.json().catch(() => ({}))).error || "Failed to generate");
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({
        title: "Evaluation generated",
        description: "Review and edit the draft before approving.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not generate", description: e.message, variant: "destructive" }),
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!evaluation || !working) return;
      const humanEdits = computeHumanEdits(working, evaluation);
      const res = await apiFetch(`${apiBase}/evaluations/${evaluation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ humanEdits, competencyKeys: working.competencyKeys }),
      });
      if (res.status === 409) throw new Error("This evaluation was approved — reopen it to edit.");
      if (!res.ok) throw new Error("Failed to save changes");
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Changes saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const postAction = async (path: string) => {
    const res = await apiFetch(`${apiBase}/evaluations/${evaluation!.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Action failed");
    return res.json();
  };

  const approveMut = useMutation({
    mutationFn: () => postAction("approve"),
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Evaluation approved — ready for the client." });
    },
    onError: (e: Error) =>
      toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  const reopenMut = useMutation({
    mutationFn: () => postAction("reopen"),
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Reopened for editing." });
    },
    onError: (e: Error) =>
      toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });
  const regenerateMut = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${apiBase}/evaluations/${evaluation!.id}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competencyKeys: working?.competencyKeys }),
      });
      if (!res.ok)
        throw new Error((await res.json().catch(() => ({}))).error || "Failed to regenerate");
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({
        title: "Draft regenerated",
        description: "Your manual edits were replaced by a fresh AI draft.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not regenerate", description: e.message, variant: "destructive" }),
  });

  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    if (!evaluation) return;
    setDownloading(true);
    try {
      await downloadEvaluationReportPdf({
        candidateName,
        jobTitle: jobTitle ?? null,
        companyName: companyName ?? null,
        content: evaluation.content,
        recommendationBand: evaluation.recommendationBand,
        bandLabel: bandLabel(evaluation.recommendationBand),
        confidence: evaluation.confidence,
        preparedBy: preparedBy ?? null,
        approvedAt: evaluation.approvedAt,
        isDraft: evaluation.approvalState !== "approved",
      });
    } catch (e) {
      toast({
        title: "Could not create PDF",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  // Working-copy mutators
  const patchW = (p: Partial<Working>) => {
    setDirty(true);
    setWorking((w) => (w ? { ...w, ...p } : w));
  };

  const toggleCompetency = (key: string, on: boolean) => {
    setDirty(true);
    setWorking((w) => {
      if (!w) return w;
      const keys = on ? [...w.competencyKeys, key] : w.competencyKeys.filter((k) => k !== key);
      const competencies = { ...w.competencies };
      if (on && !competencies[key]) {
        const lib = libQuery.data?.competencies.find((c) => c.key === key);
        competencies[key] = {
          key,
          label: lib?.label ?? key,
          score: null,
          insufficientEvidence: true,
          evidence: "",
          rationale: "",
        };
      }
      return { ...w, competencyKeys: keys, competencies };
    });
  };

  const patchCompetency = (key: string, p: Partial<EvalCompetency>) => {
    setDirty(true);
    setWorking((w) =>
      w
        ? { ...w, competencies: { ...w.competencies, [key]: { ...w.competencies[key], ...p } } }
        : w,
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (evalQuery.isLoading || libQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading evaluation…
      </div>
    );
  }

  // Empty state — offer generation with a default competency set.
  if (!evaluation) {
    const lib = libQuery.data?.competencies ?? [];
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-primary" /> Client-facing evaluation
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Generate a structured, client-ready evaluation of {candidateName}
            {jobTitle ? ` for ${jobTitle}` : ""}. You'll be able to edit every section and approve
            it before anything is shared.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-sm font-medium">Competencies to assess</Label>
            <p className="text-xs text-muted-foreground mb-3">
              We've pre-selected competencies suited to this role. Adjust as needed.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {lib.map((c) => (
                <label
                  key={c.key}
                  className="flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectKeys.includes(c.key)}
                    onCheckedChange={(v) =>
                      setSelectKeys((ks) => (v ? [...ks, c.key] : ks.filter((k) => k !== c.key)))
                    }
                  />
                  <span className="text-sm leading-tight">
                    <span className="font-medium">{c.label}</span>
                    {c.description && (
                      <span className="block text-xs text-muted-foreground">{c.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <Button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending || selectKeys.length === 0}
          >
            {generateMut.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            Generate evaluation
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!working) return null;

  const lib = libQuery.data?.competencies ?? [];

  const VerifIcon =
    evaluation.content.verification.status === "verified"
      ? ShieldCheck
      : evaluation.content.verification.status === "flagged"
        ? ShieldAlert
        : ShieldQuestion;

  return (
    <div className="space-y-5">
      {/* Header / status bar */}
      <Card className="shadow-sm">
        <div className="h-1 bg-gradient-to-r from-violet-500 to-primary rounded-t-lg" />
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    isDraft
                      ? "border-primary/40 text-primary bg-primary/5"
                      : "border-emerald-300 text-emerald-700 bg-emerald-50"
                  }
                >
                  {recommendationWorkflowLabel(evaluation.approvalState)}
                </Badge>
                {evaluation.confidence != null && (
                  <span className="text-xs text-muted-foreground">
                    Confidence{" "}
                    <span className="font-semibold text-foreground">
                      {Math.round(evaluation.confidence)}%
                    </span>
                  </span>
                )}
                <Badge variant={isDraft ? "secondary" : "default"} className="gap-1">
                  {isDraft ? <Unlock className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                  {isDraft ? "Draft" : "Approved"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {candidateName}
                {jobTitle ? ` · ${jobTitle}` : ""}
                {isDraft
                  ? " — edit any section below, then approve before sharing with the client."
                  : " — approved and ready to share. Reopen to make changes."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isDraft ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => regenerateMut.mutate()}
                    disabled={regenerateMut.isPending}
                  >
                    {regenerateMut.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-1.5" />
                    )}
                    Regenerate
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => saveMut.mutate()}
                    disabled={saveMut.isPending || !dirty}
                  >
                    {saveMut.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
                    Save changes
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => approveMut.mutate()}
                    disabled={approveMut.isPending || dirty}
                  >
                    {approveMut.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 mr-1.5" />
                    )}
                    Approve
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reopenMut.mutate()}
                  disabled={reopenMut.isPending}
                >
                  {reopenMut.isPending ? (
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  ) : (
                    <Lock className="w-4 h-4 mr-1.5" />
                  )}
                  Reopen to edit
                </Button>
              )}
              <Button size="sm" onClick={handleDownload} disabled={downloading || isDraft}>
                {downloading ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 mr-1.5" />
                )}
                Download PDF
              </Button>
            </div>
          </div>
          {isDraft && (
            <p className="mt-3 text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {dirty
                ? "Unsaved changes — save before approving."
                : "Approve this evaluation to export the client-facing PDF."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Summary */}
      <Section title="Summary">
        <Field
          label="Headline"
          value={working.headline}
          readOnly={!isDraft}
          onChange={(v) => patchW({ headline: v })}
        />
        <Field
          label="Executive summary"
          value={working.executiveSummary}
          readOnly={!isDraft}
          rows={4}
          onChange={(v) => patchW({ executiveSummary: v })}
        />
        <Field
          label="Role alignment"
          value={working.roleAlignment}
          readOnly={!isDraft}
          rows={3}
          onChange={(v) => patchW({ roleAlignment: v })}
        />
      </Section>

      {/* Competencies */}
      <Section
        title="Competency assessment"
        subtitle="Choose which competencies appear on the client report and refine each."
      >
        {isDraft && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mb-4">
            {lib.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={working.competencyKeys.includes(c.key)}
                  onCheckedChange={(v) => toggleCompetency(c.key, !!v)}
                />
                {c.label}
              </label>
            ))}
          </div>
        )}
        <div className="space-y-4">
          {working.competencyKeys.map((key) => {
            const comp = working.competencies[key];
            if (!comp) return null;
            const insufficient = comp.score == null;
            const pill = insufficient
              ? "text-muted-foreground bg-muted border-border"
              : SCORE_BAND_PILL[scoreBand(comp.score!)];
            return (
              <div key={key} className="rounded-lg border p-3.5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="font-medium text-sm">{comp.label}</span>
                  {isDraft ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        placeholder="—"
                        value={comp.score ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const parsed = raw === "" ? null : Number(raw);
                          const n =
                            parsed != null && Number.isFinite(parsed)
                              ? Math.max(0, Math.min(100, parsed))
                              : null;
                          patchCompetency(key, { score: n, insufficientEvidence: n == null });
                        }}
                        className="w-20 h-8 text-sm"
                      />
                      <span className="text-xs text-muted-foreground">/100</span>
                    </div>
                  ) : (
                    <Badge variant="outline" className={pill}>
                      {insufficient ? "Insufficient evidence" : `${Math.round(comp.score!)}/100`}
                    </Badge>
                  )}
                </div>
                <Field
                  label="Evidence"
                  value={comp.evidence}
                  readOnly={!isDraft}
                  rows={2}
                  onChange={(v) => patchCompetency(key, { evidence: v })}
                />
                <Field
                  label="Rationale"
                  value={comp.rationale}
                  readOnly={!isDraft}
                  rows={2}
                  onChange={(v) => patchCompetency(key, { rationale: v })}
                />
              </div>
            );
          })}
        </div>
      </Section>

      {/* Behavioral insights */}
      <Section title="Behavioral insights">
        <ListEditor
          items={working.behavioralInsights}
          readOnly={!isDraft}
          onChange={(items) => patchW({ behavioralInsights: items })}
          empty={{ dimension: "", descriptor: "" }}
          render={(item, update) => (
            <>
              <Field
                label="Dimension"
                value={item.dimension}
                readOnly={!isDraft}
                onChange={(v) => update({ dimension: v })}
              />
              <Field
                label="Descriptor"
                value={item.descriptor}
                readOnly={!isDraft}
                rows={2}
                onChange={(v) => update({ descriptor: v })}
              />
            </>
          )}
        />
      </Section>

      {/* Observations */}
      <Section title="Key observations">
        <ListEditor
          items={working.observations}
          readOnly={!isDraft}
          onChange={(items) => patchW({ observations: items })}
          empty={{ observed: "", whyItMatters: "", followUps: [] }}
          render={(item, update) => (
            <>
              <Field
                label="Observed"
                value={item.observed}
                readOnly={!isDraft}
                rows={2}
                onChange={(v) => update({ observed: v })}
              />
              <Field
                label="Why it matters"
                value={item.whyItMatters}
                readOnly={!isDraft}
                rows={2}
                onChange={(v) => update({ whyItMatters: v })}
              />
              <Field
                label="Follow-ups (one per line)"
                value={item.followUps.join("\n")}
                readOnly={!isDraft}
                rows={2}
                onChange={(v) =>
                  update({
                    followUps: v
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </>
          )}
        />
      </Section>

      {/* Development opportunities */}
      <Section title="Development opportunities">
        <ListEditor
          items={working.developmentOpportunities}
          readOnly={!isDraft}
          onChange={(items) => patchW({ developmentOpportunities: items })}
          empty={{ area: "", impact: "medium" as EvalDevelopment["impact"], coaching: "" }}
          render={(item, update) => (
            <>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1">
                  <Field
                    label="Area"
                    value={item.area}
                    readOnly={!isDraft}
                    onChange={(v) => update({ area: v })}
                  />
                </div>
                <div className="w-32">
                  <Label className="text-xs text-muted-foreground">Impact</Label>
                  {isDraft ? (
                    <Select
                      value={item.impact}
                      onValueChange={(v) => update({ impact: v as EvalDevelopment["impact"] })}
                    >
                      <SelectTrigger className="h-9 mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {IMPACTS.map((i) => (
                          <SelectItem key={i} value={i} className="capitalize">
                            {i}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm capitalize mt-1.5">{item.impact}</p>
                  )}
                </div>
              </div>
              <Field
                label="Coaching"
                value={item.coaching}
                readOnly={!isDraft}
                rows={2}
                onChange={(v) => update({ coaching: v })}
              />
            </>
          )}
        />
      </Section>

      {/* Risk & validation */}
      <Section title="Risk & points to validate">
        <Field
          label="Concerns (one per line)"
          value={working.concerns.join("\n")}
          readOnly={!isDraft}
          rows={3}
          onChange={(v) => patchW({ concerns: v.split("\n") })}
        />
        <Field
          label="For the client to validate (one per line)"
          value={working.toValidate.join("\n")}
          readOnly={!isDraft}
          rows={3}
          onChange={(v) => patchW({ toValidate: v.split("\n") })}
        />
      </Section>

      {/* Verification (status is deterministic; only the note is editable) */}
      <Section title="Verification">
        <div className="flex items-center gap-2 mb-2">
          <VerifIcon className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium capitalize">
            {evaluation.content.verification.status.replace(/_/g, " ")}
          </span>
          <span className="text-xs text-muted-foreground">(system-derived)</span>
        </div>
        <Field
          label="Verification note"
          value={working.verificationSummary}
          readOnly={!isDraft}
          rows={2}
          onChange={(v) => patchW({ verificationSummary: v })}
        />
      </Section>

      {/* Recommendation */}
      <Section title="Recommendation">
        <div className="mb-3">
          <Label className="text-xs text-muted-foreground">Recommendation status</Label>
          <div className="mt-1 flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                isDraft
                  ? "border-primary/40 text-primary bg-primary/5"
                  : "border-emerald-300 text-emerald-700 bg-emerald-50"
              }
            >
              {recommendationWorkflowLabel(evaluation.approvalState)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {isDraft
                ? "Becomes “Approved with Recruiter Recommendation” once you approve this report."
                : "Approved by the recruiter."}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="outline" className={BAND_STYLE[evaluation.recommendationBand]}>
              AI suggestion: {bandLabel(evaluation.recommendationBand)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Internal only — never shown on the client report.
            </span>
          </div>
        </div>
        <Field
          label="Rationale"
          value={working.recommendationRationale}
          readOnly={!isDraft}
          rows={3}
          onChange={(v) => patchW({ recommendationRationale: v })}
        />
      </Section>

      {/* Recruiter comments */}
      <Section title="Recruiter notes" subtitle="Your own note, appended to the client report.">
        <Field
          label="Notes"
          value={working.recruiterComments}
          readOnly={!isDraft}
          rows={3}
          onChange={(v) => patchW({ recruiterComments: v })}
        />
      </Section>

      <Separator />
      <p className="text-xs text-muted-foreground">
        Verdict band, confidence and verification status are derived from verified signals and
        cannot be hand-set. You can annotate them and edit every narrative section; approve to lock
        the client-facing version.
      </p>
    </div>
  );
}

/* ── Presentational helpers ─────────────────────────────────────────────────── */
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-primary uppercase tracking-wide">
          {title}
        </CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="pt-0 space-y-3">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  rows?: number;
}) {
  if (readOnly) {
    if (!value?.trim()) {
      return (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          <p className="text-sm text-muted-foreground italic">Not provided</p>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{value}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {rows && rows > 1 ? (
        <Textarea
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className="text-sm"
        />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" />
      )}
    </div>
  );
}

function ListEditor<T>({
  items,
  onChange,
  render,
  empty,
  readOnly,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  render: (item: T, update: (p: Partial<T>) => void) => React.ReactNode;
  empty: T;
  readOnly?: boolean;
}) {
  if (readOnly && items.length === 0) {
    return <p className="text-sm text-muted-foreground italic">Not provided</p>;
  }
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border p-3 relative">
          {render(item, (p) => onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it))))}
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2 h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button variant="outline" size="sm" onClick={() => onChange([...items, { ...empty }])}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
        </Button>
      )}
    </div>
  );
}
