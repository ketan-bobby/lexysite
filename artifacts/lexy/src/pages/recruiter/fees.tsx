/**
 * pages/recruiter/fees.tsx — Tenant "Placement Fees" page
 *
 * Shows the tenant's own per-hire fee line items (fees apply only to hires
 * that Lexy's AI sourcing or the LINX network originated). Tenant admins can
 * dispute a fee while it is still pending or approved — disputes route back
 * to the platform staff review queue.
 *
 * Access: tenant_admin / recruiter_admin (own subtree only, enforced server-side).
 */
import { authHeaders } from "@/lib/api";
import { useEffect, useState } from "react";
import { Redirect } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { OriginBadge } from "@/components/ui-custom/OriginBadge";
import { Loader2, Receipt, AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type Item = {
  id: string;
  originChannel: string;
  amount: string;
  currency: string;
  status: string;
  disputeReason: string | null;
  externalInvoiceRef: string | null;
  createdAt: string;
  candidateName: string;
  jobTitle: string;
  tenantName: string;
};

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
  disputed: "Under dispute",
  invoiced_externally: "Invoiced",
  paid: "Paid",
};

const ALLOWED_ROLES = new Set(["tenant_admin", "recruiter_admin", "platform_admin"]);

export default function TenantFees() {
  const { user } = useAuth();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disputeFor, setDisputeFor] = useState<Item | null>(null);
  const [disputeReason, setDisputeReason] = useState("");

  function load() {
    fetch(`${apiBase}/fee-ledger/mine`, { credentials: "include", headers: { ...authHeaders() } })
      .then((r) => r.json())
      .then((j) => setItems(j.items ?? []))
      .catch((e) => setError(String(e)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (user) load();
  }, [user]);

  if (user && !ALLOWED_ROLES.has(user.role)) return <Redirect to="/dashboard" />;

  async function submitDispute() {
    if (!disputeFor || disputeReason.trim().length < 5) return;
    setBusy(disputeFor.id);
    setError(null);
    try {
      const r = await fetch(`${apiBase}/fee-ledger/${disputeFor.id}/dispute`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ reason: disputeReason.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error);
      setDisputeFor(null);
      setDisputeReason("");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-4 max-w-4xl mx-auto">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Receipt className="w-5 h-5" /> Placement Fees
          </h1>
          <p className="text-sm text-muted-foreground">
            Per-hire fees apply only when Lexy's AI sourcing or the LINX network originated the
            hire. Direct applicants and candidates you added yourself are always free.
          </p>
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
              No placement fees yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {items.map((i) => (
              <Card key={i.id}>
                <CardContent className="py-3 px-4 flex items-center gap-4 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <div className="font-medium text-sm">
                      {i.candidateName} — {i.jobTitle}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {i.createdAt ? format(parseISO(i.createdAt), "MMM d, yyyy") : "—"}
                      {i.externalInvoiceRef ? ` · Invoice ${i.externalInvoiceRef}` : ""}
                    </div>
                    {i.status === "disputed" && i.disputeReason && (
                      <div className="text-xs text-amber-600 mt-1">
                        Your dispute: {i.disputeReason}
                      </div>
                    )}
                  </div>
                  <OriginBadge entryType="sourced" originEvidence={{ channel: i.originChannel }} />
                  <div className="text-sm font-semibold tabular-nums">
                    {i.currency} {Number(i.amount).toLocaleString()}
                  </div>
                  <Badge variant="outline" className={statusBadge[i.status] ?? ""}>
                    {statusLabel[i.status] ?? i.status}
                  </Badge>
                  {(i.status === "pending_review" || i.status === "approved") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === i.id}
                      onClick={() => {
                        setDisputeFor(i);
                        setDisputeReason("");
                      }}
                    >
                      Dispute this fee
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!disputeFor} onOpenChange={(o) => !o && setDisputeFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dispute this fee</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tell us why you believe this fee is incorrect (e.g. the candidate was already in your
            own pipeline). Our team will review the sourcing evidence and respond.
          </p>
          <Textarea
            placeholder="Reason for dispute (required)"
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisputeFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={disputeReason.trim().length < 5 || (!!disputeFor && busy === disputeFor.id)}
              onClick={submitDispute}
            >
              Submit dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
