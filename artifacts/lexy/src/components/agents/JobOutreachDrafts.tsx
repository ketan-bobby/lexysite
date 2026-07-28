/**
 * JobOutreachDrafts.tsx — work-order-scoped outreach drafts & approvals.
 *
 * Surfaces first-touch `outreach_messages` for ONE job so recruiters can review
 * and approve drafts without leaving the work order. Used in two places:
 *   - The job detail "Outreach" tab  → <JobOutreachPanel jobId={…} />
 *   - The pipeline "Outreach Queued" card → <OutreachDraftCard> in a dialog,
 *     fed by the useJobOutreachDrafts() map.
 *
 * Data source: GET /api/outreach/messages?jobId=…  (tenant-scoped server-side).
 * Approve / reject reuse the same endpoints as the global Approvals queue:
 *   POST /api/outreach/messages/:id/approve
 *   POST /api/outreach/messages/:id/reject
 */
import { useState } from "react";
import { authHeaders } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Check, X, Loader2, Mail, ChevronDown, ChevronUp, Send, Sparkles, Inbox, Pencil,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...opts,
  });
  if (!res.ok) {
    let message = `API ${res.status}`;
    try { const b = await res.json(); if (b?.error) message = b.error; } catch { /* not json */ }
    throw new Error(message);
  }
  return res.json();
}

export interface OutreachMessage {
  id: string;
  jobId: string;
  candidateId: string;
  subject: string | null;
  body: string;
  status: string;
  replySentiment?: string | null;
  candidate?: { firstName?: string; lastName?: string; email?: string; doNotContact?: boolean };
}

/** Fetch all outreach messages for one job. */
export function useJobOutreachMessages(jobId: string, enabled = true) {
  return useQuery<OutreachMessage[]>({
    queryKey: ["job-outreach", jobId],
    queryFn: () => apiFetch(`/outreach/messages?jobId=${jobId}`),
    enabled: enabled && !!jobId,
    refetchInterval: 15_000,
  });
}

/** Map of candidateId → pending-approval draft, for the pipeline board. */
export function useJobPendingDrafts(jobId: string) {
  const { data } = useJobOutreachMessages(jobId);
  const map: Record<string, OutreachMessage> = {};
  for (const m of data ?? []) {
    if (m.status === "pending_approval" && m.candidateId) map[m.candidateId] = m;
  }
  return map;
}

function statusBadge(status: string) {
  if (status === "pending_approval") return <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-[10px]">Awaiting approval</Badge>;
  if (status === "sent") return <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-[10px]">Sent</Badge>;
  if (status === "replied") return <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px]">Replied</Badge>;
  if (status === "rejected") return <Badge className="bg-slate-100 text-slate-600 border-slate-200 text-[10px]">Rejected</Badge>;
  if (status === "failed") return <Badge className="bg-red-100 text-red-700 border-red-200 text-[10px]">Failed</Badge>;
  return <Badge className="bg-orange-100 text-orange-700 border-orange-200 text-[10px]">Queued</Badge>;
}

/**
 * A single outreach draft/message card with approve + reject actions.
 * `onDone` fires after a successful approve/reject so callers can close dialogs.
 */
