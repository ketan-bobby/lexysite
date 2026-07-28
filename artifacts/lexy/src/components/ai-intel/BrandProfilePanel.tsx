/**
 * BrandProfilePanel — tenant Brand Intelligence editor (T007).
 *
 * All brand-voice fields + tone selector + words to use/avoid + the AI kill
 * switch, plus the tenant document manager. Saves via PUT
 * /tenants/:id/ai-brand-profile.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Loader2, Save, Power } from "lucide-react";
import { aiFetch, AI_TONES } from "@/lib/ai-intel-api";
import { DocumentManager } from "./DocumentManager";

type Profile = Record<string, any> | null;

const TEXT_FIELDS: { key: string; label: string; hint?: string; rows?: number }[] = [
  { key: "companyOverview", label: "Company overview", rows: 3 },
  { key: "employerBrandStatement", label: "Employer brand statement", rows: 2 },
  { key: "mission", label: "Mission", rows: 2 },
  { key: "values", label: "Values", rows: 2 },
  { key: "cultureNotes", label: "Culture notes", rows: 2 },
  { key: "candidateValueProp", label: "Candidate value proposition", rows: 2 },
  { key: "deiStatement", label: "DEI statement", rows: 2 },
  { key: "benefitsSummary", label: "Benefits summary", rows: 2 },
  { key: "approvedBoilerplate", label: "Approved boilerplate", hint: "Reusable approved copy (legal disclaimers, sign-offs).", rows: 2 },
];

export function BrandProfilePanel({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Record<string, any>>({});

  const { data, isLoading } = useQuery<{ profile: Profile }>({
    queryKey: ["ai-brand-profile", tenantId],
    queryFn: () => aiFetch(`/tenants/${tenantId}/ai-brand-profile`),
    enabled: !!tenantId,
  });

  useEffect(() => {
    setForm(data?.profile ?? { aiMessagingEnabled: true });
  }, [data, tenantId]);

  const saveMut = useMutation({
    mutationFn: () => {
      const payload: Record<string, any> = {};
      const keys = [
        "companyName", "website", "industry", "companyOverview", "employerBrandStatement",
        "mission", "values", "cultureNotes", "deiStatement", "candidateValueProp",
        "toneOfVoice", "wordsToUse", "wordsToAvoid", "approvedBoilerplate",
        "benefitsSummary", "careersUrl", "brandGuideUrl", "aiMessagingEnabled",
      ];
      for (const k of keys) if (form[k] !== undefined) payload[k] = form[k] === "" ? null : form[k];
      return aiFetch(`/tenants/${tenantId}/ai-brand-profile`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      toast({ title: "Brand profile saved" });
      qc.invalidateQueries({ queryKey: ["ai-brand-profile", tenantId] });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  if (isLoading) return <p className="text-sm text-muted-foreground py-8">Loading brand profile…</p>;

  const aiOn = form.aiMessagingEnabled !== false;

  return (
    <div className="space-y-6">
      {/* Kill switch */}
      <Card className={aiOn ? "" : "border-amber-300 bg-amber-50/40"}>
        <CardContent className="p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${aiOn ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
              <Power className="w-5 h-5" />
            </div>
            <div>
              <p className="font-semibold">AI message generation</p>
              <p className="text-xs text-muted-foreground">
                {aiOn ? "Enabled — recruiters can generate AI drafts for this tenant." : "Disabled — generation is blocked for this tenant."}
              </p>
            </div>
          </div>
          <Switch checked={aiOn} onCheckedChange={(v) => set("aiMessagingEnabled", v)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Company</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Company name"><Input value={form.companyName ?? ""} onChange={(e) => set("companyName", e.target.value)} /></Field>
          <Field label="Industry"><Input value={form.industry ?? ""} onChange={(e) => set("industry", e.target.value)} /></Field>
          <Field label="Website"><Input value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} /></Field>
          <Field label="Careers URL"><Input value={form.careersUrl ?? ""} onChange={(e) => set("careersUrl", e.target.value)} /></Field>
          <Field label="Brand guide URL"><Input value={form.brandGuideUrl ?? ""} onChange={(e) => set("brandGuideUrl", e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Brand voice</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Default tone of voice">
              <Select value={form.toneOfVoice ?? ""} onValueChange={(v) => set("toneOfVoice", v)}>
                <SelectTrigger><SelectValue placeholder="Select tone" /></SelectTrigger>
                <SelectContent>
                  {AI_TONES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Words to use" hint="Comma-separated preferred terms.">
              <Input value={form.wordsToUse ?? ""} onChange={(e) => set("wordsToUse", e.target.value)} />
            </Field>
            <Field label="Words to avoid" hint="Comma-separated terms to steer clear of.">
              <Input value={form.wordsToAvoid ?? ""} onChange={(e) => set("wordsToAvoid", e.target.value)} />
            </Field>
          </div>
          {TEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Textarea rows={f.rows ?? 2} value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Knowledge documents</CardTitle></CardHeader>
        <CardContent>
          <DocumentManager scope="tenants" scopeId={tenantId} defaultDocType="brand_guide" />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button className="gap-2" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
          {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save brand profile
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
