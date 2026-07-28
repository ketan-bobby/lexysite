/**
 * pages/recruiter/appeals.tsx — Admin Appeal Queue (T011b)
 *
 * Surfaces every open appeal across the tenants the caller can see
 * (platform_admin sees all). Backed by:
 *
 *   GET  /api/appeals?include=open|all
 *   POST /api/appeals/:appealId/resolve  { outcome, attestation, notes? }
 *
 * SLA badge is computed server-side (slaStatus) so multiple reviewers
 * see the same colour. On "reverse" the resolver also requires picking
 * the post-reversal final_decision so the underlying application's
 * audit trail flips correctly via applyHumanDecision.
 */
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Gavel, AlertTriangle } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";

const ATTESTATION_TEXT =
  "I reviewed the underlying application record and the original AI recommendation before resolving this appeal.";

type SlaStatus = "on_track" | "warning" | "breached" | "resolved" | "no_sla_recorded";

interface AppealRow {
  id: string;
  tenantId: string;
  applicationId: string;
  candidateId: string | null;
  requestedBy: string;
  reason: string | null;
  status: string;
  outcome: string | null;
  reviewerUserId: string | null;
  reviewerAttestation: string | null;
  outcomeNotes: string | null;
  createdAt: string;
  resolvedAt: string | null;
  slaDueAt: string | null;
  candidateNotifiedAt: string | null;
  slaStatus: SlaStatus;
}

const OUTCOME_OPTIONS = [
  { value: "upheld", label: "Uphold original decision" },
  { value: "reversed", label: "Reverse decision (advance candidate)" },
  { value: "withdrawn", label: "Mark withdrawn by candidate" },
  { value: "duplicate", label: "Duplicate appeal" },
  { value: "out_of_scope", label: "Out of scope (not an AI decision)" },
] as const;

const REVERSE_TARGETS = [
  { value: "human_advance", label: "Advance to next stage" },
  { value: "human_hold", label: "Hold for further review" },
  { value: "human_hired", label: "Hired" },
  { value: "human_offer", label: "Offer extended" },
] as const;

interface OversightMetrics {
  days: number;
  reviewed: number;
  overridden: number;
  humanDecisions: number;
  deviationRate: number | null;
  appealsRequested: number;
  appealsCompleted: number;
  rubberStampAlert: boolean;
}

