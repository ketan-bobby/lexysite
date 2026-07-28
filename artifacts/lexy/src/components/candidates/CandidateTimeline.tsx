/**
 * CandidateTimeline — chronological event log for a candidate.
 * Renders all candidate_events rows (newest first) with an icon, label,
 * timestamp, actor badge, and optional metadata expansion.
 */
import { authHeaders } from "@/lib/api";
import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  UserPlus, Briefcase, Mail, MailOpen, MessageSquare, Video,
  PlayCircle, CheckCircle2, Star, ThumbsUp, Send, Users,
  CalendarCheck, Trophy, Gift, XCircle, MinusCircle,
  Award, Rocket, AlertCircle, Clock,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface CandidateEvent {
  eventId:        string;
  eventType:      string;
  eventTimestamp: string;
  actorType:      string | null;
  actorId:        string | null;
  source:         string | null;
  applicationId:  string | null;
  metadataJson:   Record<string, unknown> | null;
  jobId:          string;
}

const EVENT_META: Record<string, { label: string; icon: React.FC<any>; color: string }> = {
  CANDIDATE_CREATED:                  { label: "Candidate Added",              icon: UserPlus,      color: "text-blue-500" },
  JOB_MATCHED:                        { label: "Matched to Job",               icon: Briefcase,     color: "text-indigo-500" },
  OUTREACH_SENT:                      { label: "Outreach Sent",                icon: Mail,          color: "text-cyan-500" },
  OUTREACH_OPENED:                    { label: "Email Opened",                 icon: MailOpen,      color: "text-sky-500" },
  OUTREACH_REPLIED:                   { label: "Reply Received",               icon: MessageSquare, color: "text-teal-500" },
  INTERVIEW_INVITED:                  { label: "Interview Invited",            icon: CalendarCheck, color: "text-purple-500" },
  INTERVIEW_STARTED:                  { label: "Interview Started",            icon: PlayCircle,    color: "text-violet-500" },
  INTERVIEW_COMPLETED:                { label: "Interview Completed",          icon: Video,         color: "text-fuchsia-500" },
  INTERVIEW_SCORE_GENERATED:          { label: "AI Score Generated",           icon: Star,          color: "text-yellow-500" },
  RECRUITER_REVIEWED:                 { label: "Recruiter Reviewed",           icon: ThumbsUp,      color: "text-emerald-500" },
  RECRUITER_SHORTLISTED:              { label: "Shortlisted",                  icon: CheckCircle2,  color: "text-green-500" },
  SUBMITTED_TO_HIRING_MANAGER:        { label: "Sent to Hiring Manager",       icon: Send,          color: "text-lime-600" },
  HIRING_MANAGER_INTERVIEW_SCHEDULED: { label: "HM Interview Scheduled",       icon: CalendarCheck, color: "text-orange-500" },
  HIRING_MANAGER_INTERVIEW_COMPLETED: { label: "HM Interview Completed",       icon: Users,         color: "text-amber-600" },
  OFFER_RECOMMENDED:                  { label: "Offer Recommended",            icon: Award,         color: "text-amber-500" },
  OFFER_EXTENDED:                     { label: "Offer Extended",               icon: Gift,          color: "text-orange-600" },
  OFFER_ACCEPTED:                     { label: "Offer Accepted",               icon: Trophy,        color: "text-green-600" },
  OFFER_DECLINED:                     { label: "Offer Declined",               icon: XCircle,       color: "text-red-400" },
  HIRED:                              { label: "Hired",                        icon: Rocket,        color: "text-green-700" },
  STARTED:                            { label: "Started",                      icon: Rocket,        color: "text-emerald-700" },
  REJECTED:                           { label: "Rejected",                     icon: XCircle,       color: "text-red-500" },
  WITHDRAWN:                          { label: "Withdrawn",                    icon: MinusCircle,   color: "text-slate-400" },
};

const ACTOR_LABELS: Record<string, string> = {
  candidate: "Candidate",
  recruiter: "Recruiter",
  hiring_manager: "Hiring Manager",
  admin: "Admin",
  system: "System",
  integration: "Integration",
};

const SOURCE_LABELS: Record<string, string> = {
  lexy_app: "Lexy App",
  email: "Email",
  sms: "SMS",
  calendar: "Calendar",
  interview_agent: "Interview AI",
  recruiter_action: "Recruiter",
  admin_action: "Admin",
};

function formatTimestamp(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffH < 24 * 7) return d.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function MetadataRow({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="font-medium text-foreground truncate">{String(value)}</span>
    </div>
  );
}

function EventRow({ event }: { event: CandidateEvent }) {
  const [expanded, setExpanded] = useState(false);
  const meta = EVENT_META[event.eventType] ?? {
    label: event.eventType.replace(/_/g, " "),
    icon: AlertCircle,
    color: "text-muted-foreground",
  };
  const Icon = meta.icon;
  const actorLabel = event.actorType ? (ACTOR_LABELS[event.actorType] ?? event.actorType) : null;
  const sourceLabel = event.source ? (SOURCE_LABELS[event.source] ?? event.source) : null;
  const md = event.metadataJson;

  return (
    <div className="flex gap-3 group">
      {/* icon + vertical line */}
      <div className="flex flex-col items-center gap-1">
        <div className={cn("w-8 h-8 rounded-full bg-background border-2 border-border flex items-center justify-center shrink-0", meta.color)}>
          <Icon size={14} />
        </div>
        <div className="w-px flex-1 bg-border group-last:hidden" />
      </div>

      {/* content */}
      <div className="pb-5 flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{meta.label}</span>
            {actorLabel && (
              <Badge variant="outline" className="text-xs h-5 px-1.5 font-normal">
                {actorLabel}
              </Badge>
            )}
            {sourceLabel && sourceLabel !== actorLabel && (
              <Badge variant="secondary" className="text-xs h-5 px-1.5 font-normal">
                {sourceLabel}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Clock size={11} />
            <time dateTime={event.eventTimestamp} title={new Date(event.eventTimestamp).toLocaleString()}>
              {formatTimestamp(event.eventTimestamp)}
            </time>
          </div>
        </div>

        {/* metadata */}
        {md && Object.keys(md).length > 0 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Hide details ▲" : "Show details ▼"}
          </button>
        )}
        {expanded && md && (
          <div className="mt-2 p-2.5 rounded-lg bg-muted/50 space-y-1">
            {Object.entries(md).map(([k, v]) => (
              <MetadataRow key={k} label={k} value={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CandidateTimeline({
  candidateId,
}: {
  candidateId: string;
}) {
  const [events, setEvents] = useState<CandidateEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!candidateId) return;
    setLoading(true);
    setError(null);
    fetch(`${BASE}/api/candidates/${candidateId}/events`, {
      credentials: "include",
      headers: { ...authHeaders() },
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: CandidateEvent[]) => setEvents([...data].reverse()))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [candidateId]);

  if (loading) {
    return (
      <div className="space-y-4 p-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="w-8 h-8 rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5 pt-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
        <AlertCircle size={20} />
        <p className="text-sm">Failed to load timeline: {error}</p>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
        <Clock size={20} />
        <p className="text-sm">No events recorded yet.</p>
        <p className="text-xs">Events are logged as this candidate moves through your hiring pipeline.</p>
      </div>
    );
  }

  return (
    <div className="space-y-0 py-1">
      {events.map(ev => (
        <EventRow key={ev.eventId} event={ev} />
      ))}
    </div>
  );
}
