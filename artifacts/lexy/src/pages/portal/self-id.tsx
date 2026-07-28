/**
 * pages/portal/self-id.tsx — Candidate Voluntary Self-Identification
 *
 * ─── Why this page exists, and why it's separate ─────────────────────────────
 * EEO (US) and GDPR Article 9 (EU) both require that protected demographic
 * data be collected on a strictly voluntary basis, decoupled from any
 * screening or hiring decision. So this page:
 *
 *   1. Lives on its own route, after onboarding/screening, never inside the
 *      Lexy interview.
 *   2. Persists into `candidate_demographics` (a separate table that
 *      recruiter UIs never join into the candidate detail view).
 *   3. Shows region-correct disclosure copy supplied by the server
 *      (`/portal/candidate/demographics`), so US tenants see OFCCP-style
 *      EEO boilerplate and EU/UK tenants see GDPR Article 9 explicit
 *      consent.
 *   4. Has a mandatory "I understand and consent" checkbox before save.
 *   5. Lets candidates skip, update, or fully withdraw their disclosure at
 *      any time without affecting any other profile data.
 *
 * The recruiter never sees individual answers — only aggregate, k≥5
 * dashboards via /analytics/diversity.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /portal/self-id
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Brain, ShieldCheck, ArrowRight, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";

type Disclosure = { title: string; body: string; version: string; locale: "eu" | "us" };
type Demographics = {
  gender: string | null;
  genderSelfDescribe: string | null;
  raceEthnicity: string[] | null;
  veteranStatus: string | null;
  disabilityStatus: string | null;
  consentVersion: string;
  consentedAt: string;
};

const GENDER_OPTS = [
  { v: "female",          l: "Female" },
  { v: "male",            l: "Male" },
  { v: "non_binary",      l: "Non-binary" },
  { v: "self_describe",   l: "Prefer to self-describe" },
  { v: "prefer_not_to_say", l: "Prefer not to say" },
];

/* Race/ethnicity options follow the US EEO-1 categories, plus a few common
 * additions used in EU equality monitoring forms. Candidates pick all that
 * apply or "prefer not to say" (which is just leaving everything unchecked
 * and the model maps to NULL server-side). */
const RACE_OPTS = [
  "Hispanic or Latino",
  "White",
  "Black or African descent",
  "Asian",
  "Native American or Alaska Native",
  "Native Hawaiian or Pacific Islander",
  "Middle Eastern or North African",
  "Two or more races",
];

const VET_OPTS = [
  { v: "protected_veteran", l: "I identify as a protected veteran" },
  { v: "not_veteran",       l: "I am not a protected veteran" },
  { v: "prefer_not_to_say", l: "Prefer not to say" },
];

const DIS_OPTS = [
  { v: "yes",               l: "Yes, I have a disability (or previously had one)" },
  { v: "no",                l: "No, I do not have a disability" },
  { v: "prefer_not_to_say", l: "Prefer not to say" },
];