const SLA_BADGE: Record<SlaStatus, { label: string; className: string }> = {
  on_track:           { label: "On track",   className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
  warning:            { label: "Due soon",   className: "bg-amber-500/10  text-amber-300  border-amber-500/30" },
  breached:           { label: "SLA breach", className: "bg-rose-500/10   text-rose-300   border-rose-500/30" },
  resolved:           { label: "Resolved",   className: "bg-slate-500/10  text-slate-300  border-slate-500/30" },
  no_sla_recorded:    { label: "No SLA",     className: "bg-slate-500/10  text-slate-300  border-slate-500/30" },
};

export default function Appeals() {
  const [rows, setRows] = useState<AppealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeAll, setIncludeAll] = useState(false);
  const [metrics, setMetrics] = useState<OversightMetrics | null>(null);

  useEffect(() => {
    apiFetch(`${apiBase}/governance/oversight-metrics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setMetrics(m); })
      .catch(() => {});
  }, []);

  /* Per-row resolver state. Keyed by appeal id so a reviewer can
   * triage several without losing draft text. */
  const [draftOutcome, setDraftOutcome] = useState<Record<string, string>>({});
  const [draftReverseTarget, setDraftReverseTarget] = useState<Record<string, string>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAppeals = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `${apiBase}/appeals${includeAll ? "?include=all" : ""}`;
      const r = await apiFetch(url);
      if (!r.ok) throw new Error(`Failed to load appeals (HTTP ${r.status})`);
      setRows(await r.json());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load appeals");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchAppeals(); }, [includeAll]);

  const submit = async (appealId: string) => {
    const outcome = draftOutcome[appealId];
    if (!outcome) { setError("Pick an outcome before resolving"); return; }
    setSubmittingId(appealId);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        outcome,
        attestation: ATTESTATION_TEXT,
        notes: draftNotes[appealId] || undefined,
      };
      if (outcome === "reversed") {
        body.reverseToFinalDecision = draftReverseTarget[appealId] || "human_advance";
      }
      const r = await apiFetch(`${apiBase}/appeals/${appealId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(msg || `HTTP ${r.status}`);
      }
      await fetchAppeals();
    } catch (err: any) {
      setError(err?.message ?? "Failed to resolve appeal");
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-widest">
              <Gavel className="w-3.5 h-3.5" /> Appeals queue
            </div>
            <h1 className="page-title mt-1">Right-to-appeal review</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Candidates may appeal AI-assisted screening decisions under CO SB24-205, IL AIVI, and several
              other jurisdictions. Each appeal is logged immutably; resolution requires an attestation and
              flips the application's final decision when the appeal is reversed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={includeAll ? "default" : "outline"}
              size="sm"
              onClick={() => setIncludeAll((v) => !v)}
              data-testid="toggle-include-resolved"
            >
              {includeAll ? "Showing all" : "Showing open"}
            </Button>
            <Button variant="outline" size="sm" onClick={fetchAppeals} disabled={loading}>
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refresh"}
            </Button>
          </div>
        </header>

        {/* ── Human-oversight effectiveness panel (EU AI Act Art. 14) ── */}
        {metrics && (
          <Card data-testid="oversight-metrics">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Human oversight — last {metrics.days} days</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                <div>
                  <div className="text-2xl font-semibold">{metrics.humanDecisions}</div>
                  <div className="text-xs text-muted-foreground">Human decisions</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{metrics.reviewed}</div>
                  <div className="text-xs text-muted-foreground">AI confirmed</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{metrics.overridden}</div>
                  <div className="text-xs text-muted-foreground">AI overridden</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">
                    {metrics.deviationRate == null ? "—" : `${(metrics.deviationRate * 100).toFixed(1)}%`}
                  </div>
                  <div className="text-xs text-muted-foreground">Deviation rate</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{metrics.appealsRequested}</div>
                  <div className="text-xs text-muted-foreground">Appeals filed</div>
                </div>
              </div>
              {metrics.rubberStampAlert && (
                <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    Reviewers have disagreed with the AI in under 2% of {metrics.humanDecisions} recent
                    decisions. Regulators may treat this as rubber-stamping — remind reviewers that
                    genuine, independent review of each AI recommendation is required (EU AI Act Art. 14).
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : rows.length === 0 ? (
          <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No appeals to review.</CardContent></Card>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const badge = SLA_BADGE[r.slaStatus] ?? SLA_BADGE.no_sla_recorded;
              const isResolved = !!r.resolvedAt;
              const outcomeDraft = draftOutcome[r.id] ?? "";
              return (
                <Card key={r.id} data-testid={`appeal-${r.id}`}>
                  <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm font-mono break-all">{r.applicationId}</CardTitle>
                      <div className="text-xs text-muted-foreground mt-1">
                        Filed {new Date(r.createdAt).toLocaleString()} · tenant {r.tenantId}
                        {r.slaDueAt ? ` · SLA due ${new Date(r.slaDueAt).toLocaleDateString()}` : ""}
                      </div>
                    </div>
                    <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {r.reason ? (
                      <div>
                        <Label className="text-xs">Candidate's reason</Label>
                        <div className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">{r.reason}</div>
                      </div>
                    ) : null}

                    {isResolved ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <Badge variant="outline">{r.outcome ?? r.status}</Badge>
                          <span className="text-muted-foreground">Resolved {r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : ""}</span>
                          {r.candidateNotifiedAt ? <span className="text-emerald-300">Candidate notified</span> : <span className="text-amber-300">Candidate not notified</span>}
                        </div>
                        {r.outcomeNotes ? (
                          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">{r.outcomeNotes}</div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs">Outcome</Label>
                          <Select value={outcomeDraft} onValueChange={(v) => setDraftOutcome((s) => ({ ...s, [r.id]: v }))}>
                            <SelectTrigger className="mt-1"><SelectValue placeholder="Select outcome…" /></SelectTrigger>
                            <SelectContent>
                              {OUTCOME_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        {outcomeDraft === "reversed" ? (
                          <div>
                            <Label className="text-xs">Flip final decision to</Label>
                            <Select value={draftReverseTarget[r.id] ?? "human_advance"} onValueChange={(v) => setDraftReverseTarget((s) => ({ ...s, [r.id]: v }))}>
                              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {REVERSE_TARGETS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : null}
                        <div className="md:col-span-2">
                          <Label className="text-xs">Notes for the candidate (optional)</Label>
                          <Textarea
                            rows={3}
                            className="mt-1"
                            placeholder="Plain-language explanation. This text is included in the email to the candidate."
                            value={draftNotes[r.id] ?? ""}
                            onChange={(e) => setDraftNotes((s) => ({ ...s, [r.id]: e.target.value }))}
                          />
                        </div>
                        <div className="md:col-span-2 text-xs text-muted-foreground italic">
                          Resolving an appeal records this attestation: "{ATTESTATION_TEXT}"
                        </div>
                        <div className="md:col-span-2 flex justify-end">
                          <Button
                            size="sm"
                            disabled={!outcomeDraft || submittingId === r.id}
                            onClick={() => submit(r.id)}
                            data-testid={`resolve-${r.id}`}
                          >
                            {submittingId === r.id ? <Loader2 className="w-3 h-3 animate-spin mr-2" /> : null}
                            Resolve appeal
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
