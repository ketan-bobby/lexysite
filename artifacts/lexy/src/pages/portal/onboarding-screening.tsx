/**
 * pages/portal/onboarding-screening.tsx — Candidate Onboarding: Work Authorization
 *
 * ─── Why this step exists ────────────────────────────────────────────────────
 * Recruiters consistently need two screening data points up front:
 *   1. Are you legally authorized to work in the role's country?
 *   2. Will you need visa sponsorship now or in the future?
 *
 * These are SCREENING fields — job-relevant filters, not protected
 * demographics — so they belong on the candidate's main profile (visible to
 * recruiters) and are collected here during onboarding. Voluntary
 * self-identification (race, gender, etc.) lives on a completely separate
 * page (/portal/self-id) with separate consent and is NEVER asked here.
 *
 * ─── Flow position ───────────────────────────────────────────────────────────
 *   /portal/onboarding/resume → /portal/onboarding/screening → /portal/career
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /portal/onboarding/screening
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Brain, Briefcase, ArrowRight, Loader2, ShieldCheck, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";

type Screening = {
  workAuthorized: boolean | null;
  requiresSponsorship: boolean | null;
  sponsorshipCountry: string | null;
  sponsorshipNotes: string | null;
  screeningCompletedAt: string | null;
};

export default function OnboardingScreening() {
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workAuthorized, setWorkAuthorized] = useState<boolean | null>(null);
  const [requiresSponsorship, setRequiresSponsorship] = useState<boolean | null>(null);
  const [sponsorshipCountry, setSponsorshipCountry] = useState("");
  const [sponsorshipNotes, setSponsorshipNotes] = useState("");

  useEffect(() => {
    apiFetch(`${apiBase}/portal/candidate/screening`)
      .then((r) => r.json())
      .then((j) => {
        const d: Screening | undefined = j?.data;
        if (d) {
          setWorkAuthorized(d.workAuthorized);
          setRequiresSponsorship(d.requiresSponsorship);
          setSponsorshipCountry(d.sponsorshipCountry ?? "");
          setSponsorshipNotes(d.sponsorshipNotes ?? "");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save(andContinue: boolean) {
    if (workAuthorized === null || requiresSponsorship === null) {
      setError("Please answer both questions before continuing.");
      return;
    }
    setSaving(true); setError(null);
    try {
      const res = await apiFetch(`${apiBase}/portal/candidate/screening`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workAuthorized,
          requiresSponsorship,
          sponsorshipCountry: sponsorshipCountry.trim() || null,
          sponsorshipNotes: sponsorshipNotes.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save");
      }
      if (andContinue) navigate("/portal/self-id");
    } catch (err: any) {
      setError(err?.message ?? "Failed to save — please try again.");
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
        <div className="w-full max-w-xl space-y-8">
          <div className="text-center space-y-3">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto ring-4 ring-primary/20">
              <Briefcase className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Work authorization</h1>
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              Recruiters need these two answers to know whether you're a fit for a given role. We'll show this on your profile.
            </p>
          </div>

          <div className="border border-border/60 rounded-2xl p-6 space-y-6 bg-card">
            <div className="space-y-3">
              <div className="text-sm font-medium flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                Are you legally authorized to work in the country where you're seeking employment?
              </div>
              <div className="grid grid-cols-2 gap-2">
                <YesNoButton selected={workAuthorized === true}  onClick={() => setWorkAuthorized(true)}  label="Yes" />
                <YesNoButton selected={workAuthorized === false} onClick={() => setWorkAuthorized(false)} label="No" />
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-sm font-medium flex items-center gap-2">
                <Globe2 className="w-4 h-4 text-muted-foreground" />
                Will you now or in the future require sponsorship for employment visa status?
              </div>
              <div className="grid grid-cols-2 gap-2">
                <YesNoButton selected={requiresSponsorship === true}  onClick={() => setRequiresSponsorship(true)}  label="Yes" />
                <YesNoButton selected={requiresSponsorship === false} onClick={() => setRequiresSponsorship(false)} label="No" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">Country (optional)</label>
              <input
                value={sponsorshipCountry}
                onChange={(e) => setSponsorshipCountry(e.target.value)}
                placeholder="e.g. United States, United Kingdom"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">Notes (optional)</label>
              <textarea
                value={sponsorshipNotes}
                onChange={(e) => setSponsorshipNotes(e.target.value)}
                placeholder="e.g. H-1B transfer required; OPT expires Jan 2027"
                rows={3}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
              />
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1 h-12"
              onClick={() => navigate("/portal/self-id")}
              disabled={saving}
            >
              Skip for now
            </Button>
            <Button
              className="flex-1 h-12 gap-2"
              onClick={() => save(true)}
              disabled={saving}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Save and continue <ArrowRight className="w-4 h-4" /></>}
            </Button>
          </div>

          <p className="text-center text-xs text-muted-foreground/60">
            You can update these answers anytime from your Career Hub.
          </p>
        </div>
      </main>
    </div>
  );
}

function YesNoButton({ selected, onClick, label }: { selected: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 rounded-lg border text-sm font-medium transition-all ${
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background hover:border-primary/40"
      }`}
    >
      {label}
    </button>
  );
}