export default function PortalSelfId() {
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [existing, setExisting] = useState<Demographics | null>(null);

  const [gender, setGender] = useState<string | null>(null);
  const [genderSelfDescribe, setGenderSelfDescribe] = useState("");
  const [race, setRace] = useState<string[]>([]);
  const [veteran, setVeteran] = useState<string | null>(null);
  const [disability, setDisability] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    apiFetch(`${apiBase}/portal/candidate/demographics`)
      .then((r) => r.json())
      .then((j) => {
        setDisclosure(j?.disclosure ?? null);
        if (j?.data) {
          setExisting(j.data);
          setGender(j.data.gender ?? null);
          setGenderSelfDescribe(j.data.genderSelfDescribe ?? "");
          setRace(j.data.raceEthnicity ?? []);
          setVeteran(j.data.veteranStatus ?? null);
          setDisability(j.data.disabilityStatus ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggleRace(label: string) {
    setRace((prev) => prev.includes(label) ? prev.filter((r) => r !== label) : [...prev, label]);
  }

  async function save() {
    if (!consented) {
      setError("Please tick the consent box to submit your answers.");
      return;
    }
    setSaving(true); setError(null);
    try {
      const r = await apiFetch(`${apiBase}/portal/candidate/demographics`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gender,
          genderSelfDescribe: gender === "self_describe" ? (genderSelfDescribe.trim() || null) : null,
          raceEthnicity: race.length > 0 ? race : null,
          veteranStatus: veteran,
          disabilityStatus: disability,
          consented: true,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save");
      }
      navigate("/portal/career");
    } catch (err: any) {
      setError(err?.message ?? "Failed to save — please try again.");
    } finally { setSaving(false); }
  }

  async function withdraw() {
    if (!confirm("Remove your voluntary disclosure? This deletes the answers from our database.")) return;
    setSaving(true); setError(null);
    try {
      const r = await apiFetch(`${apiBase}/portal/candidate/demographics`, { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to withdraw");
      setExisting(null);
      setGender(null); setGenderSelfDescribe(""); setRace([]); setVeteran(null); setDisability(null);
      setConsented(false);
    } catch (err: any) {
      setError(err?.message ?? "Failed to withdraw.");
    } finally { setSaving(false); }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <header className="border-b border-border/40 px-6 py-4 flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-to-br from-primary to-cyan-700 rounded-lg flex items-center justify-center shadow-md shadow-primary/30">
          <Brain className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-lg tracking-tight">
          L<span className="text-primary">3</span>XY
        </span>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 py-12">
        <div className="w-full max-w-2xl space-y-8">
          <div className="text-center space-y-3">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto ring-4 ring-primary/20">
              <ShieldCheck className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {disclosure?.title ?? "Voluntary Self-Identification"}
            </h1>
            <p className="text-muted-foreground text-xs uppercase tracking-wider">
              Optional · Not used in hiring decisions
            </p>
          </div>

          {disclosure && (
            <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              {disclosure.body}
            </div>
          )}

          <div className="space-y-6">
            <Section title="Gender">
              {GENDER_OPTS.map((o) => (
                <Radio key={o.v} name="gender" label={o.l} checked={gender === o.v} onChange={() => setGender(o.v)} />
              ))}
              {gender === "self_describe" && (
                <input
                  value={genderSelfDescribe}
                  onChange={(e) => setGenderSelfDescribe(e.target.value)}
                  placeholder="Self-describe"
                  className="w-full mt-2 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              )}
            </Section>

            <Section title="Race / Ethnicity (select all that apply)">
              <div className="grid sm:grid-cols-2 gap-2">
                {RACE_OPTS.map((label) => (
                  <Check key={label} label={label} checked={race.includes(label)} onChange={() => toggleRace(label)} />
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">Leave all unchecked to indicate "prefer not to say".</p>
            </Section>

            <Section title="Veteran status">
              {VET_OPTS.map((o) => (
                <Radio key={o.v} name="vet" label={o.l} checked={veteran === o.v} onChange={() => setVeteran(o.v)} />
              ))}
            </Section>

            <Section title="Disability status">
              {DIS_OPTS.map((o) => (
                <Radio key={o.v} name="dis" label={o.l} checked={disability === o.v} onChange={() => setDisability(o.v)} />
              ))}
            </Section>
          </div>

          <label className="flex items-start gap-2 p-3 rounded-lg border border-border/60 bg-card cursor-pointer">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-sm">
              {disclosure?.locale === "eu"
                ? "I give my explicit consent for L3xy to process the special-category data above for aggregate sourcing-equity reporting only."
                : "I understand my response is voluntary and will be used only in aggregate equal-opportunity reporting, not in individual hiring decisions."}
            </span>
          </label>

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex flex-wrap gap-3">
            {existing && (
              <Button variant="outline" className="gap-2 text-destructive border-destructive/40 hover:bg-destructive/5" onClick={withdraw} disabled={saving}>
                <Trash2 className="w-4 h-4" /> Withdraw disclosure
              </Button>
            )}
            <div className="flex-1 flex gap-3 justify-end">
              <Button variant="outline" onClick={() => navigate("/portal/career")} disabled={saving}>
                Skip for now
              </Button>
              <Button className="gap-2" onClick={save} disabled={saving || !consented}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Save <ArrowRight className="w-4 h-4" /></>}
              </Button>
            </div>
          </div>

          {existing && (
            <p className="text-center text-xs text-muted-foreground/60">
              You previously submitted on {new Date(existing.consentedAt).toLocaleDateString()}. You can update or withdraw at any time.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border/60 rounded-2xl p-5 bg-card space-y-2">
      <div className="text-sm font-semibold">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Radio({ name, label, checked, onChange }: { name: string; label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer py-1">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer py-1">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
