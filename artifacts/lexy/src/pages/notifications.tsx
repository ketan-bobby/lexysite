/**
 * pages/notifications.tsx — Recruiter Notification Centre
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Full-page notification centre for recruiter-role users (separate from the
 * portal/notifications.tsx page which serves candidates). Lists all unread and
 * read notifications with timestamps, mark-as-read, and action CTAs.
 *
 * ─── Notification types handled ──────────────────────────────────────────────
 *   interview_completed   — "View Report" button → /recruiter/interviews/:id
 *   ghosting_alert        — "View Alert" button → /recruiter/anti-ghost
 *   digest_sent           — informational; no CTA
 *   screening_complete    — "View Candidates" → /recruiter/candidates
 *   decision_required     — "Review Decision" → /recruiter/decision-queue
 *   reply_received        — "View Inbox" → /recruiter/outreach/inbox
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   GET  /api/user-notifications          — list (last 50)
 *   POST /api/user-notifications/:id/read — mark one read
 *   POST /api/user-notifications/read-all — mark all read
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /notifications  (shared route — AppLayout picks the right nav based on role)
 */
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bell, Check, Loader2, Video, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { apiFetch, apiBase } from "@/lib/api";
import { format, parseISO } from "date-fns";

const BASE = (import.meta as any).env?.BASE_URL || "/";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  actionUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

export default function StaffNotifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const r = await apiFetch(`${apiBase}/user-notifications`);
      const data = await r.json();
      setItems(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function markRead(id: string) {
    await apiFetch(`${apiBase}/user-notifications/${id}/read`, { method: "POST" });
    setItems(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
  }

  async function markAllRead() {
    await apiFetch(`${apiBase}/user-notifications/read-all`, { method: "POST" });
    setItems(prev => prev.map(n => ({ ...n, isRead: true })));
  }

  const unread = items.filter(n => !n.isRead).length;

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Notifications</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {unread > 0 ? `${unread} unread` : "You're all caught up."}
            </p>
          </div>
          {unread > 0 && (
            <Button onClick={markAllRead} variant="outline" size="sm" className="gap-2">
              <Check className="w-4 h-4" /> Mark all as read
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              <Bell className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="font-medium">No notifications yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {items.map(n => {
              const Icon = n.type.startsWith("interview") ? Video : Bell;
              const Wrap: any = n.actionUrl ? Link : "div";
              const wrapProps: any = n.actionUrl ? { href: n.actionUrl.replace(/^\//, BASE) } : {};
              return (
                <Wrap key={n.id} {...wrapProps} onClick={() => !n.isRead && markRead(n.id)}>
                  <Card className={`transition-colors hover:border-border/80 cursor-pointer ${!n.isRead ? "border-primary/30 bg-primary/[0.03]" : ""}`}>
                    <CardContent className="p-4 flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${!n.isRead ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{n.title}</p>
                          {!n.isRead && <span className="w-2 h-2 rounded-full bg-primary" />}
                        </div>
                        {n.message && <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>}
                        <p className="text-[11px] text-muted-foreground/70 mt-1">
                          {format(parseISO(n.createdAt), "MMM d, h:mm a")}
                        </p>
                      </div>
                      {n.actionUrl && <ArrowRight className="w-4 h-4 text-muted-foreground self-center" />}
                    </CardContent>
                  </Card>
                </Wrap>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
