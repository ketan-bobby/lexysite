/**
 * pages/recruiter/outreach/inbox.tsx — Recruiter Reply Inbox
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The recruiter inbox for inbound candidate email replies. Shows all replies
 * that have been parsed by the inbound email webhook, classified by the
 * Conversation Agent, and optionally have an AI draft ready to approve.
 *
 * ─── Message states ──────────────────────────────────────────────────────────
 *   needs_review   — AI drafted a reply but it requires recruiter approval
 *                    before sending. Shows the draft body + "Approve" /
 *                    "Edit" / "Discard" buttons.
 *   interested     — candidate replied positively; no AI draft needed.
 *                    Shows "Schedule Interview" CTA.
 *   not_interested — candidate is not interested. Shows info badge.
 *   dnc            — candidate opted out; DNC flag applied automatically.
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetRecruiterInbox()        — GET /api/outreach/inbox (recruiter_inbox rows)
 *   GET /api/conversation-drafts/pending — AI drafts awaiting approval
 *   POST /api/conversation-drafts/:id/approve — send a draft
 *   POST /api/conversation-drafts/:id/discard — discard a draft
 *
 * ─── Auto-refresh ────────────────────────────────────────────────────────────
 * Uses useEffect + setInterval to poll every 30 s so new replies appear
 * without a page refresh. Invalidates the query key on mount and on each poll.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/outreach/inbox
 */
import { useEffect, useState } from "react";
import { pluralize } from "@/lib/utils";
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGetRecruiterInbox,
  getGetRecruiterInboxQueryKey,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatDistanceToNow, parseISO } from "date-fns";
