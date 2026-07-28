/**
 * pages/admin/deletion-requests.tsx — Platform-admin right-to-erasure queue
 *
 * Reviews candidate-submitted deletion requests (via
 * POST /portal/candidate/deletion-request). Admin can fulfil (hard-delete
 * candidate + cascade + audit row) or deny (with required notes for the
 * audit trail).
 *
 * Runbook: docs/RUNBOOK_DATA_DELETION.md.
 */
import { useEffect, useState } from "react";
import { Trash2, Loader2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";
import { BackToHome } from "@/components/layout/BackToHome";

interface Request {
  id: string;
  candidateId: string;
  candidateEmailSnapshot: string | null;
  jurisdiction: string;
  status: string;
  reason: string | null;
  handlerNotes: string | null;
  handledAt: string | null;
  createdAt: string;
  /* Server-computed GDPR Art. 12(3) SLA fields. */
  slaDueAt?: string;
  slaStatus?: "on_track" | "warning" | "breached" | "resolved";
}

const JURISDICTION_CLOCK_DAYS: Record<string, number> = {
  il_aivi: 30, gdpr: 30, ccpa: 45, other: 30,
};

export default function AdminDeletionRequests() {
  const [rows, setRows] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"" | "pending" | "fulfilled" | "denied">("pending");
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    apiFetch(`${apiBase}/admin/deletion-requests${filter ? `?status=${filter}` : ""}`)
      .then((r) => r.json()).then((j) => { setRows(j.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(load, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const fulfil = async (id: string) => {
    if (!confirm("Permanently delete this candidate and all linked data? This cannot be undone.")) return;
    const notes = prompt("Optional notes for the audit trail:") ?? "";
    setBusy(id);
    try {
      const r = await apiFetch(`${apiBase}/admin/deletion-requests/${id}/fulfil`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handlerNotes: notes || undefined }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      load();
    } catch (e: any) { alert(`Failed: ${e?.message}`); }
    finally { setBusy(null); }
  };

  const deny = async (id: string) => {
    const notes = prompt("Reason for denial (required, captured in audit trail):");
    if (!notes) return;
    setBusy(id);
    try {
      await apiFetch(`${apiBase}/admin/deletion-requests/${id}/deny`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handlerNotes: notes }),
      });
      load();
    } catch (e: any) { alert(`Failed: ${e?.message}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="min-h-screen text-foreground py-10 px-6">
      <div className="max-w-5xl mx-auto">
        <BackToHome to="/platform" />
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500">
                <Trash2 className="w-4 h-4" />
              </div>
              <h1 className="text-2xl font-bold">Right-to-erasure queue</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              See <code>docs/RUNBOOK_DATA_DELETION.md</code> before fulfilling. Statutory clocks shown per row.
            </p>
          </div>
          <button onClick={load} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className="flex gap-2 mb-6">
          {(["pending", "fulfilled", "denied", ""] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                filter === s
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {s || "all"}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No requests in this view.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const clockDays = JURISDICTION_CLOCK_DAYS[r.jurisdiction] ?? 30;
              const created = new Date(r.createdAt);
              /* Prefer the server-computed SLA clock; fall back to the local
               * jurisdiction table for older API responses. */
              const due = r.slaDueAt
                ? new Date(r.slaDueAt)
                : new Date(created.getTime() + clockDays * 24 * 60 * 60 * 1000);
              const overdue = r.slaStatus
                ? r.slaStatus === "breached"
                : Date.now() > due.getTime() && r.status === "pending";
              const dueSoon = r.slaStatus === "warning";
              return (
                <div key={r.id} className="border border-border rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{r.candidateEmailSnapshot ?? "(no email)"}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full border border-border">{r.jurisdiction}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          r.status === "fulfilled" ? "bg-green-500/10 text-green-500" :
                          r.status === "denied" ? "bg-red-500/10 text-red-500" :
                          overdue ? "bg-red-500/10 text-red-500" : "bg-amber-500/10 text-amber-500"
                        }`}>{overdue ? "SLA BREACHED" : dueSoon ? `${r.status} — due soon` : r.status}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Submitted {created.toLocaleString()} · Due {due.toLocaleDateString()} ({clockDays}-day clock)
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">candidateId: {r.candidateId}</div>
                      {r.reason && <p className="text-sm mt-2"><strong>Reason:</strong> {r.reason}</p>}
                      {r.handlerNotes && <p className="text-sm mt-2 text-muted-foreground"><strong>Handler notes:</strong> {r.handlerNotes}</p>}
                    </div>
                    {r.status === "pending" && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button size="sm" variant="destructive" onClick={() => fulfil(r.id)} disabled={busy === r.id}>
                          {busy === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Fulfil</>}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => deny(r.id)} disabled={busy === r.id}>
                          <XCircle className="w-3.5 h-3.5 mr-1" />Deny
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
