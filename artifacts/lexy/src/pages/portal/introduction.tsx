import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";

type Strength = { title: string; evidence: string };
type Achievement = { text: string };
type Introduction = {
  exists: boolean; status: "draft" | "approved" | "withdrawn"; summary: string;
  strengths: Strength[]; achievements: Achievement[]; careerDirection: string | null;
  rolePreferences: string | null; availability: string | null; version?: string | null;
};

const emptyIntroduction: Introduction = {
  exists: false, status: "draft", summary: "", strengths: [], achievements: [],
  careerDirection: null, rolePreferences: null, availability: null,
};

export default function PortalIntroduction() {
  const [introduction, setIntroduction] = useState<Introduction>(emptyIntroduction);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    apiFetch(`${apiBase}/portal/introduction`).then(async (res) => {
      if (!res.ok) throw new Error("Unable to load your introduction.");
      return res.json();
    }).then((data) => {
      setIntroduction({ ...emptyIntroduction, ...data });
      setDirty(false);
      setError(null);
    })
      .catch((err) => setError(err.message ?? "Unable to load your introduction."))
      .finally(() => setLoading(false));
  }, []);

  const update = <K extends keyof Introduction>(key: K, value: Introduction[K]) => {
    setDirty(true);
    setIntroduction((current) => ({ ...current, [key]: value }));
  };

  async function action(path: string, body?: Introduction) {
    setSaving(true); setError(null); setMessage(null);
    try {
      const res = await apiFetch(`${apiBase}${path}`, {
        method: path.endsWith("/introduction") ? "PUT" : "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(path.endsWith("/approve") ? { version: body.version } : {
          summary: body.summary, strengths: body.strengths, achievements: body.achievements,
          careerDirection: body.careerDirection, rolePreferences: body.rolePreferences,
          availability: body.availability,
        }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Your changes could not be saved.");
      setIntroduction({ ...emptyIntroduction, ...data });
      setDirty(false);
      setMessage(path.endsWith("/approve")
        ? "Your introduction is approved and can be shared with authorised employers."
        : path.endsWith("/withdraw")
          ? "Sharing has been withdrawn. Your draft remains private."
          : "Draft saved. Saving an edit keeps it private until you approve it again.");
    } catch (err: any) {
      setError(err?.message ?? "Your changes could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <AppLayout><div className="flex justify-center py-24"><Loader2 className="w-7 h-7 animate-spin text-primary" /></div></AppLayout>;

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Written introduction</h1>
            <Badge variant="outline" className={introduction.status === "approved" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" : ""}>
               {introduction.status === "approved" ? dirty ? "Approved version remains shared" : "Approved for sharing" : introduction.status === "withdrawn" ? "Sharing withdrawn" : "Private draft"}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            You control what authorised employers see. This is separate from your private career activity and is never generated for you.
          </p>
           {dirty && <p className="mt-2 text-sm text-amber-700">You have unsaved changes. They are visible only to you; the currently approved version remains shared until you save or withdraw sharing.</p>}
        </div>

        {error && <div className="flex gap-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
        {message && <div className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700"><CheckCircle2 className="w-4 h-4 shrink-0" />{message}</div>}

        <Card>
          <CardHeader>
            <CardTitle>What employers can read</CardTitle>
            <CardDescription>Use only facts and examples you want to share. Saving changes immediately makes an approved introduction private again.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="intro-summary">Introduction <span className="text-destructive">*</span></Label>
              <Textarea id="intro-summary" maxLength={1200} rows={5} value={introduction.summary} onChange={(e) => update("summary", e.target.value)} placeholder="Briefly introduce your experience and the value you bring." />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between"><Label>Strengths with evidence <span className="text-destructive">*</span></Label><Button type="button" variant="outline" size="sm" onClick={() => update("strengths", [...introduction.strengths, { title: "", evidence: "" }])} disabled={introduction.strengths.length >= 8}><Plus className="mr-1 w-3.5 h-3.5" />Add strength</Button></div>
              {introduction.strengths.map((strength, index) => (
                <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_2fr_auto]">
                  <Input maxLength={100} value={strength.title} placeholder="Strength" onChange={(e) => update("strengths", introduction.strengths.map((s, i) => i === index ? { ...s, title: e.target.value } : s))} />
                  <Input maxLength={500} value={strength.evidence} placeholder="A concise example or outcome" onChange={(e) => update("strengths", introduction.strengths.map((s, i) => i === index ? { ...s, evidence: e.target.value } : s))} />
                  <Button type="button" size="icon" variant="ghost" aria-label="Remove strength" onClick={() => update("strengths", introduction.strengths.filter((_, i) => i !== index))}><Trash2 className="w-4 h-4" /></Button>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between"><Label>Selected achievements</Label><Button type="button" variant="outline" size="sm" onClick={() => update("achievements", [...introduction.achievements, { text: "" }])} disabled={introduction.achievements.length >= 8}><Plus className="mr-1 w-3.5 h-3.5" />Add achievement</Button></div>
              {introduction.achievements.map((achievement, index) => (
                <div className="flex gap-2" key={index}><Input maxLength={500} value={achievement.text} placeholder="An achievement you want to share" onChange={(e) => update("achievements", introduction.achievements.map((a, i) => i === index ? { text: e.target.value } : a))} /><Button type="button" size="icon" variant="ghost" aria-label="Remove achievement" onClick={() => update("achievements", introduction.achievements.filter((_, i) => i !== index))}><Trash2 className="w-4 h-4" /></Button></div>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="direction">Career direction</Label><Textarea id="direction" maxLength={500} value={introduction.careerDirection ?? ""} onChange={(e) => update("careerDirection", e.target.value || null)} placeholder="What kind of work are you seeking?" /></div>
              <div className="space-y-2"><Label htmlFor="preferences">Role preferences</Label><Textarea id="preferences" maxLength={500} value={introduction.rolePreferences ?? ""} onChange={(e) => update("rolePreferences", e.target.value || null)} placeholder="Role, team, work style, or location preferences." /></div>
            </div>
            <div className="space-y-2"><Label htmlFor="availability">Availability</Label><Input id="availability" maxLength={250} value={introduction.availability ?? ""} onChange={(e) => update("availability", e.target.value || null)} placeholder="For example: Available to start in four weeks." /></div>
          </CardContent>
        </Card>

         <Card className="border-primary/20 bg-primary/[0.02]"><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-primary" /><p className="text-sm text-muted-foreground">Approval shares only the written fields above with employers who already have an authorised relationship to you. You can withdraw that access at any time.</p></div><div className="flex shrink-0 gap-2"><Button variant="outline" disabled={saving} onClick={() => action("/portal/introduction", introduction)}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save draft"}</Button>{introduction.status === "approved" ? <Button variant="destructive" disabled={saving} onClick={() => action("/portal/introduction/withdraw")}>Withdraw sharing</Button> : <div className="space-y-1"><Button disabled={saving || !introduction.version || dirty || !!error} onClick={() => action("/portal/introduction/approve", introduction)}>Approve sharing</Button>{dirty && <p className="max-w-40 text-xs text-amber-700">Save your changes before approving.</p>}</div>}</div></CardContent></Card>
      </div>
    </AppLayout>
  );
}