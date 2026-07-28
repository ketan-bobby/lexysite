/**
 * NurtureSequenceEditor.tsx — Multi-step candidate nurture sequence builder.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Lets recruiters compose an ordered drip sequence of outreach steps (Email,
 * LinkedIn message, SMS/phone) for a given job.  Each step has a channel, a
 * delay (days after the previous step), a subject line, and a body template.
 * AI-generate buttons call the Outreach Agent to draft step copy automatically.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  <StepCard>                 Collapsible card for a single sequence step
 *  <NurtureSequenceEditor>    Root: loads existing sequence, handles add/remove/
 *                             reorder/save, triggers AI-generation per step
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET  /api/outreach/sequences/:jobId      Load saved sequence
 *  POST /api/outreach/sequences/:jobId      Save/overwrite sequence
 *  POST /api/outreach/generate-step         AI-generate a single step body
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/outreach/index.tsx       Outreach configuration tab
 */

import { useState } from "react";
import { apiFetch, apiBase } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Trash2, GripVertical, Save, Mail, Phone, Linkedin,
  ChevronDown, ChevronUp, Clock, Wand2, AlertCircle, CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@workspace/react-hooks/use-toast";
import { cn } from "@/lib/utils";

/** Thin JSON layer over the shared apiFetch: parses JSON, throws err.error on non-OK. */
async function fetchJson<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${apiBase}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `API ${res.status}`);
  }
  return res.json();
}

export interface NurtureStep {
  id: string;
  order: number;
  delayDays: number;
  channel: "email" | "call_reminder" | "linkedin";
  label: string;
  toneInstructions: string;
  templateBody: string;
  templateSubject: string;
  finalStep: boolean;
}

const CHANNEL_CONFIG = {
  email:         { label: "Email",          icon: Mail,     color: "text-blue-400",   bg: "bg-blue-500/10" },
  call_reminder: { label: "Call Reminder",  icon: Phone,    color: "text-green-400",  bg: "bg-green-500/10" },
  linkedin:      { label: "LinkedIn DM",    icon: Linkedin, color: "text-sky-400",    bg: "bg-sky-500/10" },
};

const VARIABLES = [
  { var: "{{candidate_name}}",    desc: "Candidate's first name" },
  { var: "{{job_title}}",         desc: "Role title" },
  { var: "{{recruiter_signature}}", desc: "Recruiter name / sign-off" },
];

function VariableChip({ variable, onInsert }: { variable: string; onInsert: (v: string) => void }) {
  return (
    <button
      onClick={() => onInsert(variable)}
      className="text-[10px] px-2 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors font-mono"
    >
      {variable}
    </button>
  );
}