export function OutreachDraftCard({ msg, onDone }: { msg: OutreachMessage; onDone?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(true);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Inline edit state — lets recruiters tweak the AI draft right here before approving.
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  const isPending = msg.status === "pending_approval";
  const name = msg.candidate ? `${msg.candidate.firstName ?? ""} ${msg.candidate.lastName ?? ""}`.trim() || "Candidate" : "Candidate";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["job-outreach", msg.jobId] });
    qc.invalidateQueries({ queryKey: ["pipeline-stages", msg.jobId] });
    qc.invalidateQueries({ queryKey: ["ai-queue"] });
    qc.invalidateQueries({ queryKey: ["outreach-messages", msg.jobId] });
  };

  const approveMut = useMutation({
    mutationFn: () => apiFetch<any>(`/outreach/messages/${msg.id}/approve`, { method: "POST", body: "{}" }),
    onSuccess: (d: any) => {
      toast({
        title: d?.dispatched === false ? "Approved, but send failed" : "Approved & sent",
        description: d?.dispatchError || `Email on its way to ${msg.candidate?.email || name}.`,
        variant: d?.dispatched === false ? "destructive" : undefined,
      });
      invalidate();
      onDone?.();
    },
    onError: (e: any) => toast({ title: "Approve failed", description: e.message, variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: () => apiFetch<any>(`/outreach/messages/${msg.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: (d: any) => {
      toast({
        title: d?.regenerated ? "Rejected — a new draft was generated" : "Draft rejected — it won't be sent",
        description: d?.regenerated ? "Lexy rewrote the email using your feedback. Review it again." : undefined,
      });
      setRejectOpen(false);
      setReason("");
      invalidate();
      if (!d?.regenerated) onDone?.();
    },
    onError: (e: any) => toast({ title: "Reject failed", description: e.message, variant: "destructive" }),
  });

  // Save edits to the draft (PATCH), then return to read-only and refresh. The
  // recruiter still approves separately, so editing never sends on its own.
  const editMut = useMutation({
    mutationFn: () => apiFetch<any>(`/outreach/messages/${msg.id}`, {
      method: "PATCH",
      body: JSON.stringify({ subject: editSubject, body: editBody }),
    }),
    onSuccess: () => {
      toast({ title: "Draft updated", description: "Review it, then approve to send." });
      setEditing(false);
      invalidate();
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const startEditing = () => {
    setEditSubject(msg.subject ?? "");
    setEditBody(msg.body);
    setExpanded(true);
    setEditing(true);
  };

  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="gap-1 text-[10px]"><Mail className="w-3 h-3" /> Outreach</Badge>
              {statusBadge(msg.status)}
              <span className="text-xs font-semibold">{name}</span>
            </div>
            {msg.subject && !editing && <p className="text-sm font-semibold mt-2 truncate">{msg.subject}</p>}
          </div>
          <button onClick={() => setExpanded((e) => !e)} aria-label={expanded ? "Collapse message" : "Expand message"} aria-expanded={expanded} className="text-muted-foreground hover:text-foreground shrink-0">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {editing ? (
          /* Inline editor — tweak the AI draft before approving. */
          <div className="mt-3 space-y-2">
            <Input
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
              placeholder="Subject"
              className="text-sm font-medium"
            />
            <Textarea
              rows={8}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder="Message body"
              className="text-sm"
            />
          </div>
        ) : (
          <p className={`text-sm text-muted-foreground mt-2 whitespace-pre-wrap ${expanded ? "" : "line-clamp-3"}`}>
            {msg.body}
          </p>
        )}

        {isPending && (editing ? (
          <div className="flex items-center gap-2 mt-3">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={editMut.isPending || editBody.trim().length === 0}
              onClick={() => editMut.mutate()}
            >
              {editMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" className="gap-1.5" disabled={approveMut.isPending} onClick={() => approveMut.mutate()}>
              {approveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Approve & Send
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={startEditing}>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5 text-red-500" onClick={() => setRejectOpen(true)}>
              <X className="w-3.5 h-3.5" /> Reject
            </Button>
          </div>
        ))}
      </CardContent>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject draft</DialogTitle></DialogHeader>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional — why is this being rejected? (helps Lexy rewrite it)"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={rejectMut.isPending} onClick={() => rejectMut.mutate()}>
              {rejectMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Reject draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Full panel for the job detail "Outreach" tab. */
export function JobOutreachPanel({ jobId }: { jobId: string }) {
  const { data, isLoading } = useJobOutreachMessages(jobId);
  const messages = data ?? [];
  const pending = messages.filter((m) => m.status === "pending_approval");
  const others = messages.filter((m) => m.status !== "pending_approval");

  return (
    <div className="space-y-6">
      {/* Pending approvals — the part recruiters act on */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">Drafts awaiting your approval</h3>
            {pending.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{pending.length}</span>
            )}
          </div>
          <Link href="/outreach?tab=approvals">
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
              <Inbox className="w-3.5 h-3.5" /> All approvals
            </Button>
          </Link>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading drafts…</p>
        ) : pending.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-muted-foreground">
              <Check className="w-7 h-7 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No drafts waiting. Move a verified candidate into <span className="font-medium text-foreground">Shortlisted</span> on the pipeline and Lexy will draft a first-touch email here for your approval.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {pending.map((m) => <OutreachDraftCard key={m.id} msg={m} />)}
          </div>
        )}
      </div>

      {/* Sent / replied / other history for this role */}
      {others.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Send className="w-3.5 h-3.5" /> Outreach history
          </h3>
          <div className="space-y-3">
            {others.map((m) => <OutreachDraftCard key={m.id} msg={m} />)}
          </div>
        </div>
      )}

      {/* Campaign CTA — multi-step sequences still live on the Outreach page */}
      <Card className="border-dashed bg-muted/20">
        <CardContent className="py-6 text-center">
          <p className="text-sm text-muted-foreground mb-3">
            Want a multi-step nurture sequence for passive candidates? Build a campaign on the Outreach page.
          </p>
          <Link href="/outreach">
            <Button variant="outline" size="sm" className="gap-1.5"><Send className="w-3.5 h-3.5" /> Go to Campaigns</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