import {
  Search, Mail, ThumbsUp, HelpCircle, AlertTriangle,
  Reply, ChevronDown, ChevronRight, Briefcase, Star,
  MessageSquare, Filter, Loader2, Send,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────────────────────── */
interface InboxAttachment {
  cid: string;
  url: string;
  filename?: string;
  contentType?: string;
}

interface InboxMessage {
  id: string;
  type: string;
  candidateId?: string;
  candidate?: { id?: string; firstName?: string; lastName?: string; currentTitle?: string; email?: string } | null;
  candidateName?: string;
  subject: string;
  preview: string;
  body?: string | null;
  attachments?: InboxAttachment[] | null;
  receivedAt: string;
  isRead: boolean;
  starred?: boolean;
  job?: { id: string; title: string } | null;
  jobTitle?: string;
}

/**
 * Render an email body, substituting any `[cid:xxx]` tokens with the matching
 * inline attachment as an <img>. Falls back to a small "📎 inline image" chip
 * for tokens without a matching attachment, so the body never shows a raw
 * `[cid:...]` string to the recruiter.
 *
 * Email bodies are plain text (we do not store HTML), so we render text
 * segments inside React nodes — no HTML injection possible.
 */
function renderBodyWithInlineImages(
  body: string,
  attachments: InboxAttachment[] | null | undefined,
): React.ReactNode[] {
  const cidMap = new Map<string, InboxAttachment>();
  // Defensive: attachments is JSONB and may contain malformed entries.
  // Skip anything that isn't a usable {cid, url} pair so a bad row never
  // crashes the dialog with a TypeError on a.cid.toLowerCase().
  for (const a of attachments ?? []) {
    if (!a || typeof a.cid !== "string" || typeof a.url !== "string") continue;
    cidMap.set(a.cid.toLowerCase(), a);
  }

  const parts: React.ReactNode[] = [];
  const re = /\[cid:([^\]\s]+)\]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    const cid = match[1].toLowerCase();
    const att = cidMap.get(cid);
    if (att) {
      parts.push(
        <img
          key={`img-${key++}`}
          src={att.url}
          alt={att.filename || "inline image"}
          className="my-2 max-w-full max-h-64 inline-block rounded border border-border/40"
        />,
      );
    } else {
      parts.push(
        <span
          key={`chip-${key++}`}
          className="inline-flex items-center gap-1 mx-0.5 rounded border border-border/40 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground align-middle"
          title={`Inline image (cid:${match[1]}) — attachment not captured`}
        >
          📎 inline image
        </span>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}

/* ── Config ─────────────────────────────────────────────────────────────────── */
const typeConfig: Record<string, { label: string; dot: string; icon: any; pill: string }> = {
  positive_reply:  { label: "Positive Reply",  dot: "bg-emerald-400",  icon: ThumbsUp,       pill: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  question:        { label: "Question",         dot: "bg-blue-400",     icon: HelpCircle,     pill: "bg-blue-50 text-blue-700 border-blue-200" },
  needs_followup:  { label: "Needs Follow-up",  dot: "bg-orange-400",   icon: AlertTriangle,  pill: "bg-orange-50 text-orange-700 border-orange-200" },
  negative_reply:  { label: "Negative Reply",   dot: "bg-red-400",      icon: Mail,           pill: "bg-red-50 text-red-700 border-red-200" },
  out_of_office:   { label: "Out of Office",    dot: "bg-slate-400",    icon: Mail,           pill: "bg-slate-50 text-slate-600 border-slate-200" },
};

type FilterType = "all" | "positive_reply" | "needs_followup" | "question";

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function candidateLabel(msg: InboxMessage): string {
  if (msg.candidateName) return msg.candidateName;
  if (msg.candidate) return `${msg.candidate.firstName ?? ""} ${msg.candidate.lastName ?? ""}`.trim() || "Candidate";
  return "Candidate";
}

function jobLabel(msg: InboxMessage): string {
  return msg.job?.title ?? msg.jobTitle ?? "Unassigned";
}

function jobId(msg: InboxMessage): string {
  return msg.job?.id ?? msg.jobTitle ?? "unassigned";
}

/* ── Message row ────────────────────────────────────────────────────────────── */
// Compact list row for one inbound reply: candidate/job labels, sentiment pill,
// and Reply/View actions.
function MessageRow({
  msg,
  onReply,
  onView,
}: {
  msg: InboxMessage;
  onReply: (m: InboxMessage) => void;
  onView: (m: InboxMessage) => void;
}) {
  const cfg = typeConfig[msg.type] ?? typeConfig.question;
  const Icon = cfg.icon;
  const name = candidateLabel(msg);
  const initials = name.split(" ").map(n => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onView(msg)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onView(msg);
        }
      }}
      aria-label={`View message from ${name}: ${msg.subject}`}
      className={`flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors group rounded-lg cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${!msg.isRead ? "bg-primary/3" : ""}`}
    >
      {/* Avatar */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${!msg.isRead ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
        {initials || "?"}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className={`text-sm font-semibold truncate max-w-[140px] ${!msg.isRead ? "text-foreground" : "text-muted-foreground"}`}>
            {name}
          </span>
          <Badge className={`text-[9px] border px-1.5 py-0 h-4 ${cfg.pill} flex items-center gap-0.5`}>
            <Icon className="w-2 h-2" />
            {cfg.label}
          </Badge>
          {msg.starred && <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />}
          {!msg.isRead && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
        </div>
        <p className={`text-xs font-medium truncate ${!msg.isRead ? "text-foreground/80" : "text-muted-foreground"}`}>{msg.subject}</p>
        <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">{msg.preview}</p>
      </div>

      {/* Right */}
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
          {formatDistanceToNow(parseISO(msg.receivedAt), { addSuffix: true })}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => { e.stopPropagation(); onReply(msg); }}
          className="gap-1 h-6 text-[10px] px-2 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Reply className="w-2.5 h-2.5" /> Reply
        </Button>
      </div>
    </div>
  );
}

/* ── Reply Dialog ────────────────────────────────────────────────────────────── */
// Modal for composing/approving a reply to an inbound message (AI draft editable).
function ReplyDialog({
  msg,
  open,
  onOpenChange,
}: {
  msg: InboxMessage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");

  // Reset the compose form every time the dialog opens (whether it's a
  // new message or the same one reopened). We deliberately do not
  // persist drafts across closes — recruiters expect a clean slate.
  useEffect(() => {
    if (open && msg) {
      setBody("");
      setSubject(msg.subject.toLowerCase().startsWith("re:") ? msg.subject : `Re: ${msg.subject}`);
    }
  }, [open, msg?.id]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!msg) throw new Error("No message selected");
      const res = await fetch(`/api/outreach/inbox/${encodeURIComponent(msg.id)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({ subject: subject.trim() || undefined, body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `Send failed (${res.status})`);
      }
      return res.json() as Promise<{ ok: boolean; simulated: boolean; messageId: string | null }>;
    },
    onSuccess: (result) => {
      toast.success(
        result.simulated
          ? "Reply queued (simulated — set SES_FROM_EMAIL + AWS creds for real delivery)"
          : "Reply sent",
      );
      queryClient.invalidateQueries({ queryKey: getGetRecruiterInboxQueryKey() });
      onOpenChange(false);
      setBody("");
    },
    onError: (err: any) => {
      toast.error(err?.message ?? "Failed to send reply");
    },
  });

  const candName = msg ? candidateLabel(msg) : "";
  const candEmail = msg?.candidate?.email ?? "candidate";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sendMutation.isPending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Reply className="w-4 h-4" />
            Reply to {candName}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Sending to <span className="font-medium">{candEmail}</span>
            {msg?.job?.title && <> · {msg.job.title}</>}
          </DialogDescription>
        </DialogHeader>

        {msg && (
          <div className="rounded-md bg-muted/40 border border-border/40 p-3 text-xs max-h-32 overflow-y-auto">
            <div className="font-medium text-foreground/80 mb-1">{msg.subject}</div>
            <div className="text-muted-foreground whitespace-pre-wrap">{msg.preview}</div>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium">Subject</label>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Re: ..."
            disabled={sendMutation.isPending}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium">Message</label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type your reply..."
            rows={8}
            disabled={sendMutation.isPending}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sendMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !body.trim()}
            className="gap-1"
          >
            {sendMutation.isPending
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending</>
              : <><Send className="w-3.5 h-3.5" /> Send reply</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── View Message Dialog ─────────────────────────────────────────────────────── */
// Read-only modal showing the full original message body (with inline images).
function ViewMessageDialog({
  msg,
  open,
  onOpenChange,
  onReply,
}: {
  msg: InboxMessage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReply: () => void;
}) {
  if (!msg) return null;
  const cfg = typeConfig[msg.type] ?? typeConfig.question;
  const Icon = cfg.icon;
  const name = candidateLabel(msg);
  const candEmail = msg.candidate?.email ?? null;
  // Prefer the full body, fall back to the preview if the row predates body capture.
  const fullBody = msg.body && msg.body.trim() ? msg.body : msg.preview;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base flex items-center gap-2 mb-1">
                {msg.subject}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Badge className={`text-[10px] border px-1.5 py-0 h-4 ${cfg.pill} flex items-center gap-1`}>
                    <Icon className="w-2.5 h-2.5" />
                    {cfg.label}
                  </Badge>
                  <span className="text-foreground/70 font-medium">From: {name}</span>
                  {candEmail && <span className="text-muted-foreground">&lt;{candEmail}&gt;</span>}
                  {msg.job?.title && <span className="text-muted-foreground">· {msg.job.title}</span>}
                  <span className="text-muted-foreground">
                    · {formatDistanceToNow(parseISO(msg.receivedAt), { addSuffix: true })}
                  </span>
                </div>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto rounded-md bg-muted/30 border border-border/40 p-4 text-sm whitespace-pre-wrap leading-relaxed text-foreground/90">
          {renderBodyWithInlineImages(fullBody, msg.attachments)}
        </div>

        {(!msg.body || !msg.body.trim()) && (
          <p className="text-[11px] text-muted-foreground/70 italic">
            Showing the preview snippet — full message body wasn't captured for this older inbox item.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onReply} className="gap-1">
            <Reply className="w-3.5 h-3.5" /> Reply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Job Group (accordion section) ──────────────────────────────────────────── */
interface JobGroup {
  jobId: string;
  jobTitle: string;
  messages: InboxMessage[];
}

// Groups inbound replies under their associated job for the grouped inbox view.
function JobGroupCard({
  group, defaultOpen, onReply, onView,
}: {
  group: JobGroup;
  defaultOpen: boolean;
  onReply: (m: InboxMessage) => void;
  onView: (m: InboxMessage) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const unread = group.messages.filter(m => !m.isRead).length;
  const byType = group.messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.type] = (acc[m.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card className={`border-border/50 overflow-hidden transition-all ${open ? "border-primary/20" : "hover:border-border"}`}>
      {/* Job header — click to expand/collapse */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
      >
        {/* Icon */}
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${open ? "bg-primary/10" : "bg-muted/50"}`}>
          <Briefcase className={`w-4 h-4 ${open ? "text-primary" : "text-muted-foreground"}`} />
        </div>

        {/* Title + stats */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-foreground truncate">{group.jobTitle}</span>
            {unread > 0 && (
              <Badge className="bg-primary text-white text-[10px] h-4 px-1.5">{unread} new</Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {pluralize(group.messages.length, "message")}
            </span>
            {Object.entries(byType).map(([type, count]) => {
              const cfg = typeConfig[type];
              if (!cfg) return null;
              return (
                <span key={type} className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} inline-block`} />
                  {count} {cfg.label.toLowerCase()}
                </span>
              );
            })}
          </div>
        </div>

        {/* Chevron */}
        <div className="shrink-0">
          {open
            ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
            : <ChevronRight className="w-4 h-4 text-muted-foreground" />
          }
        </div>
      </button>

      {/* Messages */}
      {open && (
        <div className="border-t border-border/40 divide-y divide-border/20">
          {group.messages.map(msg => (
            <MessageRow key={msg.id} msg={msg} onReply={onReply} onView={onView} />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ── Main page ──────────────────────────────────────────────────────────────── */
// Recruiter reply inbox page: polls for inbound replies, groups them by job,
// and surfaces AI drafts awaiting approval.
export default function OutreachInbox() {
  // Poll every 15s + refetch on tab focus so server-driven events
  // (candidate email replies, inbound webhook classifications) appear without a manual refresh.
  const { data } = useGetRecruiterInbox({
    query: { queryKey: getGetRecruiterInboxQueryKey(), refetchInterval: 15_000, refetchOnWindowFocus: true },
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [replyMsg, setReplyMsg] = useState<InboxMessage | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [viewMsg, setViewMsg] = useState<InboxMessage | null>(null);
  const [viewOpen, setViewOpen] = useState(false);

  const handleReply = (m: InboxMessage) => {
    setReplyMsg(m);
    setReplyOpen(true);
  };

  const handleView = (m: InboxMessage) => {
    setViewMsg(m);
    setViewOpen(true);
  };

  const handleReplyFromView = () => {
    if (viewMsg) {
      setViewOpen(false);
      setReplyMsg(viewMsg);
      setReplyOpen(true);
    }
  };

  const raw: InboxMessage[] = (data as any)?.length
    ? (data as any)
    : (data as any)?.messages?.length
      ? (data as any).messages
      : [];

  // Apply filter + search
  const filtered = raw.filter(m => {
    if (filter !== "all" && m.type !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = candidateLabel(m).toLowerCase();
      const label = jobLabel(m).toLowerCase();
      return name.includes(q) || m.subject.toLowerCase().includes(q) || label.includes(q);
    }
    return true;
  });

  // Group by job
  const groupMap = new Map<string, JobGroup>();
  filtered.forEach(msg => {
    const key = jobId(msg);
    const title = jobLabel(msg);
    if (!groupMap.has(key)) groupMap.set(key, { jobId: key, jobTitle: title, messages: [] });
    groupMap.get(key)!.messages.push(msg);
  });

  // Sort groups: unread groups first, then by most recent message
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    const aUnread = a.messages.filter(m => !m.isRead).length;
    const bUnread = b.messages.filter(m => !m.isRead).length;
    if (bUnread !== aUnread) return bUnread - aUnread;
    const aLatest = Math.max(...a.messages.map(m => new Date(m.receivedAt).getTime()));
    const bLatest = Math.max(...b.messages.map(m => new Date(m.receivedAt).getTime()));
    return bLatest - aLatest;
  });

  const totalUnread = raw.filter(m => !m.isRead).length;

  const filterButtons: { key: FilterType; label: string; icon: any; active: string }[] = [
    { key: "all",            label: "All",           icon: Mail,           active: "bg-primary/10 text-primary border-primary/30" },
    { key: "positive_reply", label: "Positive",      icon: ThumbsUp,       active: "bg-emerald-50 text-emerald-700 border-emerald-300" },
    { key: "needs_followup", label: "Follow-up",     icon: AlertTriangle,  active: "bg-orange-50 text-orange-700 border-orange-300" },
    { key: "question",       label: "Questions",     icon: HelpCircle,     active: "bg-blue-50 text-blue-700 border-blue-300" },
  ];

  return (
    <AppLayout>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title flex items-center gap-3">
            Recruiter Inbox
            {totalUnread > 0 && (
              <Badge className="bg-primary text-white">{totalUnread} new</Badge>
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Candidate replies grouped by work order — {pluralize(groups.length, "active job")}, {pluralize(raw.length, "message")} total.
          </p>
        </div>
        <Button variant="outline" className="gap-2">
          <Mail className="w-4 h-4" /> Mark All Read
        </Button>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap gap-2 mb-6">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by candidate, job..."
            className="pl-9 h-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 ml-1">
          <Filter className="w-3.5 h-3.5 text-muted-foreground" />
          {filterButtons.map(fb => {
            const Icon = fb.icon;
            const isActive = filter === fb.key;
            return (
              <Button
                key={fb.key}
                size="sm"
                variant="outline"
                onClick={() => setFilter(fb.key)}
                className={`gap-1.5 h-8 text-xs transition-all ${isActive ? fb.active : "text-muted-foreground"}`}
              >
                <Icon className="w-3 h-3" />
                {fb.label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Grouped view */}
      {groups.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Mail className="w-10 h-10 text-muted-foreground/30" />
            <p className="font-medium text-muted-foreground">No messages{filter !== "all" ? " matching this filter" : ""}</p>
            <p className="text-sm text-muted-foreground/60">Candidate replies from outreach campaigns will appear here, grouped by role.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group, i) => (
            <JobGroupCard
              key={group.jobId}
              group={group}
              defaultOpen={i === 0}
              onReply={handleReply}
              onView={handleView}
            />
          ))}
        </div>
      )}

      <ViewMessageDialog
        msg={viewMsg}
        open={viewOpen}
        onOpenChange={setViewOpen}
        onReply={handleReplyFromView}
      />

      <ReplyDialog
        msg={replyMsg}
        open={replyOpen}
        onOpenChange={setReplyOpen}
      />
    </AppLayout>
  );
}