function StepCard({
  step, index, total, onChange, onDelete, onMoveUp, onMoveDown,
}: {
  step: NurtureStep;
  index: number;
  total: number;
  onChange: (updated: NurtureStep) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [expanded, setExpanded] = useState(index === 0);
  const cfg = CHANNEL_CONFIG[step.channel];
  const Icon = cfg.icon;

  function update(patch: Partial<NurtureStep>) {
    onChange({ ...step, ...patch });
  }

  function insertVar(field: "templateSubject" | "templateBody", variable: string) {
    update({ [field]: (step[field] ?? "") + variable });
  }

  return (
    <Card className={cn(
      "border transition-all",
      step.finalStep ? "border-orange-500/30 bg-orange-500/5" : "border-border/60",
    )}>
      <CardHeader className="p-4 pb-0">
        <div className="flex items-center gap-3">
          {/* Drag handle (visual only) */}
          <GripVertical className="w-4 h-4 text-muted-foreground/40 cursor-grab flex-shrink-0" />

          {/* Step badge */}
          <div className={cn("p-1.5 rounded-lg flex-shrink-0", cfg.bg)}>
            <Icon className={cn("w-4 h-4", cfg.color)} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground font-medium">Step {index + 1}</span>
              <Badge variant="outline" className={cn("text-[10px] px-1.5", cfg.color)}>{cfg.label}</Badge>
              {step.finalStep && (
                <Badge className="text-[10px] px-1.5 bg-orange-500/20 text-orange-400">Final Step</Badge>
              )}
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="w-3 h-3" />
                Day {step.delayDays}
              </span>
            </div>
            <p className="text-sm font-semibold mt-0.5 truncate">{step.label || "Untitled Step"}</p>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onMoveUp} disabled={index === 0}>
              <ChevronUp className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onMoveDown} disabled={index === total - 1}>
              <ChevronDown className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={onDelete}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" variant="ghost" aria-label={expanded ? "Collapse step" : "Expand step"} aria-expanded={expanded} className="h-7 w-7 p-0" onClick={() => setExpanded(v => !v)}>
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="p-4 pt-4 space-y-4">
          {/* Row 1: Label + Channel + Delay */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1 space-y-1.5">
              <Label className="text-xs">Step Label</Label>
              <Input
                value={step.label}
                onChange={e => update({ label: e.target.value })}
                placeholder="e.g. Warm Check-In"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Channel</Label>
              <Select value={step.channel} onValueChange={v => update({ channel: v as any })}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="call_reminder">Call Reminder</SelectItem>
                  <SelectItem value="linkedin">LinkedIn DM</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Send After (days)</Label>
              <Input
                type="number"
                min={0}
                value={step.delayDays}
                onChange={e => update({ delayDays: Number(e.target.value) })}
                className="h-8 text-sm"
              />
            </div>
          </div>

          {/* Tone instructions */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Wand2 className="w-3 h-3 text-primary" /> AI Tone Instructions
              <span className="text-muted-foreground font-normal">(AI reads this to shape the message)</span>
            </Label>
            <Textarea
              value={step.toneInstructions}
              onChange={e => update({ toneInstructions: e.target.value })}
              placeholder="e.g. Warm and human, not pushy. Acknowledge they may be busy. Light CTA."
              className="text-sm resize-none min-h-[60px]"
              rows={2}
            />
          </div>

          {/* Email fields */}
          {step.channel === "email" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Subject Template</Label>
                <div className="flex gap-1.5 mb-1.5 flex-wrap">
                  {VARIABLES.slice(0, 2).map(v => (
                    <VariableChip key={v.var} variable={v.var} onInsert={val => insertVar("templateSubject", val)} />
                  ))}
                </div>
                <Input
                  value={step.templateSubject}
                  onChange={e => update({ templateSubject: e.target.value })}
                  placeholder="e.g. Quick check-in, {{candidate_name}}"
                  className="h-8 text-sm font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Message Template</Label>
                <div className="flex gap-1.5 mb-1.5 flex-wrap">
                  {VARIABLES.map(v => (
                    <VariableChip key={v.var} variable={v.var} onInsert={val => insertVar("templateBody", val)} />
                  ))}
                </div>
                <Textarea
                  value={step.templateBody}
                  onChange={e => update({ templateBody: e.target.value })}
                  placeholder="Hi {{candidate_name}},..."
                  className="text-sm font-mono resize-none min-h-[140px]"
                  rows={7}
                />
                <p className="text-[10px] text-muted-foreground">
                  AI will personalise this template per candidate — click variable chips to insert placeholders.
                </p>
              </div>
            </>
          )}

          {step.channel === "call_reminder" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Talking Points / Reminder Note</Label>
              <Textarea
                value={step.templateBody}
                onChange={e => update({ templateBody: e.target.value })}
                placeholder="e.g. Mention the role is still open. Check if they have questions about compensation or start date. Keep it under 3 mins."
                className="text-sm resize-none min-h-[100px]"
                rows={4}
              />
            </div>
          )}

          {step.channel === "linkedin" && (
            <div className="space-y-1.5">
              <Label className="text-xs">LinkedIn DM Template</Label>
              <div className="flex gap-1.5 mb-1.5 flex-wrap">
                {VARIABLES.map(v => (
                  <VariableChip key={v.var} variable={v.var} onInsert={val => insertVar("templateBody", val)} />
                ))}
              </div>
              <Textarea
                value={step.templateBody}
                onChange={e => update({ templateBody: e.target.value })}
                placeholder="Hi {{candidate_name}}, wanted to reconnect about the {{job_title}} role..."
                className="text-sm font-mono resize-none min-h-[100px]"
                rows={4}
              />
            </div>
          )}

          {/* Final step toggle */}
          <div className="flex items-center justify-between pt-1 border-t border-border/40">
            <div>
              <p className="text-xs font-medium">Mark as Final Step</p>
              <p className="text-[10px] text-muted-foreground">After this step, the candidate is archived from the nurture pool.</p>
            </div>
            <Switch
              checked={step.finalStep}
              onCheckedChange={v => update({ finalStep: v })}
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Main Editor ──────────────────────────────────────────────────────────────
export function NurtureSequenceEditor({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [steps, setSteps] = useState<NurtureStep[] | null>(null);
  const [dirty, setDirty] = useState(false);

  const { isLoading } = useQuery<{ nurtureSteps: NurtureStep[] }>({
    queryKey: ["nurture-sequence", jobId],
    queryFn: () => fetchJson(`/ghosting/jobs/${jobId}/nurture-sequence`),
    enabled: !!jobId,
    onSuccess: (data: { nurtureSteps: NurtureStep[] }) => {
      if (!dirty) setSteps(data.nurtureSteps);
    },
  } as any);

  const saveMut = useMutation({
    mutationFn: (nurtureSteps: NurtureStep[]) =>
      fetchJson(`/ghosting/jobs/${jobId}/nurture-sequence`, {
        method: "PUT",
        body: JSON.stringify({ nurtureSteps }),
      }),
    onSuccess: () => {
      toast({ title: "Nurture sequence saved" });
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["nurture-sequence", jobId] });
    },
    onError: (err: any) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  function updateStep(index: number, updated: NurtureStep) {
    setSteps(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = updated;
      return next;
    });
    setDirty(true);
  }

  function deleteStep(index: number) {
    setSteps(prev => {
      if (!prev) return prev;
      const next = prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i + 1 }));
      return next;
    });
    setDirty(true);
  }

  function addStep() {
    const newStep: NurtureStep = {
      id: crypto.randomUUID(),
      order: (steps?.length ?? 0) + 1,
      delayDays: (steps?.[steps.length - 1]?.delayDays ?? 0) + 14,
      channel: "email",
      label: "New Step",
      toneInstructions: "",
      templateSubject: "Following up, {{candidate_name}}",
      templateBody: `Hi {{candidate_name}},\n\n\n\n{{recruiter_signature}}`,
      finalStep: false,
    };
    setSteps(prev => [...(prev ?? []), newStep]);
    setDirty(true);
  }

  function moveStep(index: number, direction: "up" | "down") {
    setSteps(prev => {
      if (!prev) return prev;
      const next = [...prev];
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((s, i) => ({ ...s, order: i + 1 }));
    });
    setDirty(true);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading sequence…
      </div>
    );
  }

  const displaySteps = steps ?? [];

  // Compute cumulative day timeline
  function cumulativeDays(index: number): number {
    return displaySteps.slice(0, index + 1).reduce((sum, s) => sum + s.delayDays, 0);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-base flex items-center gap-2">
            Nurture Sequence
            {dirty && <Badge className="text-[10px] px-1.5 bg-amber-500/20 text-amber-400">Unsaved changes</Badge>}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure the multi-step re-engagement flow for ghosted candidates in this work order.
            AI will personalise each message using your template and tone instructions.
          </p>
        </div>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => saveMut.mutate(displaySteps)}
          disabled={!dirty || saveMut.isPending}
        >
          {saveMut.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saveMut.isPending ? "Saving…" : "Save Sequence"}
        </Button>
      </div>

      {/* Timeline legend */}
      {displaySteps.length > 0 && (
        <div className="flex items-center gap-0 overflow-x-auto pb-2">
          {displaySteps.map((step, i) => {
            const cfg = CHANNEL_CONFIG[step.channel];
            const Icon = cfg.icon;
            const cumDay = cumulativeDays(i);
            return (
              <div key={step.id} className="flex items-center gap-0 flex-shrink-0">
                <div className={cn("flex flex-col items-center px-3 py-2 rounded-lg", cfg.bg)}>
                  <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
                  <span className="text-[10px] text-muted-foreground mt-0.5">Day {cumDay}</span>
                  <span className={cn("text-[10px] font-medium", cfg.color)}>{step.label}</span>
                </div>
                {i < displaySteps.length - 1 && (
                  <div className="flex items-center gap-1 px-1">
                    <div className="h-px w-6 bg-border" />
                    <span className="text-[9px] text-muted-foreground whitespace-nowrap">
                      +{displaySteps[i + 1].delayDays}d
                    </span>
                    <div className="h-px w-6 bg-border" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Variables reference */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border/40">
        <AlertCircle className="w-3.5 h-3.5 text-primary flex-shrink-0" />
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground">Available variables:</span>
          {VARIABLES.map(v => (
            <span key={v.var} className="flex items-center gap-1">
              <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{v.var}</span>
              <span className="text-[10px] text-muted-foreground">{v.desc}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Step cards */}
      {displaySteps.length === 0 ? (
        <div className="border-dashed border-2 border-border rounded-lg py-10 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">No steps yet</p>
          <p className="text-xs text-muted-foreground/70">Add your first re-engagement step below.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {displaySteps.map((step, i) => (
            <StepCard
              key={step.id}
              step={step}
              index={i}
              total={displaySteps.length}
              onChange={updated => updateStep(i, updated)}
              onDelete={() => deleteStep(i)}
              onMoveUp={() => moveStep(i, "up")}
              onMoveDown={() => moveStep(i, "down")}
            />
          ))}
        </div>
      )}

      {/* Add step button */}
      <Button variant="outline" className="w-full gap-2 border-dashed" onClick={addStep}>
        <Plus className="w-4 h-4" /> Add Step
      </Button>

      {/* Save CTA (bottom) */}
      {dirty && (
        <div className="sticky bottom-4 flex justify-end pt-2">
          <Button
            className="gap-1.5 shadow-lg"
            onClick={() => saveMut.mutate(displaySteps)}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saveMut.isPending ? "Saving…" : "Save Sequence"}
          </Button>
        </div>
      )}
    </div>
  );
}
