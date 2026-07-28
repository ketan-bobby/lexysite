/**
 * pages/recruiter/outreach/index.tsx — Outreach Campaign Manager
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The main outreach management page: create and manage multi-step email
 * campaigns, view enrollment stats, and monitor reply classification outcomes.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   CampaignCard     — campaign name, job, template, status badge,
 *                      open/reply/interested/DNC rate stats
 *   CreateCampaign   — "New Campaign" dialog: pick job → pick template →
 *                      set sequence steps → publish
 *   EnrollmentPanel  — list of active enrollments with per-candidate status
 *   Stats Header     — aggregate metrics across all campaigns (this tenant)
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/outreach/campaigns          — list campaigns
 *   POST /api/outreach/campaigns         — create campaign
 *   GET /api/outreach/enrollments        — per-candidate enrollment status
 *   GET /api/outreach/stats              — aggregate stats
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/outreach
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { pluralize } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Link } from "wouter";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow, parseISO } from "date-fns";
import {
  Send, Mail, MessageSquare, CheckCircle2, XCircle, Ban, Clock, ChevronDown, ChevronUp,
  AlertCircle, Zap, RefreshCw, ExternalLink, Users, Play, Pause, RotateCcw,
  ArrowRight, Inbox, Sparkles, ArrowLeft, Pencil,
} from "lucide-react";
import { useToast } from "@workspace/react-hooks/use-toast";
import { UnifiedApprovalQueue } from "@/components/ai-intel/UnifiedApprovalQueue";
import { GenerateMessageDialog } from "@/components/ai-intel/GenerateMessageDialog";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment step progress
// ─────────────────────────────────────────────────────────────────────────────

const STEP_LABELS = ["", "Intro (Day 0)", "Follow-up 1 (Day 3)", "Follow-up 2 (Day 7)", "Final (Day 14)"];

// One node in the sequence-progress strip: green=sent, primary=next/ready, muted=future.
function StepDot({ step, currentStep, messages }: { step: number; currentStep: number; messages: any[] }) {
  const msg = messages.find(m => m.stepNumber === step);
  const sent = msg?.status === "sent";
  const scheduled = msg?.status === "scheduled";

  if (sent) return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center">
        <CheckCircle2 className="w-4 h-4 text-white" />
      </div>
      <span className="text-[10px] text-green-600 font-medium">Sent</span>
    </div>
  );
  if (scheduled || step === currentStep + 1) return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-7 h-7 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center">
        <span className="text-[10px] font-bold text-primary">{step}</span>
      </div>
      <span className="text-[10px] text-primary font-medium">{scheduled ? "Ready" : "Next"}</span>
    </div>
  );
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-7 h-7 rounded-full bg-muted border border-border/60 flex items-center justify-center">
        <span className="text-[10px] text-muted-foreground">{step}</span>
      </div>
      <span className="text-[10px] text-muted-foreground">—</span>
    </div>
  );
}

// Expandable row for one enrolled candidate: shows sequence progress and lets
// the recruiter log/classify an inbound reply.
function EnrollmentCard({ enrollment, campaignId }: { enrollment: any; campaignId: string }) {
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const replyMut = useMutation({
    mutationFn: ({ body, messageId }: { body: string; messageId?: string }) =>
      apiFetch(`/outreach/campaigns/${campaignId}/replies`, {
        method: "POST",
        body: JSON.stringify({ enrollmentId: enrollment.id, messageId, body }),
      }),
    onSuccess: (data: any) => {
      toast({ title: `Reply classified: ${data.classification} (${data.sentiment})` });
      qc.invalidateQueries({ queryKey: ["enrollments", campaignId] });
      // Server may have flipped doNotContact=true on "unsubscribe" classification — refresh DNC-aware surfaces
      if (data.classification === "unsubscribe" || data.sentiment === "do_not_contact") {
        qc.invalidateQueries({ queryKey: ["/api/candidates"] });
        qc.invalidateQueries({ queryKey: ["dnc-list"] });
        qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
      }
    },
  });

  const simulateNextMut = useMutation({
    mutationFn: () =>
      apiFetch(`/outreach/enrollments/${enrollment.id}/simulate-next`, { method: "POST" }),
    onSuccess: (data: any) => {
      toast({ title: `Step ${data.step} sent!`, description: `Generated ${data.generated} message(s) and sent ${data.sent}.` });
      qc.invalidateQueries({ queryKey: ["enrollments", campaignId] });
      qc.invalidateQueries({ queryKey: ["campaign", campaignId] });
    },
    onError: (err: any) => {
      toast({ title: "Could not advance", description: err.message, variant: "destructive" });
    },
  });

  const messages: any[] = enrollment.messages || [];
  const candidate = enrollment.candidate || {};
  const initials = (candidate.name || "?").split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  const statusColors: Record<string, string> = {
    enrolled: "bg-slate-100 text-slate-600",
    active: "bg-blue-100 text-blue-700",
    replied: "bg-green-100 text-green-700",
    stopped: "bg-red-100 text-red-700",
    completed: "bg-purple-100 text-purple-700",
    bounced: "bg-orange-100 text-orange-700",
  };

  const statusLabels: Record<string, string> = {
    enrolled: "Pending",
    active: "Receiving Emails",
    replied: "Replied",
    stopped: "Unsubscribed",
    completed: "Completed",
    bounced: "Bounced",
  };

  return (
    <Card className="border-border/60 transition-all">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className="font-semibold text-sm">{candidate.name || enrollment.recipientName || "Unknown"}</span>
              <Badge className={`text-xs ${statusColors[enrollment.status] || "bg-slate-100 text-slate-600"}`}>
                {statusLabels[enrollment.status] || enrollment.status}
              </Badge>
              {enrollment.abVariant && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  Variant {enrollment.abVariant}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {candidate.title}{candidate.company ? ` @ ${candidate.company}` : ""}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-muted-foreground">
              Step {enrollment.currentStep}/{messages.length || 4}
            </span>
            <Button size="sm" variant="ghost" aria-label={expanded ? "Collapse" : "Expand"} aria-expanded={expanded} className="h-7 w-7 p-0" onClick={() => setExpanded(v => !v)}>
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Step progress dots */}
        <div className="mt-3 pl-12">
          <div className="flex items-start gap-2">
            {[1, 2, 3, 4].map((step, idx) => (
              <div key={step} className="flex items-center gap-2">
                <StepDot step={step} currentStep={enrollment.currentStep} messages={messages} />
                {idx < 3 && <ArrowRight className="w-3 h-3 text-muted-foreground/40 mt-[-12px]" />}
              </div>
            ))}
          </div>
        </div>

        {/* Expanded messages */}
        {expanded && (
          <div className="mt-4 pl-12 space-y-3">
            {messages.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No messages generated yet — autopilot will generate them on next run.</p>
            ) : (
              messages.map((msg: any) => (
                <div key={msg.id} className="bg-muted/30 rounded-lg p-3 border border-border/40 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] px-1.5">Step {msg.stepNumber}</Badge>
                      <span className="text-xs font-medium truncate">{msg.subject}</span>
                    </div>
                    <Badge className={`text-[10px] flex-shrink-0 ${
                      msg.status === "sent" ? "bg-green-100 text-green-700"
                      : msg.status === "scheduled" ? "bg-blue-100 text-blue-700"
                      : msg.status === "failed" ? "bg-red-100 text-red-700"
                      : "bg-slate-100 text-slate-600"
                    }`}>
                      {msg.status}
                      {msg.sentAt ? ` · ${formatDistanceToNow(parseISO(msg.sentAt), { addSuffix: true })}` : ""}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{msg.body}</p>
                </div>
              ))
            )}

            {/* Simulate next step */}
            {(enrollment.status === "active" || enrollment.status === "enrolled") && enrollment.currentStep < 4 && (
              <div className="pt-2 border-t border-border/30">
                <p className="text-xs text-muted-foreground mb-2">Advance sequence:</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
                  onClick={() => simulateNextMut.mutate()}
                  disabled={simulateNextMut.isPending}
                >
                  {simulateNextMut.isPending
                    ? <RefreshCw className="w-3 h-3 animate-spin" />
                    : <ArrowRight className="w-3 h-3" />}
                  {simulateNextMut.isPending ? "Generating…" : `Send Step ${enrollment.currentStep + 1} now`}
                </Button>
              </div>
            )}

            {/* Simulate reply */}
            {enrollment.status === "active" || enrollment.status === "enrolled" ? (
              <div className="pt-2 border-t border-border/30">
                <p className="text-xs text-muted-foreground mb-2">Simulate candidate reply:</p>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { label: "Interested", body: "Yes, I would love to hear more about this role. Please send me details." },
                    { label: "Not Interested", body: "Thanks but I am happy in my current role." },
                    { label: "Unsubscribe", body: "Please remove me from your mailing list." },
                  ].map(r => (
                    <Button
                      key={r.label}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => replyMut.mutate({ body: r.body })}
                      disabled={replyMut.isPending}
                    >
                      {r.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequence step display
// ─────────────────────────────────────────────────────────────────────────────

// Detailed view of a single campaign's enrollments + per-step message sequence.
function SequenceView({ campaignId }: { campaignId: string }) {
  const { data: steps = [] } = useQuery<any[]>({
    queryKey: ["sequence-steps", campaignId],
    queryFn: () => apiFetch(`/outreach/campaigns/${campaignId}/steps`),
  });

  const { data: runs = [] } = useQuery<any[]>({
    queryKey: ["autopilot-runs", campaignId],
    queryFn: () => apiFetch(`/outreach/campaigns/${campaignId}/autopilot-runs`),
  });

  const stepColors = ["bg-primary/10 text-primary", "bg-blue-100 text-blue-700", "bg-purple-100 text-purple-700", "bg-orange-100 text-orange-700"];

  return (
    <div className="space-y-6">
      {/* Sequence steps */}
      <div>
        <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">Sequence Definition</h3>
        <div className="space-y-3">
          {steps.map((step: any, idx: number) => (
            <div key={step.id} className="flex items-start gap-4">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${stepColors[idx] || stepColors[0]}`}>
                {step.stepNumber}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-0.5">
                  <span className="font-medium text-sm">{STEP_LABELS[step.stepNumber] || `Step ${step.stepNumber}`}</span>
                  {step.delayDays > 0 && (
                    <Badge variant="outline" className="text-xs">
                      <Clock className="w-2.5 h-2.5 mr-1" />+{step.delayDays} days
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-xs capitalize">{step.type}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{step.bodyTemplate}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent autopilot runs */}
      {runs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">Recent Autopilot Runs</h3>
          <div className="space-y-2">
            {runs.slice(0, 5).map((run: any) => (
              <div key={run.id} className="flex items-center justify-between text-xs p-2 rounded-lg bg-muted/30 border border-border/40">
                <span className="text-muted-foreground">{formatDistanceToNow(parseISO(run.ranAt), { addSuffix: true })}</span>
                <div className="flex gap-3">
                  <span className="text-blue-600">Generated: {run.messagesGenerated}</span>
                  <span className="text-green-600">Sent: {run.messagesSent}</span>
                  {run.messagesFailed > 0 && <span className="text-red-500">Failed: {run.messagesFailed}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy message card (existing outreach_messages table)
// ─────────────────────────────────────────────────────────────────────────────

// Map a message status (+ reply sentiment) to its display badge.
function statusBadge(status: string, replySentiment?: string) {
  if (status === "replied") {
    if (replySentiment === "positive") return <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">Interested</Badge>;
    if (replySentiment === "do_not_contact") return <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">Do Not Contact</Badge>;
    return <Badge className="bg-slate-100 text-slate-600 border-slate-200 text-xs">Declined</Badge>;
  }
  if (status === "sent") return <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-xs">Sent</Badge>;
  if (status === "pending_approval") return <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">Awaiting approval</Badge>;
  if (status === "rejected") return <Badge className="bg-slate-100 text-slate-600 border-slate-200 text-xs">Rejected</Badge>;
  if (status === "failed") return <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">Failed</Badge>;
  return <Badge className="bg-orange-100 text-orange-700 border-orange-200 text-xs">Queued</Badge>;
}

// Renders a single sent/scheduled outreach message with its status badge.
function MessageCard({ msg, jobId }: { msg: any; jobId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(msg.subject ?? "");
  const [editBody, setEditBody] = useState(msg.body ?? "");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const isPending = msg.status === "pending_approval";

  const sendMut = useMutation({
    mutationFn: () => apiFetch(`/outreach/messages/${msg.id}/send`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toast({ title: "Message dispatched" });
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
    },
  });

  const approveMut = useMutation({
    mutationFn: () => apiFetch<any>(`/outreach/messages/${msg.id}/approve`, { method: "POST", body: "{}" }),
    onSuccess: (data: any) => {
      toast({
        title: data?.dispatched === false ? "Approved, but send failed" : "Approved & sent",
        description: data?.dispatchError || undefined,
        variant: data?.dispatched === false ? "destructive" : undefined,
      });
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
    },
  });

  const rejectMut = useMutation({
    mutationFn: (reason: string) => apiFetch<any>(`/outreach/messages/${msg.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
    onSuccess: (data: any) => {
      toast({
        title: data?.regenerated
          ? "Rejected — a new draft was generated for approval"
          : "Draft rejected — it won't be sent",
        description: data?.regenerated
          ? "Lexy rewrote the email using your feedback. Review it below."
          : undefined,
      });
      setRejectOpen(false);
      setRejectReason("");
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
    },
  });

  const editMut = useMutation({
    mutationFn: () => apiFetch(`/outreach/messages/${msg.id}`, {
      method: "PATCH",
      body: JSON.stringify({ subject: editSubject, body: editBody }),
    }),
    onSuccess: () => {
      toast({ title: "Draft updated" });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
    },
  });

  const replyMut = useMutation({
    mutationFn: (sentiment: string) => apiFetch(`/outreach/messages/${msg.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ sentiment }),
    }),
    onSuccess: (_data: any, sentiment: string) => {
      const labels: Record<string, string> = {
        positive: "Marked as Interested — advancing to Interview",
        negative: "Marked as Declined",
        do_not_contact: "Flagged as Do Not Contact",
      };
      toast({ title: labels[sentiment] || "Reply recorded" });
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      // DNC may have been set — refresh candidate counts and DNC list
      if (sentiment === "do_not_contact") {
        qc.invalidateQueries({ queryKey: ["/api/candidates"] });
        qc.invalidateQueries({ queryKey: ["dnc-list"] });
        qc.invalidateQueries({ queryKey: ["intelligence", "job", jobId] });
      }
    },
  });

  const sendFollowup = useMutation({
    mutationFn: (dayOffset: number) => apiFetch(`/outreach/messages/${msg.id}/send-followup`, {
      method: "POST",
      body: JSON.stringify({ dayOffset }),
    }),
    onSuccess: () => {
      toast({ title: "Follow-up sent" });
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
    },
  });

  const name = msg.candidate ? `${msg.candidate.firstName} ${msg.candidate.lastName}` : "Unknown";
  const initials = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
  const followUps: any[] = msg.followUpStatus || [];
  const dueFollowUps = followUps.filter((f: any) => f.status === "due");
  const isDNC = msg.candidate?.doNotContact;
  const isReplied = msg.status === "replied";

  return (
    <Card className={`border-border/60 transition-all ${isDNC ? "opacity-60" : ""}`}>
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className="font-semibold text-sm">{name}</span>
              {statusBadge(msg.status, msg.replySentiment)}
              {isDNC && (
                <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">
                  <Ban className="w-2.5 h-2.5 mr-1" />DNC
                </Badge>
              )}
              {dueFollowUps.length > 0 && (
                <Badge className="bg-orange-100 text-orange-700 border-orange-200 text-xs">
                  <AlertCircle className="w-2.5 h-2.5 mr-1" />
                  {pluralize(dueFollowUps.length, "follow-up")} due
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {msg.candidate?.currentTitle}
              {msg.candidate?.currentCompany ? ` @ ${msg.candidate.currentCompany}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {msg.sentAt && (
              <span className="text-xs text-muted-foreground hidden sm:block">
                {formatDistanceToNow(parseISO(msg.sentAt), { addSuffix: true })}
              </span>
            )}
            <Button size="sm" variant="ghost" aria-label={expanded ? "Collapse" : "Expand"} aria-expanded={expanded} className="h-7 w-7 p-0" onClick={() => setExpanded(v => !v)}>
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-2 pl-12">
          <p className="text-sm font-medium text-foreground/80 truncate">{msg.subject}</p>
        </div>

        {isPending && (
          <div className="mt-2 pl-12">
            <p className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded-md px-2.5 py-1.5 inline-flex items-center gap-1.5">
              <AlertCircle className="w-3 h-3" /> First-touch email held for your approval before it's sent.
            </p>
          </div>
        )}

        {isPending && msg.rejectedReason && (
          <div className="mt-1 pl-12">
            <p className="text-xs text-muted-foreground">Reason on file: {msg.rejectedReason}</p>
          </div>
        )}

        {expanded && (
          <div className="mt-3 pl-12 space-y-4">
            {isPending && editing ? (
              <div className="space-y-2 border border-purple-200 rounded-lg p-4 bg-purple-50/40">
                <label className="text-xs font-medium text-muted-foreground">Subject</label>
                <input
                  className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                />
                <label className="text-xs font-medium text-muted-foreground">Body</label>
                <textarea
                  className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm min-h-[160px] leading-relaxed"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                />
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" className="h-8" onClick={() => editMut.mutate()}
                    disabled={editMut.isPending || !editSubject.trim() || !editBody.trim()}>
                    {editMut.isPending ? "Saving…" : "Save changes"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8"
                    onClick={() => { setEditing(false); setEditSubject(msg.subject ?? ""); setEditBody(msg.body ?? ""); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
            <div className="bg-muted/40 rounded-lg p-4 text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed border border-border/40">
              {msg.body}
              <div className="mt-6">
                <p className="text-sm font-semibold text-foreground mb-3">Reply with one click:</p>
                <div className="flex flex-wrap gap-2" data-testid="preview-quick-reply-buttons">
                  <span className="inline-flex items-center px-4 py-2.5 rounded-md text-sm font-semibold text-white bg-green-600">Yes, I'm interested</span>
                  <span className="inline-flex items-center px-4 py-2.5 rounded-md text-sm font-semibold text-white bg-amber-500">Not for this role</span>
                  <span className="inline-flex items-center px-4 py-2.5 rounded-md text-sm font-semibold text-white bg-red-600">Don't contact me</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">Auto-appended to every outreach email at send.</p>
              </div>
            </div>
            )}

            {msg.interviewLink && (
              <a href={msg.interviewLink} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
                <ExternalLink className="w-3 h-3" /> Interview link attached
              </a>
            )}

            {followUps.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                  Automated Follow-up Sequence
                </p>
                <div className="space-y-3 border-l-2 border-border/40 pl-3">
                  {followUps.map((fu: any) => (
                    <div key={fu.dayOffset} className="flex items-start gap-2 text-xs">
                      {fu.status === "sent" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                        : fu.status === "due" ? <AlertCircle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
                        : <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-medium">Day {fu.dayOffset} follow-up</span>
                          {fu.status === "sent" && <span className="text-muted-foreground">Sent {fu.sentAt ? formatDistanceToNow(parseISO(fu.sentAt), { addSuffix: true }) : ""}</span>}
                          {fu.status === "due" && <span className="text-orange-600 font-medium">Due now</span>}
                          {fu.status === "pending" && fu.daysUntil != null && <span className="text-muted-foreground">In {fu.daysUntil}d</span>}
                        </div>
                        <p className="text-muted-foreground line-clamp-2">{fu.message}</p>
                      </div>
                      {fu.status === "due" && (
                        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 flex-shrink-0"
                          onClick={() => sendFollowup.mutate(fu.dayOffset)} disabled={sendFollowup.isPending}>
                          <Send className="w-2.5 h-2.5 mr-1" /> Send
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!isDNC && isPending && !editing && (
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/30">
                <Button size="sm" className="gap-1.5 h-8" onClick={() => approveMut.mutate()} disabled={approveMut.isPending || rejectMut.isPending}>
                  <CheckCircle2 className="w-3.5 h-3.5" />{approveMut.isPending ? "Approving…" : "Approve & Send"}
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 h-8"
                  onClick={() => { setEditSubject(msg.subject ?? ""); setEditBody(msg.body ?? ""); setEditing(true); }}
                  disabled={approveMut.isPending || rejectMut.isPending}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 h-8 text-red-700 border-red-200 hover:bg-red-50"
                  onClick={() => setRejectOpen(true)} disabled={approveMut.isPending || rejectMut.isPending}>
                  <XCircle className="w-3.5 h-3.5" />{rejectMut.isPending ? "Rejecting…" : "Reject"}
                </Button>
              </div>
            )}

            <Dialog open={rejectOpen} onOpenChange={(o) => { if (!rejectMut.isPending) { setRejectOpen(o); if (!o) setRejectReason(""); } }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Reject this draft</DialogTitle>
                  <DialogDescription>
                    Tell Lexy what was wrong — too generic, wrong tone, missed a key detail, etc.
                    Lexy will rewrite a new draft using your feedback and hold it for your approval.
                  </DialogDescription>
                </DialogHeader>
                <Textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g. Too salesy — make it shorter and mention their open-source work."
                  rows={4}
                  autoFocus
                />
                <DialogFooter>
                  <Button variant="outline" onClick={() => { setRejectOpen(false); setRejectReason(""); }} disabled={rejectMut.isPending}>
                    Cancel
                  </Button>
                  <Button
                    className="gap-1.5"
                    onClick={() => rejectMut.mutate(rejectReason.trim())}
                    disabled={rejectMut.isPending || rejectReason.trim().length === 0}>
                    <XCircle className="w-3.5 h-3.5" />
                    {rejectMut.isPending ? "Rejecting…" : "Reject & regenerate"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {!isDNC && !isPending && (
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/30">
                {msg.status === "queued" && (
                  <Button size="sm" className="gap-1.5 h-8" onClick={() => sendMut.mutate()} disabled={sendMut.isPending}>
                    <Send className="w-3.5 h-3.5" />{sendMut.isPending ? "Sending…" : "Send Now"}
                  </Button>
                )}
                {!isReplied && (
                  <>
                    <Button size="sm" variant="outline" className="gap-1.5 h-8 text-green-700 border-green-200 hover:bg-green-50"
                      onClick={() => replyMut.mutate("positive")} disabled={replyMut.isPending}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Interested
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5 h-8 text-orange-700 border-orange-200 hover:bg-orange-50"
                      onClick={() => replyMut.mutate("negative")} disabled={replyMut.isPending}>
                      <XCircle className="w-3.5 h-3.5" /> Declined
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5 h-8 text-red-700 border-red-200 hover:bg-red-50"
                      onClick={() => replyMut.mutate("do_not_contact")} disabled={replyMut.isPending}>
                      <Ban className="w-3.5 h-3.5" /> Do Not Contact
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

type Tab = "enrollments" | "messages" | "approvals" | "sequence";

// Outreach Campaign Manager page: campaign list, creation flow, and stats.
export default function OutreachPage() {
  // Allow deep-linking to a specific tab (e.g. /outreach?tab=approvals) so the
  // "View Approvals" toast from the pipeline lands the recruiter directly on the
  // approval queue instead of the default enrollments tab.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "enrollments";
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "approvals" || t === "messages" || t === "sequence" || t === "enrollments"
      ? (t as Tab)
      : "enrollments";
  });
  const [msgFilter, setMsgFilter] = useState<"all" | "pending_approval" | "queued" | "sent" | "replied">("all");
  const [enrollFilter, setEnrollFilter] = useState<"all" | "enrolled" | "active" | "replied" | "stopped">("all");
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  // Fetch all campaigns and auto-select the first one
  const { data: allCampaigns = [] } = useQuery<any[]>({
    queryKey: ["all-campaigns"],
    queryFn: () => apiFetch(`/outreach/campaigns`),
    staleTime: 60_000,
  });

  const campaigns: any[] = Array.isArray(allCampaigns) ? allCampaigns : [];
  const campaignId = selectedCampaignId || campaigns[0]?.id || "";
  const jobId = campaigns.find((c: any) => c.id === campaignId)?.jobId || "";

  // Campaign data
  const { data: campaign } = useQuery<any>({
    queryKey: ["campaign", campaignId],
    queryFn: () => campaigns.find((c: any) => c.id === campaignId) || apiFetch(`/outreach/campaigns/${campaignId}`),
    enabled: !!campaignId,
    refetchInterval: 30000,
  });

  // Enrollments
  const { data: enrollments = [], isLoading: loadingEnrollments } = useQuery<any[]>({
    queryKey: ["enrollments", campaignId],
    queryFn: () => apiFetch(`/outreach/campaigns/${campaignId}/enrollments`),
    enabled: !!campaignId,
    refetchInterval: 30000,
  });

  // Legacy messages
  const { data: msgs = [], isLoading: loadingMsgs } = useQuery<any[]>({
    queryKey: ["outreach-messages", jobId],
    queryFn: () => apiFetch(`/outreach/messages?jobId=${jobId}`),
    enabled: !!jobId,
    refetchInterval: 30000,
  });

  // Autopilot mutation
  const autopilotMut = useMutation({
    mutationFn: () => apiFetch<any>(`/outreach/campaigns/${campaignId}/autopilot`, { method: "POST", body: "{}" }),
    onSuccess: (data: any) => {
      toast({ title: `Autopilot complete — generated: ${data.generated}, sent: ${data.sent}` });
      qc.invalidateQueries({ queryKey: ["enrollments", campaignId] });
      qc.invalidateQueries({ queryKey: ["autopilot-runs", campaignId] });
    },
  });

  // Send all legacy messages
  const sendAllMut = useMutation({
    mutationFn: () => apiFetch<any>("/outreach/messages/send-all", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    }),
    onSuccess: (data: any) => {
      toast({ title: data.message || "Messages dispatched" });
      qc.invalidateQueries({ queryKey: ["outreach-messages", jobId] });
    },
  });

  const messages: any[] = Array.isArray(msgs) ? msgs : [];
  const filteredMsgs = msgFilter === "all" ? messages : messages.filter(m => m.status === msgFilter);

  const enrollmentList: any[] = Array.isArray(enrollments) ? enrollments : [];
  const filteredEnrollments = enrollFilter === "all"
    ? enrollmentList
    : enrollmentList.filter(e => e.status === enrollFilter);

  const pendingApproval = messages.filter(m => m.status === "pending_approval").length;
  const queued = messages.filter(m => m.status === "queued").length;
  const sent = messages.filter(m => m.status === "sent").length;
  const replied = messages.filter(m => m.status === "replied").length;
  const positive = messages.filter(m => m.replySentiment === "positive").length;
  const dueFollowUps = messages.reduce(
    (acc, m) => acc + ((m.followUpStatus || []).filter((f: any) => f.status === "due").length), 0
  );

  // Enrollment stats
  const eActive = enrollmentList.filter(e => e.status === "active").length;
  const eReplied = enrollmentList.filter(e => e.status === "replied").length;
  const eStopped = enrollmentList.filter(e => e.status === "stopped").length;

  return (
    <AppLayout>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <Link href="/jobs">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2 mb-2">
              <ArrowLeft className="w-4 h-4" /> Back to Jobs
            </Button>
          </Link>
          <h1 className="page-title">Outreach</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {/* Campaign selector — shown when there are multiple campaigns */}
            {campaigns.length > 1 ? (
              <select
                value={campaignId}
                onChange={e => setSelectedCampaignId(e.target.value)}
                className="text-sm bg-transparent border border-border/60 rounded-lg px-2 py-1 text-muted-foreground focus:outline-none focus:border-primary"
              >
                {campaigns.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : (
              <p className="text-muted-foreground text-sm">
                {campaigns.length === 0 ? "No campaigns yet" : campaign?.name || campaigns[0]?.name || "Loading campaign…"}
              </p>
            )}
            {campaign && (
              <Badge className={campaign.status === "active"
                ? "bg-green-100 text-green-700 text-xs"
                : "bg-slate-100 text-slate-600 text-xs"}>
                {campaign.status === "active" ? "● Active" : campaign.status}
              </Badge>
            )}
            {campaign?.autopilotEnabled && (
              <Badge className="bg-primary/10 text-primary text-xs">
                <Sparkles className="w-2.5 h-2.5 mr-1" />Autopilot ON
              </Badge>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/outreach/inbox">
            <Button variant="outline" className="gap-2">
              <Inbox className="w-4 h-4" /> Inbox
            </Button>
          </Link>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => autopilotMut.mutate()}
            disabled={autopilotMut.isPending}
          >
            {autopilotMut.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            Run Autopilot
          </Button>
          {queued > 0 && (
            <Button className="gap-2" onClick={() => sendAllMut.mutate()} disabled={sendAllMut.isPending}>
              {sendAllMut.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {sendAllMut.isPending ? "Sending…" : `Send All (${queued})`}
            </Button>
          )}
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        {[
          { label: "In Campaign", value: campaign?.enrolledCount ?? enrollmentList.length, icon: Users, color: "text-slate-600 bg-slate-50", tooltip: "Total candidates in this campaign" },
          { label: "Receiving Emails", value: eActive, icon: Play, color: "text-blue-600 bg-blue-50", tooltip: "Step 1+ sent, waiting for reply or next step" },
          { label: "Replied", value: eReplied, icon: MessageSquare, color: "text-purple-600 bg-purple-50", tooltip: "Responded to at least one email" },
          { label: "Interested", value: campaign?.positiveRepliesCount ?? positive, icon: CheckCircle2, color: "text-green-600 bg-green-50", tooltip: "Replied positively — advanced to Interview" },
          { label: "Emails Sent", value: campaign?.sentCount ?? sent, icon: Send, color: "text-cyan-600 bg-cyan-50", tooltip: "Total emails dispatched across all steps" },
          { label: "Unsubscribed", value: eStopped, icon: Ban, color: "text-red-600 bg-red-50", tooltip: "Opted out — sequence stopped" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="p-3 flex items-center gap-2">
              <div className={`p-1.5 rounded-lg ${s.color}`}>
                <s.icon className="w-3.5 h-3.5" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-xl font-bold">{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Due follow-ups banner */}
      {dueFollowUps > 0 && (
        <div className="mb-4 flex items-center gap-2 p-3 rounded-lg bg-orange-50 border border-orange-200 text-sm text-orange-800">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            <strong>{dueFollowUps}</strong> follow-up{dueFollowUps > 1 ? "s" : ""} overdue — expand a message card below to send.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-border/40 pb-0">
        {([
          { id: "enrollments", label: "Enrollments", count: enrollmentList.length, icon: Users },
          { id: "messages", label: "Messages", count: messages.length, icon: Mail },
          { id: "approvals", label: "Approvals", icon: Sparkles },
          { id: "sequence", label: "Sequence", icon: Zap },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {"count" in t && t.count != null && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.id ? "bg-primary/10" : "bg-muted"}`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "enrollments" && (
        <div>
          <div className="flex gap-2 mb-4 flex-wrap">
            {([
              { value: "all",      label: "All" },
              { value: "enrolled", label: "Pending (not sent yet)" },
              { value: "active",   label: "Receiving Emails" },
              { value: "replied",  label: "Replied" },
              { value: "stopped",  label: "Unsubscribed" },
            ] as const).map(f => (
              <Button key={f.value} size="sm" variant={enrollFilter === f.value ? "default" : "outline"}
                className="h-8" onClick={() => setEnrollFilter(f.value)}>
                {f.label}
                {f.value !== "all" && (
                  <span className="ml-1.5 opacity-70 text-xs">
                    {enrollmentList.filter(e => e.status === f.value).length}
                  </span>
                )}
              </Button>
            ))}
          </div>
          {loadingEnrollments ? (
            <div className="text-center py-16 text-muted-foreground">Loading enrollments…</div>
          ) : filteredEnrollments.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <Users className="w-12 h-12 text-muted-foreground/40 mx-auto" />
              <p className="text-muted-foreground">No enrollments yet.</p>
              <p className="text-xs text-muted-foreground">
                Candidates move to this campaign automatically when they reach the Outreach stage in the pipeline.
                Click <strong>Run Autopilot</strong> to generate and send messages for enrolled candidates.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredEnrollments.map(e => <EnrollmentCard key={e.id} enrollment={e} campaignId={campaignId} />)}
            </div>
          )}
        </div>
      )}

      {tab === "messages" && (
        <div>
          <div className="flex gap-2 mb-4 flex-wrap">
            {([
              { value: "all", label: "All" },
              { value: "pending_approval", label: "Awaiting approval" },
              { value: "queued", label: "Queued" },
              { value: "sent", label: "Sent" },
              { value: "replied", label: "Replied" },
            ] as const).map(f => (
              <Button key={f.value} size="sm" variant={msgFilter === f.value ? "default" : "outline"}
                className="h-8" onClick={() => setMsgFilter(f.value)}>
                {f.label}
                {f.value !== "all" && (
                  <span className="ml-1.5 opacity-70 text-xs">
                    {messages.filter(m => m.status === f.value).length}
                  </span>
                )}
              </Button>
            ))}
          </div>
          {loadingMsgs ? (
            <div className="text-center py-16 text-muted-foreground">Loading messages…</div>
          ) : filteredMsgs.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">No {msgFilter === "pending_approval" ? "messages awaiting approval" : msgFilter !== "all" ? msgFilter + " messages" : "messages"} found.</div>
          ) : (
            <div className="space-y-3">
              {filteredMsgs.map(msg => <MessageCard key={msg.id} msg={msg} jobId={jobId} />)}
            </div>
          )}
        </div>
      )}

      {tab === "approvals" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">
              One queue for every pending draft — cold outreach and AI-generated messages. Nothing sends without your approval.
            </p>
            <GenerateMessageDialog jobId={jobId || undefined} />
          </div>
          <UnifiedApprovalQueue />
        </div>
      )}

      {tab === "sequence" && (
        <div className="max-w-2xl">
          <SequenceView campaignId={campaignId} />
        </div>
      )}
    </AppLayout>
  );
}
