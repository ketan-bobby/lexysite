/**
 * RoleContextPanel — per-workorder AI Role Context editor (T008).
 *
 * Role-specific context that the AI prioritises OVER the tenant brand profile on
 * conflict, plus the per-job document manager. Saves via PUT /jobs/:id/ai-context.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Loader2, Save, Info } from "lucide-react";
import { aiFetch } from "@/lib/ai-intel-api";
import { DocumentManager } from "./DocumentManager";

const WORK_MODELS = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "Onsite" },
];
const URGENCY = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const TEXT_FIELDS: { key: string; label: string; hint?: string; rows?: number }[] = [
  { key: "whyRoleExists", label: "Why this role exists", rows: 2 },
  { key: "businessProblem", label: "Business problem it solves", rows: 2 },
  { key: "teamDescription", label: "Team description", rows: 2 },
  { key: "projectDescription", label: "Project description", rows: 2 },
  { key: "candidateSellingPoints", label: "Candidate selling points", hint: "Why a great candidate would want this role.", rows: 2 },
  { key: "candidateConcerns", label: "Likely candidate concerns", hint: "Objections to address proactively.", rows: 2 },
  { key: "interviewProcess", label: "Interview process", rows: 2 },
  { key: "compensationNotes", label: "Compensation notes", hint: "Only used if you want the AI to reference comp.", rows: 2 },
  { key: "hiringManagerPreferences", label: "Hiring-manager preferences", rows: 2 },
  { key: "messagingAngle", label: "Messaging angle", hint: "The pitch the AI should lead with.", rows: 2 },
  { key: "aiInstructions", label: "Extra AI instructions", hint: "Role-specific guidance (treated as data, not commands).", rows: 2 },
];

export function RoleContextPanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Record<string, any>>({});

  const { data, isLoading } = useQuery<{ context: Record<string, any> | null }>({
    queryKey: ["ai-context", jobId],
    queryFn: () => aiFetch(`/jobs/${jobId}/ai-context`),
    enabled: !!jobId,
  });

  useEffect(() => { setForm(data?.context ?? {}); }, [data, jobId]);

  const saveMut = useMutation({
    mutationFn: () => {
      const keys = [
        "projectName", "department", "hiringManager", "whyRoleExists", "businessProblem",
        "teamDescription", "projectDescription", "techStack", "mustHaveSkills",
        "niceToHaveSkills", "candidateSellingPoints", "candidateConcerns", "interviewProcess",
        "compensationNotes", "workModel", "urgencyLevel", "hiringManagerPreferences",
        "messagingAngle", "aiInstructions",
      ];
      const payload: Record<string, any> = {};
      for (const k of keys) if (form[k] !== undefined) payload[k] = form[k] === "" ? null : form[k];
      return aiFetch(`/jobs/${jobId}/ai-context`, { method: "PUT", body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      toast({ title: "Role context saved" });
      qc.invalidateQueries({ queryKey: ["ai-context", jobId] });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  if (isLoading) return <p className="text-sm text-muted-foreground py-8">Loading role context…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <span>Role context takes priority over the tenant brand profile when they conflict. Compliance guardrails (no invented comp, benefits, or visa terms) always apply.</span>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Role basics</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Project name"><Input value={form.projectName ?? ""} onChange={(e) => set("projectName", e.target.value)} /></Field>
          <Field label="Department"><Input value={form.department ?? ""} onChange={(e) => set("department", e.target.value)} /></Field>
          <Field label="Hiring manager"><Input value={form.hiringManager ?? ""} onChange={(e) => set("hiringManager", e.target.value)} /></Field>
          <Field label="Work model">
            <Select value={form.workModel ?? ""} onValueChange={(v) => set("workModel", v)}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>{WORK_MODELS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Urgency">
            <Select value={form.urgencyLevel ?? ""} onValueChange={(v) => set("urgencyLevel", v)}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>{URGENCY.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Skills & stack</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Tech stack"><Input value={form.techStack ?? ""} onChange={(e) => set("techStack", e.target.value)} /></Field>
          <Field label="Must-have skills"><Input value={form.mustHaveSkills ?? ""} onChange={(e) => set("mustHaveSkills", e.target.value)} /></Field>
          <Field label="Nice-to-have skills"><Input value={form.niceToHaveSkills ?? ""} onChange={(e) => set("niceToHaveSkills", e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Context & messaging</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {TEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Textarea rows={f.rows ?? 2} value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Role documents</CardTitle></CardHeader>
        <CardContent>
          <DocumentManager scope="jobs" scopeId={jobId} defaultDocType="workorder_doc" />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button className="gap-2" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
          {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save role context
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
