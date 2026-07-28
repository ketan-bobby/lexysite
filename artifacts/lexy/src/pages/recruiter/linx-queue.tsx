/**
 * pages/recruiter/linx-queue.tsx — LINX-side engagement queue (Step 3).
 *
 * Visible only to admins of the LINX tenant (server enforces; the sidebar
 * link is probe-gated). Lists linx_requests targeted at LINX, filterable by
 * status, with Accept (idempotent materialization of a client + HM contact +
 * cloned requisition inside the LINX tenant) and Decline (reason optional).
 *
 * BOUNDARY: everything shown here is job METADATA + contact info from the
 * request row — no candidate data crosses the tenant boundary.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiBase, apiFetch } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Handshake, Loader2, Check, X, Building2, Mail, MapPin, Banknote, ArrowUpRight } from "lucide-react";

interface LinxQueueRow {
  id: string;
  jobId: string;
  status: "pending" | "accepted" | "declined" | "filled" | "closed";
  contactName: string;
  contactEmail: string;
  note: string | null;
  declineReason: string | null;
  requestedAt: string;
  respondedAt: string | null;
  linxReqId: string | null;
  clientTenantName: string | null;
  jobTitle: string | null;
  jobLocation: string | null;
  jobSalaryMin: number | null;
  jobSalaryMax: number | null;
  jobWorkType: string | null;
  jobEmploymentType: string | null;
}

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Engaged" },
  { value: "declined", label: "Declined" },
  { value: "filled", label: "Filled" },
  { value: "closed", label: "Closed" },
] as const;

const STATUS_BADGE: Record<LinxQueueRow["status"], string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  accepted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  declined: "border-destructive/40 bg-destructive/10 text-destructive",
  filled: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  closed: "border-border bg-muted/40 text-muted-foreground",
};

function salaryBand(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  const fmt = (n: number) => n.toLocaleString();
  if (min != null && max != null) return `${fmt(min)} – ${fmt(max)}`;
  return fmt((min ?? max)!);
}

export default function LinxQueue() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<string>("pending");
  const [declineTarget, setDeclineTarget] = useState<LinxQueueRow | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [acceptTarget, setAcceptTarget] = useState<LinxQueueRow | null>(null);

  const { data, isLoading, isError, error } = useQuery<{ requests: LinxQueueRow[] }>({
    queryKey: ["/api/linx/requests", tab],
    retry: false,
    queryFn: async () => {
      const qs = tab !== "all" ? `?status=${tab}` : "";
      const res = await apiFetch(`${apiBase}/linx/requests${qs}`);
      if (res.status === 401 || res.status === 403) {
        throw new Error("FORBIDDEN");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to load the LINX queue");
      }
      return res.json();
    },
  });
  const isForbidden = isError && (error as Error)?.message === "FORBIDDEN";
  const rows = data?.requests ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["/api/linx/requests"] });

  const acceptMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`${apiBase}/linx/requests/${id}/accept`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to accept the request");
      return body;
    },
    onSuccess: (body) => {
      invalidate();
      setAcceptTarget(null);
      toast({
        title: "Request accepted",
        description: body?.requisition?.workOrderNumber
          ? `Requisition ${body.requisition.workOrderNumber} created for ${body.requisition.clientName ?? "the client"}.`
          : "Requisition created.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't accept", description: e?.message, variant: "destructive" }),
  });

  /* Step 4 manual backstop — mark an accepted engagement filled/closed.
   * Status field only; agreements and fees are handled outside the system. */
  const terminalMutation = useMutation({
    mutationFn: async ({ id, target }: { id: string; target: "filled" | "closed" }) => {
      const res = await apiFetch(`${apiBase}/linx/requests/${id}/mark-${target}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Failed to mark as ${target}`);
      return body;
    },
    onSuccess: (_body, vars) => {
      invalidate();
      toast({
        title: vars.target === "filled" ? "Marked as filled" : "Marked as closed",
        description: "The client's work order now shows the outcome.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't update", description: e?.message, variant: "destructive" }),
  });

  const declineMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const res = await apiFetch(`${apiBase}/linx/requests/${id}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to decline the request");
      return body;
    },
    onSuccess: () => {
      invalidate();
      setDeclineTarget(null);
      setDeclineReason("");
      toast({ title: "Request declined", description: "The client will see the decline on their work order." });
    },
    onError: (e: any) => toast({ title: "Couldn't decline", description: e?.message, variant: "destructive" }),
  });

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Handshake className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">LINX Engagement Queue</h1>
            <p className="text-sm text-muted-foreground">
              Client requests for LINX to help fill roles. Accepting creates a client record and a cloned requisition inside LINX.
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {STATUS_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} data-testid={`tab-linx-${t.value}`}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading queue…
          </div>
        ) : isForbidden ? (
          <Card>
            <CardContent className="py-12 text-center space-y-1" data-testid="text-linx-access-denied">
              <p className="text-sm font-medium">Access denied</p>
              <p className="text-sm text-muted-foreground">
                The LINX engagement queue is only available to LINX tenant administrators.
              </p>
            </CardContent>
          </Card>
        ) : isError ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-destructive" data-testid="text-linx-queue-error">
              {(error as Error)?.message || "Failed to load the LINX queue."}
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No {tab !== "all" ? `${tab} ` : ""}requests.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <Card key={r.id} data-testid={`card-linx-request-${r.id}`}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{r.jobTitle ?? "Role no longer available"}</span>
                        <Badge variant="outline" className={`text-[11px] ${STATUS_BADGE[r.status]}`}>
                          {r.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3" /> {r.clientTenantName ?? "Unknown client"}
                        </span>
                        {r.jobLocation && (
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {r.jobLocation}</span>
                        )}
                        {salaryBand(r.jobSalaryMin, r.jobSalaryMax) && (
                          <span className="flex items-center gap-1"><Banknote className="w-3 h-3" /> {salaryBand(r.jobSalaryMin, r.jobSalaryMax)}</span>
                        )}
                        {r.jobWorkType && <span className="capitalize">{r.jobWorkType}</span>}
                        {r.jobEmploymentType && <span className="capitalize">{r.jobEmploymentType.replace("_", " ")}</span>}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Mail className="w-3 h-3" />
                        <span>{r.contactName}</span>
                        <span>·</span>
                        <a href={`mailto:${r.contactEmail}`} className="underline underline-offset-2">{r.contactEmail}</a>
                        <span>·</span>
                        <span>requested {new Date(r.requestedAt).toLocaleDateString()}</span>
                      </div>
                      {r.note && (
                        <p className="text-sm bg-muted/40 border rounded-md px-3 py-2 mt-1 whitespace-pre-wrap">{r.note}</p>
                      )}
                      {r.status === "declined" && r.declineReason && (
                        <p className="text-xs text-destructive">Declined: {r.declineReason}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {r.status === "pending" && (
                        <>
                          <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setAcceptTarget(r)}
                            data-testid={`button-accept-${r.id}`}
                          >
                            <Check className="w-4 h-4" /> Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 text-destructive"
                            onClick={() => { setDeclineTarget(r); setDeclineReason(""); }}
                            data-testid={`button-decline-${r.id}`}
                          >
                            <X className="w-4 h-4" /> Decline
                          </Button>
                        </>
                      )}
                      {r.status === "accepted" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            disabled={terminalMutation.isPending}
                            onClick={() => terminalMutation.mutate({ id: r.id, target: "filled" })}
                            data-testid={`button-mark-filled-${r.id}`}
                          >
                            <Check className="w-4 h-4" /> Mark filled
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 text-muted-foreground"
                            disabled={terminalMutation.isPending}
                            onClick={() => terminalMutation.mutate({ id: r.id, target: "closed" })}
                            data-testid={`button-mark-closed-${r.id}`}
                          >
                            <X className="w-4 h-4" /> Mark closed
                          </Button>
                        </>
                      )}
                      {(r.status === "accepted" || r.status === "filled") && r.linxReqId && (
                        <Link href={`/jobs/${r.linxReqId}`}>
                          <Button size="sm" variant="outline" className="gap-1.5" data-testid={`link-linx-req-${r.id}`}>
                            View requisition <ArrowUpRight className="w-3.5 h-3.5" />
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Accept confirmation */}
      <Dialog open={!!acceptTarget} onOpenChange={(o) => { if (!o) setAcceptTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Accept this request?</DialogTitle>
            <DialogDescription>
              This creates (or reuses) a client record for{" "}
              <span className="font-medium text-foreground">{acceptTarget?.clientTenantName ?? "the client"}</span>,
              adds <span className="font-medium text-foreground">{acceptTarget?.contactName}</span> as the hiring
              contact, and clones the role{" "}
              <span className="font-medium text-foreground">{acceptTarget?.jobTitle}</span> into a new LINX
              requisition. Assign a recruiter afterwards from the requisition itself.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAcceptTarget(null)}>Cancel</Button>
            <Button
              className="gap-2"
              disabled={acceptMutation.isPending}
              onClick={() => acceptTarget && acceptMutation.mutate(acceptTarget.id)}
              data-testid="button-confirm-accept"
            >
              {acceptMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Accept &amp; create requisition
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Decline with optional reason */}
      <Dialog open={!!declineTarget} onOpenChange={(o) => { if (!o) setDeclineTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline this request?</DialogTitle>
            <DialogDescription>
              Nothing is created. The client sees the decline (and your reason, if given) on their work order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Reason <span className="text-muted-foreground font-normal">· optional</span></Label>
            <Textarea
              rows={3}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="e.g. Outside our current coverage area…"
              data-testid="input-decline-reason"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeclineTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              className="gap-2"
              disabled={declineMutation.isPending}
              onClick={() => declineTarget && declineMutation.mutate({ id: declineTarget.id, reason: declineReason.trim() || undefined })}
              data-testid="button-confirm-decline"
            >
              {declineMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Decline request
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
