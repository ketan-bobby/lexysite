/**
 * pages/recruiter/audit.tsx — Tenant-visible activity log
 *
 * Thin viewer over the existing /audit-logs API. Tenant-scoped server-side
 * (audit.ts filters by user's tenantId for non-platform_admin viewers), so
 * this page shows the recruiter only their own tenant's activity.
 *
 * Day-one feature scope: list + action-prefix filter + date bound. Richer
 * filtering (per-candidate drill-down, CSV export) is a follow-up.
 */
import { useEffect, useState } from "react";
import { ListChecks, Loader2, RefreshCw } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";
import { BackToHome } from "@/components/layout/BackToHome";

interface AuditRow {
  id: string;
  createdAt: string;
  actorType: string;
  actorLabel: string | null;
  subjectType: string | null;
  subjectLabel: string | null;
  channel: string;
  direction: string;
  action: string;
  title: string | null;
}

const ACTION_FILTERS = [
  { v: "", l: "All activity" },
  { v: "candidate.", l: "Candidate events" },
  { v: "outreach.", l: "Outreach" },
  { v: "email.", l: "Email" },
  { v: "interview.", l: "Interview" },
  { v: "stage.", l: "Stage changes" },
];

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const qs = filter ? `?actionPrefix=${encodeURIComponent(filter)}&limit=200` : "?limit=200";
    apiFetch(`${apiBase}/audit-logs${qs}`)
      .then((r) => r.json()).then((j) => { setRows(j.items ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(load, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen text-foreground py-10 px-6">
      <div className="max-w-5xl mx-auto">
        <BackToHome to="/dashboard" />
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <ListChecks className="w-4 h-4" />
              </div>
              <h1 className="page-title">Activity log</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Tamper-evident record of emails, AI decisions, stage changes, and access events
              in your workspace. Used for compliance evidence and incident investigation.
            </p>
          </div>
          <button onClick={load} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className="flex gap-2 mb-6 flex-wrap">
          {ACTION_FILTERS.map((f) => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                filter === f.v
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No activity in this view yet.</p>
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">When</th>
                  <th className="text-left px-4 py-2.5 font-medium">Action</th>
                  <th className="text-left px-4 py-2.5 font-medium">Actor</th>
                  <th className="text-left px-4 py-2.5 font-medium">Subject</th>
                  <th className="text-left px-4 py-2.5 font-medium">Channel</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border/40">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{r.action}</div>
                      {r.title && <div className="text-xs text-muted-foreground">{r.title}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{r.actorLabel ?? r.actorType}</td>
                    <td className="px-4 py-2.5 text-xs">{r.subjectLabel ?? r.subjectType ?? "—"}</td>
                    <td className="px-4 py-2.5 text-xs">{r.channel} / {r.direction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
