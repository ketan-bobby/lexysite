/**
 * UnifiedApprovalQueue — one place to review/approve/reject pending drafts (T009).
 *
 * Aggregates BOTH first-touch `outreach_messages` (pending_approval) and the new
 * `ai_message_generations` (generated/edited) via GET /ai-messages/queue. Approve
 * / reject route to the correct backend per item source. Nothing auto-sends.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Check, X, Loader2, Info, Mail, FileText, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { aiFetch, messageTypeLabel } from "@/lib/ai-intel-api";

interface QueueItem {
  source: "outreach_messages" | "ai_message_generations" | "outreach_step_messages";
  id: string;
  jobId: string | null;
  candidateId: string | null;
  messageType: string;
  subject: string | null;
  body: string;
  status: string;
  contextSummary: string | null;
  createdAt: string;
}

export function UnifiedApprovalQueue() {
  const { data, isLoading } = useQuery<{ items: QueueItem[] }>({
    queryKey: ["ai-queue"],
    queryFn: () => aiFetch(`/ai-messages/queue`),
    refetchInterval: 30000,
  });
  const items = data?.items ?? [];

  if (isLoading) return <p className="text-sm text-muted-foreground py-8">Loading approval queue…</p>;
  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Check className="w-8 h-8 mx-auto mb-2 opacity-40" />
        Nothing awaiting approval. Generated drafts will appear here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => <QueueCard key={`${item.source}:${item.id}`} item={item} />)}
    </div>
  );
}

function QueueCard({ item }: { item: QueueItem }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Inline edit state: when `editing`, the body (and subject, for email drafts)
  // become editable fields. Seeded from the current draft when the user opens it.
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  const isOutreach = item.source === "outreach_messages";
  const isStep = item.source === "outreach_step_messages";
  const isEmail = isOutreach || isStep;
  const approvePath = isStep
    ? `/outreach/step-messages/${item.id}/approve`
    : isOutreach
    ? `/outreach/messages/${item.id}/approve`
    : `/ai-messages/${item.id}/approve`;
  const rejectPath = isStep
    ? `/outreach/step-messages/${item.id}/reject`
    : isOutreach
    ? `/outreach/messages/${item.id}/reject`
    : `/ai-messages/${item.id}/reject`;
  // The edit endpoint differs per source; all PATCH the subject/body of a draft
  // that's still awaiting approval (see routes/outreach.ts & routes/ai-messages.ts).
  const editPath = isStep
    ? `/outreach/step-messages/${item.id}`
    : isOutreach
    ? `/outreach/messages/${item.id}`
    : `/ai-messages/${item.id}`;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["ai-queue"] });
    qc.invalidateQueries({ queryKey: ["outreach-messages"] });
  };

  const approveMut = useMutation({
    mutationFn: () => aiFetch<any>(approvePath, { method: "POST", body: "{}" }),
    onSuccess: (d: any) => {
      toast({
        title: isStep
          ? "Approved — sending shortly"
          : isOutreach
          ? d?.dispatched === false ? "Approved, but send failed" : "Approved & sent"
          : "Approved",
        description: d?.dispatchError || undefined,
        variant: d?.dispatched === false ? "destructive" : undefined,
      });
      invalidate();
    },
    onError: (e: any) => toast({ title: "Approve failed", description: e.message, variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: () => aiFetch<any>(rejectPath, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      toast({ title: "Rejected — it won't be sent" });
      setRejectOpen(false);
      setReason("");
      invalidate();
    },
    onError: (e: any) => toast({ title: "Reject failed", description: e.message, variant: "destructive" }),
  });

  // Save edits to the draft (PATCH), then drop back to read-only and refresh so
  // the card shows the new text. The recruiter still has to Approve afterwards.
  const editMut = useMutation({
    mutationFn: () => {
      const payload: Record<string, string> = { body: editBody };
      if (isEmail) payload.subject = editSubject;
      return aiFetch<any>(editPath, { method: "PATCH", body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      toast({ title: "Draft updated", description: "Review it, then approve to send." });
      setEditing(false);
      invalidate();
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const startEditing = () => {
    setEditSubject(item.subject ?? "");
    setEditBody(item.body);
    setExpanded(true);
    setEditing(true);
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="gap-1 text-[10px]">
                {isEmail ? <Mail className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                {messageTypeLabel(item.messageType)}
              </Badge>
              <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-[10px]">
                {item.status === "pending_approval" ? "Awaiting approval" : item.status}
              </Badge>
            </div>
            {item.subject && !editing && <p className="text-sm font-semibold mt-2 truncate">{item.subject}</p>}
          </div>
          <button onClick={() => setExpanded((e) => !e)} className="text-muted-foreground hover:text-foreground shrink-0">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {item.contextSummary && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md bg-primary/5 border border-primary/15 p-2">
            <Info className="w-3 h-3 mt-0.5 text-primary shrink-0" />
            <p className="text-[11px] text-muted-foreground">{item.contextSummary}</p>
          </div>
        )}

        {editing ? (
          /* Inline editor — tweak the AI draft before approving. */
          <div className="mt-3 space-y-2">
            {isEmail && (
              <Input
                value={editSubject}
                onChange={(e) => setEditSubject(e.target.value)}
                placeholder="Subject"
                className="text-sm font-medium"
              />
            )}
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
            {item.body}
          </p>
        )}

        {editing ? (
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
              Approve
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={startEditing}>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5 text-red-500" onClick={() => setRejectOpen(true)}>
              <X className="w-3.5 h-3.5" /> Reject
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject draft</DialogTitle></DialogHeader>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional — why is this being rejected? (helps the AI improve)"
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
