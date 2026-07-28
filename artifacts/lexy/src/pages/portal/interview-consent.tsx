/**
 * pages/portal/interview-consent.tsx — AI Interview Consent
 *
 * Required pre-interview disclosure + consent step under:
 *   • Illinois AI Video Interview Act (820 ILCS 42)
 *   • EU AI Act Article 26(11) (deployer information)
 *   • NYC Local Law 144 (candidate notice)
 *
 * The /interviews/:id/begin endpoint refuses to mint a session until the
 * candidate has an active consent row for the current version (returns
 * 412 AI_CONSENT_REQUIRED). The interview entry point redirects here
 * when it sees that code.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Brain, Loader2, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";

interface Disclosure {
  version: string;
  intendedUse: string;
  modelProviders: string[];
  evaluatedTraits: string[];
  notEvaluated: string[];
  decisionMaker: string;
  candidateRights: string[];
  retention: string;
  biometric: {
    identifiersCollected: string[];
    purpose: string;
    retentionSchedule: string;
    notSoldOrShared: string;
  };
}

export default function InterviewConsent() {
  const [, navigate] = useLocation();
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [active, setActive] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [bioAgreed, setBioAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const returnTo = (() => {
    if (typeof window === "undefined") return "/portal/career";
    const p = new URLSearchParams(window.location.search);
    return p.get("returnTo") || "/portal/career";
  })();

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${apiBase}/portal/candidate/ai-consent`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setDisclosure(j.disclosure);
        setActive(!!j.active);
        setLoading(false);
      })
      .catch((e) => { if (!cancelled) { setError(e?.message || "Failed to load"); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (!agreed || !bioAgreed) return;
    setSaving(true);
    setError(null);
    try {
      const r = await apiFetch(`${apiBase}/portal/candidate/ai-consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, biometricConsent: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      navigate(returnTo);
    } catch (e: any) {
      setError(e?.message || "Could not save");
      setSaving(false);
    }
  };

  const decline = () => navigate("/portal/career");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen text-foreground py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <Brain className="w-5 h-5" />
          </div>
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Before we begin</span>
        </div>
        <h1 className="text-3xl font-bold mb-2">AI interview — what to expect</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Required by Illinois law and applicable in other regions. Take a moment to read this — your consent is voluntary.
        </p>

        {active && (
          <div className="mb-6 p-4 rounded-xl border border-primary/20 bg-primary/5 text-sm flex items-start gap-3">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <span>You've already consented to the current version. You can re-confirm below or proceed to your interview.</span>
          </div>
        )}

        {disclosure && (
          <div className="space-y-6 text-sm">
            <Section title="What this is">
              <p className="text-muted-foreground leading-relaxed">{disclosure.intendedUse}</p>
            </Section>

            <Section title="Who decides">
              <p className="text-muted-foreground leading-relaxed">
                A <strong>human recruiter</strong> at the company you're interviewing with reviews the
                AI summary and makes the hiring decision. Lexy does not auto-reject or auto-hire.
              </p>
              <p className="text-muted-foreground leading-relaxed mt-2">
                If you believe a decision about your application was wrong, you can{" "}
                <strong>request a human review at any time</strong> — use the
                &ldquo;Request human review&rdquo; option on the application in{" "}
                <a href="/portal/applications" className="text-primary underline">My Applications</a>.
                A human reviewer will re-examine the decision and respond to you by email.
              </p>
            </Section>

            <Section title="What Lexy evaluates">
              <ul className="space-y-1.5">
                {disclosure.evaluatedTraits.map((t, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground"><span className="text-primary">•</span><span>{t}</span></li>
                ))}
              </ul>
            </Section>

            <Section title="What Lexy does NOT evaluate or infer">
              <ul className="space-y-1.5">
                {disclosure.notEvaluated.map((t, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground"><span className="text-red-500">✕</span><span>{t}</span></li>
                ))}
              </ul>
            </Section>

            <Section title="AI providers we use">
              <p className="text-muted-foreground">{disclosure.modelProviders.join(", ")}. None of these providers train on your data.</p>
            </Section>

            <Section title="Your rights">
              <ul className="space-y-1.5">
                {disclosure.candidateRights.map((t, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground"><span className="text-primary">•</span><span>{t}</span></li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-2">
                To request deletion of your interview recording or all your data,
                visit <a href="/portal/deletion-request" className="text-primary underline">Request deletion</a>.
              </p>
            </Section>

            <Section title="Retention">
              <p className="text-muted-foreground leading-relaxed">{disclosure.retention}</p>
            </Section>

            <Section title="Biometric data — webcam proctoring & recording">
              <p className="text-muted-foreground leading-relaxed mb-2">
                This interview is proctored and recorded. To do that, Lexy collects the following
                biometric identifiers and biometric information:
              </p>
              <ul className="space-y-1.5 mb-3">
                {disclosure.biometric.identifiersCollected.map((t, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground"><span className="text-primary">•</span><span>{t}</span></li>
                ))}
              </ul>
              <p className="text-muted-foreground leading-relaxed mb-2">{disclosure.biometric.purpose}</p>
              <p className="text-muted-foreground leading-relaxed mb-2">
                <strong className="text-foreground">Retention &amp; destruction schedule:</strong>{" "}
                {disclosure.biometric.retentionSchedule}
              </p>
              <p className="text-muted-foreground leading-relaxed">{disclosure.biometric.notSoldOrShared}</p>
            </Section>

            <div className="border-t border-border pt-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded border-border"
                />
                <span className="text-sm">
                  I have read the information above and consent to participating in an AI-conducted interview
                  on the terms described. I understand my consent is voluntary and I may withdraw it at any time.
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer mt-4">
                <input
                  type="checkbox"
                  checked={bioAgreed}
                  onChange={(e) => setBioAgreed(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded border-border"
                />
                <span className="text-sm">
                  I separately authorise Lexy to collect, store, and use my biometric identifiers and biometric
                  information (facial geometry, gaze, voice, and the interview recording) for the purposes and on
                  the retention/destruction schedule described above. I understand this authorisation is voluntary
                  and I may withdraw it at any time.
                </span>
              </label>

              {error && <p className="text-sm text-red-500 mt-3">{error}</p>}

              <div className="flex items-center gap-3 mt-6">
                <Button onClick={submit} disabled={!agreed || !bioAgreed || saving}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "I consent — continue"}
                </Button>
                <button onClick={decline} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
                  <X className="w-3.5 h-3.5" /> Decline and exit
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Consent version: {disclosure.version}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold mb-2">{title}</h2>
      {children}
    </section>
  );
}
