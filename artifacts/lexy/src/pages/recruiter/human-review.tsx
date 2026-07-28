/**
 * HumanReview.tsx — Recruiter "Pending Human Review" queue.
 *
 * Surfaces every application whose AI recommendation is awaiting human
 * confirmation (applications.ai_recommendation IS NOT NULL AND
 * final_decision IS NULL). The recruiter confirms or overrides with a
 * structured rationale + standardised attestation text.
 *
 * Backed by:
 *   GET  /api/applications/pending-human-review
 *   POST /api/applications/:id/human-decision
 *
 * Bulk action (pragmatic): the recruiter can select multiple rows and
 * apply the same decision + attestation in one click. The backend
 * logs each row individually so per-application audit fidelity is
 * preserved.
 *
 * Attestation copy is deliberately the design-spec wording — auditors
 * will read this text verbatim in discovery.
 */
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";

const ATTESTATION_TEXT =
  "I reviewed the AI recommendations and role-relevant candidate information before confirming this action.";

const REASON_OPTIONS: { value: string; label: string }[] = [
  { value: "insufficient_experience", label: "Insufficient experience" },
  { value: "role_mismatch", label: "Role mismatch" },
  { value: "compensation_mismatch", label: "Compensation mismatch" },
  { value: "location_mismatch", label: "Location mismatch" },
  { value: "no_response", label: "No response" },
  { value: "duplicate_candidate", label: "Duplicate candidate" },
  { value: "failed_assessment", label: "Failed assessment" },
  { value: "withdrew", label: "Withdrew" },
  { value: "stronger_candidate_selected", label: "Stronger candidate selected" },
  { value: "other", label: "Other (notes)" },
];

interface PendingRow {
  applicationId: string;
  tenantId: string;
  aiRecommendation: "advance" | "reject" | "hold" | "lapsed" | "flag_fraud" | "no_recommendation" | null;
  aiRecommendationAt: string | null;
  aiRecommendationModel: string | null;
  aiRecommendationScore: number | null;
  gatedByJurisdiction: string[];
  policyVersionId: string | null;
  stage: string;
  candidate: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    location: string | null;
  };
  job: {
    id: string;
    title: string | null;
    location: string | null;
  };
}

const AI_TO_HUMAN_DEFAULT: Record<string, string> = {
  reject: "human_reject",
  hold: "human_hold",
  lapsed: "human_lapsed",
  advance: "human_advance",
  flag_fraud: "human_hold",
};

export default function HumanReview() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reasonCode, setReasonCode] = useState<string>("");
  const [reasonNotes, setReasonNotes] = useState<string>("");
  const [attestationChecked, setAttestationChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await apiFetch(`${apiBase}/applications/pending-human-review`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: PendingRow[] = await r.json();
      setRows(data);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /**
   * Submit a decision (confirm AI recommendation or override).
   * `actionKind` is either "confirm" (use AI's recommendation as the
   * human counterpart) or one of the override values.
   */
  async function submitDecision(actionKind: "confirm" | "human_reject" | "human_advance" | "human_hold") {
    if (selected.size === 0) return;
    if (!attestationChecked) {
      setErr("You must check the attestation before recording a decision.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    const ids = [...selected];
    const results = await Promise.allSettled(ids.map(async (id) => {
      const row = rows.find((r) => r.applicationId === id);
      if (!row) return;
      const finalDecision =
        actionKind === "confirm"
          ? AI_TO_HUMAN_DEFAULT[row.aiRecommendation ?? ""] ?? "human_hold"
          : actionKind;
      const r = await apiFetch(`${apiBase}/applications/${id}/human-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finalDecision,
          attestation: ATTESTATION_TEXT,
          reasonCode: reasonCode || undefined,
          reasonNotes: reasonNotes || undefined,
        }),
      });
      if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
    }));
    const failed = results.filter((r) => r.status === "rejected");
    setSubmitting(false);
    if (failed.length > 0) {
      setErr(`${failed.length} of ${ids.length} updates failed. Reload to retry.`);
    }
    setSelected(new Set());
    setAttestationChecked(false);
    setReasonCode("");
    setReasonNotes("");
    await load();
  }

  return (
    <AppLayout>
      <div className="container mx-auto py-8 space-y-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-emerald-600" />
          <div>
            <h1 className="page-title">Pending Human Review</h1>
            <p className="text-sm text-muted-foreground">
              AI recommendations that require human confirmation before any final decision is recorded.
              Gated under NYC LL144, CO SB24-205, IL HRA / AIVI, and EU AI Act.
            </p>
          </div>
        </div>

        {err && (
          <Card className="border-red-300 bg-red-50">
            <CardContent className="flex items-start gap-2 pt-4 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 mt-0.5" />
              <span>{err}</span>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Decision controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label className="mb-2 block">Rationale (structured)</Label>
                <Select value={reasonCode} onValueChange={setReasonCode}>
                  <SelectTrigger><SelectValue placeholder="Select a reason…" /></SelectTrigger>
                  <SelectContent>
                    {REASON_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="notes" className="mb-2 block">Notes (optional)</Label>
                <Textarea
                  id="notes"
                  rows={2}
                  placeholder="Additional context…"
                  value={reasonNotes}
                  onChange={(e) => setReasonNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-md border bg-slate-50 p-3">
              <Checkbox
                id="attest"
                checked={attestationChecked}
                onCheckedChange={(c) => setAttestationChecked(c === true)}
              />
              <Label htmlFor="attest" className="text-sm font-normal leading-snug">
                {ATTESTATION_TEXT}
              </Label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={submitting || selected.size === 0 || !attestationChecked}
                onClick={() => submitDecision("confirm")}
              >
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Confirm AI recommendation ({selected.size})
              </Button>
              <Button
                variant="outline"
                disabled={submitting || selected.size === 0 || !attestationChecked}
                onClick={() => submitDecision("human_advance")}
              >
                Override → Advance
              </Button>
              <Button
                variant="outline"
                disabled={submitting || selected.size === 0 || !attestationChecked}
                onClick={() => submitDecision("human_hold")}
              >
                Override → Hold
              </Button>
              <Button
                variant="destructive"
                disabled={submitting || selected.size === 0 || !attestationChecked}
                onClick={() => submitDecision("human_reject")}
              >
                Override → Reject
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue ({rows.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No applications are awaiting human review.</p>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => {
                  const fullName = [r.candidate.firstName, r.candidate.lastName].filter(Boolean).join(" ") || r.candidate.email || "(unknown)";
                  const isChecked = selected.has(r.applicationId);
                  return (
                    <div
                      key={r.applicationId}
                      className="flex items-start gap-3 rounded-md border p-3 hover:bg-slate-50"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggle(r.applicationId)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{fullName}</span>
                          <Badge variant="outline" className="text-xs">{r.job.title ?? "Unknown role"}</Badge>
                          <Badge variant="secondary" className="text-xs uppercase">
                            AI: {r.aiRecommendation ?? "—"}
                          </Badge>
                          {r.gatedByJurisdiction.map((j) => (
                            <Badge key={j} variant="outline" className="text-xs text-amber-700 border-amber-300 bg-amber-50">
                              {j}
                            </Badge>
                          ))}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 flex gap-3 flex-wrap">
                          {r.aiRecommendationModel && <span>Model: {r.aiRecommendationModel}</span>}
                          {r.aiRecommendationScore != null && <span>Score: {r.aiRecommendationScore.toFixed(2)}</span>}
                          {r.aiRecommendationAt && <span>{new Date(r.aiRecommendationAt).toLocaleString()}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
