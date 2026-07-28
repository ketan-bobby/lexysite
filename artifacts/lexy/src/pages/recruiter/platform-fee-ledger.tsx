/**
 * pages/recruiter/platform-fee-ledger.tsx — Platform Admin "Fee Ledger" page
 *
 * Staff review queue for per-hire fee line items (created automatically on
 * offer-acceptance for fee-eligible hires: entry_type='sourced' with
 * ai_sourcing / linx origin evidence). No in-system payments — approved items
 * are exported as CSV for EXTERNAL invoicing, then marked invoiced / paid by
 * hand.
 *
 * Actions per status:
 *   pending_review → Approve / Waive
 *   disputed       → Approve (fee stands) / Waive (fee dropped)
 *   approved       → Mark invoiced (ref) / Waive
 *   invoiced_externally → Mark paid
 * Plus a per-row "Correct origin" dialog (platform_admin-only, audited;
 * reconciles the ledger — waives or creates the line item as needed).
 *
 * Access: platform_admin only — non-admins are redirected to /dashboard.
 */
import { authHeaders } from "@/lib/api";
import { useEffect, useState } from "react";
import { Redirect } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OriginBadge } from "@/components/ui-custom/OriginBadge";
import { Loader2, Download, Receipt, AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type Item = {
  id: string;
  tenantId: string;
  applicationId: string;
  candidateId: string;
  jobId: string;
  originChannel: string;
  amount: string;
  currency: string;
  planCode: string | null;
  status: string;
  reviewReason: string | null;
  disputeReason: string | null;
  externalInvoiceRef: string | null;
  createdAt: string;
  candidateName: string;
  jobTitle: string;
  tenantName: string;
};

const STATUS_TABS = [
  "all",
  "pending_review",
  "disputed",
  "approved",
  "invoiced_externally",
  "paid",
  "waived",
] as const;

const statusBadge: Record<string, string> = {
  pending_review: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  approved: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  waived: "bg-slate-500/15 text-slate-600 border-slate-500/30",
  disputed: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  invoiced_externally: "bg-cyan-500/15 text-cyan-600 border-cyan-500/30",
  paid: "bg-purple-500/15 text-purple-600 border-purple-500/30",
};

const statusLabel: Record<string, string> = {
  pending_review: "Pending review",
  approved: "Approved",
  waived: "Waived",
  disputed: "Disputed",
  invoiced_externally: "Invoiced",
  paid: "Paid",
};

export default function PlatformFeeLedger() {
  const { user } = useAuth();
  const [items, setItems] = useState<Item[] | null>(null);
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]>("pending_review");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<Item | null>(null);
  const [invoiceRef, setInvoiceRef] = useState("");
  const [correctFor, setCorrectFor] = useState<Item | null>(null);
  const [correctChannel, setCorrectChannel] = useState<string>("none");
  const [correctReason, setCorrectReason] = useState("");

  function load() {
    const qs = tab === "all" ? "" : `?status=${tab}`;
    fetch(`${apiBase}/fee-ledger${qs}`, { credentials: "include", headers: { ...authHeaders() } })
      .then((r) => r.json())
      .then((j) => setItems(j.items ?? []))
      .catch((e) => setError(String(e)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (user) load();
  }, [user, tab]);

  if (user && user.role !== "platform_admin") return <Redirect to="/dashboard" />;

  async function setStatus(item: Item, status: string, extra?: Record<string, unknown>) {
    setBusy(item.id);
    setError(null);
    try {
      const r = await fetch(`${apiBase}/fee-ledger/${item.id}/status`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitCorrection() {
    if (!correctFor || correctReason.trim().length < 5) return;
    setBusy(correctFor.id);
    setError(null);
    try {
      const body =
        correctChannel === "none"
          ? {
              applicationId: correctFor.applicationId,
              originEvidence: null,
              reason: correctReason.trim(),
            }
          : {
              applicationId: correctFor.applicationId,
              entryType: "sourced",
              originEvidence: { channel: correctChannel, correctedVia: "staff_review" },
              reason: correctReason.trim(),
            };
      const r = await fetch(`${apiBase}/fee-ledger/corrections`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error);
      setCorrectFor(null);
      setCorrectReason("");
      setCorrectChannel("none");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const money = (i: Item) => `${i.currency} ${Number(i.amount).toLocaleString()}`;

  return (
    <AppLayout>
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Receipt className="w-5 h-5" /> Fee Ledger
            </h1>
            <p className="text-sm text-muted-foreground">
              Per-hire fees for AI-sourced and LINX-sourced hires. Approve, export for external
              invoicing, and record payment manually.
            </p>
          </div>
          <a
            href={`${apiBase}/fee-ledger/export.csv?status=approved`}
            target="_blank"
            rel="noreferrer"
          >
            <Button variant="outline" size="sm">
              <Download className="w-4 h-4 mr-1.5" />
              Export approved (CSV)
            </Button>
          </a>
        </div>

        <div className="flex gap-1.5 flex-wrap">
          {STATUS_TABS.map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => {
                setItems(null);
                setTab(t);
              }}
            >
              {t === "all" ? "All" : (statusLabel[t] ?? t)}
            </Button>
          ))}
        </div>

        {error && (
          <div className="text-sm text-destructive flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" />
            {error}
          </div>
        )}

        {!items ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading…
          </div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No fee line items{tab !== "all" ? ` in "${statusLabel[tab] ?? tab}"` : ""}.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {items.map((i) => (
              <Card key={i.id}>
                <CardContent className="py-3 px-4 flex items-center gap-4 flex-wrap">
                  <div className="flex-1 min-w-[220px]">
                    <div className="font-medium text-sm">
                      {i.candidateName} — {i.jobTitle}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {i.tenantName} ·{" "}
                      {i.createdAt ? format(parseISO(i.createdAt), "MMM d, yyyy") : "—"}
                      {i.externalInvoiceRef ? ` · Invoice ${i.externalInvoiceRef}` : ""}
                    </div>
                    {i.disputeReason && i.status === "disputed" && (
                      <div className="text-xs text-amber-600 mt-1">Dispute: {i.disputeReason}</div>
                    )}
                  </div>
                  <OriginBadge entryType="sourced" originEvidence={{ channel: i.originChannel }} />
                  <div className="text-sm font-semibold tabular-nums">{money(i)}</div>
                  <Badge variant="outline" className={statusBadge[i.status] ?? ""}>
                    {statusLabel[i.status] ?? i.status}
                  </Badge>
                  <div className="flex gap-1.5">
                    {(i.status === "pending_review" || i.status === "disputed") && (
                      <Button
                        size="sm"
                        disabled={busy === i.id}
                        onClick={() => setStatus(i, "approved")}
                      >
                        Approve
                      </Button>
                    )}
                    {(i.status === "pending_review" ||
                      i.status === "approved" ||
                      i.status === "disputed") && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === i.id}
                        onClick={() => setStatus(i, "waived")}
                      >
                        Waive
                      </Button>
                    )}
                    {i.status === "approved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === i.id}
                        onClick={() => {
                          setInvoiceFor(i);
                          setInvoiceRef("");
                        }}
                      >
                        Mark invoiced
                      </Button>
                    )}
                    {i.status === "invoiced_externally" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === i.id}
                        onClick={() => setStatus(i, "paid")}
                      >
                        Mark paid
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === i.id}
                      onClick={() => {
                        setCorrectFor(i);
                        setCorrectChannel("none");
                        setCorrectReason("");
                      }}
                    >
                      Correct origin
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Mark invoiced dialog */}
      <Dialog open={!!invoiceFor} onOpenChange={(o) => !o && setInvoiceFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as invoiced externally</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Record the external invoice reference for {invoiceFor?.candidateName} (
            {invoiceFor?.tenantName}).
          </p>
          <Input
            placeholder="Invoice reference (e.g. INV-2026-041)"
            value={invoiceRef}
            onChange={(e) => setInvoiceRef(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoiceFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!invoiceFor || busy === invoiceFor.id}
              onClick={async () => {
                if (invoiceFor) {
                  await setStatus(invoiceFor, "invoiced_externally", {
                    externalInvoiceRef: invoiceRef.trim() || undefined,
                  });
                  setInvoiceFor(null);
                }
              }}
            >
              Mark invoiced
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correct origin dialog */}
      <Dialog open={!!correctFor} onOpenChange={(o) => !o && setCorrectFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct sourcing origin</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Corrects the application's origin evidence (fully audited) and reconciles this fee:
            removing evidence waives the fee; setting a fee-eligible channel keeps or creates it.
          </p>
          <Select value={correctChannel} onValueChange={setCorrectChannel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No sourcing evidence (not fee-eligible)</SelectItem>
              <SelectItem value="ai_sourcing">AI Sourcing (fee-eligible)</SelectItem>
              <SelectItem value="linx">LINX (fee-eligible)</SelectItem>
            </SelectContent>
          </Select>
          <Textarea
            placeholder="Reason for correction (required)"
            value={correctReason}
            onChange={(e) => setCorrectReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={correctReason.trim().length < 5 || (!!correctFor && busy === correctFor.id)}
              onClick={submitCorrection}
            >
              Apply correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
