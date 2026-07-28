/**
 * pages/portal/deletion-request.tsx — Right-to-Erasure Request
 *
 * Candidate-fronted form to request deletion of their data under:
 *   • Illinois AI Video Interview Act (30-day deletion right)
 *   • GDPR Article 17 (right to erasure, EU/UK candidates)
 *   • CCPA / CPRA (California residents)
 *
 * Submits to POST /portal/candidate/deletion-request. The request lands
 * in the deletion_requests queue. Platform_admin reviews and fulfils via
 * /admin/deletion-requests; the candidate receives a confirmation email
 * once the request is fulfilled.
 *
 * Runbook: docs/RUNBOOK_DATA_DELETION.md.
 */
import { useEffect, useState } from "react";
import { Trash2, ShieldAlert, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";
import { BackToHome } from "@/components/layout/BackToHome";

const JURISDICTIONS: Array<{ v: "il_aivi" | "gdpr" | "ccpa" | "other"; l: string; clock: string }> = [
  { v: "il_aivi", l: "Illinois AI Video Interview Act — interview content", clock: "30-day clock" },
  { v: "gdpr",    l: "GDPR / UK GDPR (EU or UK resident)",                  clock: "30-day clock (extendable)" },
  { v: "ccpa",    l: "CCPA / CPRA (California resident)",                   clock: "45-day clock (extendable)" },
  { v: "other",   l: "Other — please describe in the reason field",        clock: "30-day default" },
];

interface ExistingRequest { id: string; status: string; jurisdiction: string; createdAt: string; handledAt: string | null; }

export default function DeletionRequest() {
  const [jurisdiction, setJurisdiction] = useState<"il_aivi" | "gdpr" | "ccpa" | "other">("gdpr");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [existing, setExisting] = useState<ExistingRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`${apiBase}/portal/candidate/deletion-request`)
      .then((r) => r.json()).then((j) => setExisting(j.data ?? []))
      .catch(() => { /* tolerate */ });
  }, []);

  const submit = async () => {
    if (!confirmed) return;
    setSaving(true); setError(null);
    try {
      const r = await apiFetch(`${apiBase}/portal/candidate/deletion-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jurisdiction, reason: reason || undefined }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || "Could not submit");
    } finally { setSaving(false); }
  };

  return (
    <div className="min-h-screen text-foreground py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <BackToHome to="/portal/career" />
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500">
            <Trash2 className="w-5 h-5" />
          </div>
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Privacy rights</span>
        </div>
        <h1 className="text-3xl font-bold mb-2">Request deletion of your data</h1>
        <p className="text-sm text-muted-foreground mb-8">
          We'll review your request and confirm by email within the statutory window for your jurisdiction.
        </p>

        {existing.length > 0 && (
          <div className="mb-8 border border-border rounded-2xl p-4">
            <h2 className="text-sm font-semibold mb-3">Your previous requests</h2>
            <ul className="space-y-2 text-sm">
              {existing.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-muted-foreground">
                  <span>{new Date(r.createdAt).toLocaleDateString()} — {r.jurisdiction}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    r.status === "fulfilled" ? "bg-green-500/10 text-green-500" :
                    r.status === "denied" ? "bg-red-500/10 text-red-500" :
                    "bg-amber-500/10 text-amber-500"
                  }`}>{r.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {submitted ? (
          <div className="border border-green-500/20 bg-green-500/5 rounded-2xl p-6 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-semibold mb-1">Request submitted</h2>
              <p className="text-sm text-muted-foreground">
                We'll email you to confirm once your data has been deleted. If we need to verify your identity first,
                we'll be in touch by email.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <label className="text-sm font-medium block mb-2">Which law are you invoking?</label>
              <div className="space-y-2">
                {JURISDICTIONS.map((j) => (
                  <label key={j.v} className="flex items-start gap-3 cursor-pointer p-3 border border-border rounded-xl hover:bg-muted/40">
                    <input
                      type="radio"
                      name="jur"
                      value={j.v}
                      checked={jurisdiction === j.v}
                      onChange={() => setJurisdiction(j.v)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm font-medium">{j.l}</div>
                      <div className="text-xs text-muted-foreground">{j.clock}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium block mb-2">Reason (optional)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={2000}
                className="w-full p-3 rounded-xl border border-border bg-background text-sm"
                placeholder="Tell us anything that will help us process your request."
              />
            </div>

            <div className="border border-amber-500/20 bg-amber-500/5 rounded-xl p-4 flex items-start gap-3">
              <ShieldAlert className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="text-sm">
                <strong>This is irreversible.</strong> We will delete your candidate profile, resume,
                interview recordings and transcripts, and any voluntary demographic information you provided.
                We retain an immutable audit log entry (without personal data) for legal-hold purposes.
              </div>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1 w-4 h-4 rounded border-border"
              />
              <span className="text-sm">I understand this is permanent and I want to proceed.</span>
            </label>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <Button onClick={submit} disabled={!confirmed || saving} variant="destructive">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit deletion request"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
