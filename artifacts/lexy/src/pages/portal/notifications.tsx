/**
 * notifications.tsx — Candidate portal notifications page.
 *
 * Fetches real notifications from the API using the authenticated apiFetch
 * helper (Bearer demo_token_<userId>). Shows an empty state when there are
 * no notifications — never falls back to hard-coded mock data.
 */

import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { apiBase, apiFetch } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, Calendar, MessageSquare, Award, Briefcase, CheckCheck, BellOff, Loader2 } from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

/* ─── Icon + colour config per notification type ────────────────────────── */

const typeConfig: Record<string, { icon: any; color: string; bg: string }> = {
  interview_scheduled: { icon: Calendar,      color: "text-blue-600",   bg: "bg-blue-100"    },
  message:            { icon: MessageSquare,  color: "text-primary",    bg: "bg-primary/10"  },
  stage_update:       { icon: Briefcase,      color: "text-orange-600", bg: "bg-orange-100"  },
  prep_reminder:      { icon: Bell,           color: "text-yellow-600", bg: "bg-yellow-100"  },
  offer:              { icon: Award,          color: "text-green-600",  bg: "bg-green-100"   },
};

/* ─── Notification type returned by the API ─────────────────────────────── */
interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;       /* API returns "message", not "body" */
  isRead: boolean;
  actionUrl?: string | null;
  createdAt: string;
}

/* ─── Page component ────────────────────────────────────────────────────── */

export default function PortalNotifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Fetch real notifications from the API on mount */
  useEffect(() => {
    apiFetch(`${apiBase}/portal/notifications`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: any[]) => {
        setItems(
          data.map(n => ({
            id: n.id,
            type: n.type ?? "message",
            title: n.title ?? "Notification",
            message: n.message ?? n.body ?? "",
            isRead: n.isRead ?? n.is_read ?? false,
            actionUrl: n.actionUrl ?? n.action_url ?? null,
            createdAt: n.createdAt ?? n.created_at,
          }))
        );
      })
      .catch(err => {
        console.error("[notifications] fetch failed:", err);
        setError("Could not load notifications. Please try again later.");
      })
      .finally(() => setLoading(false));
  }, []);

  const unread = items.filter(n => !n.isRead).length;

  function markRead(id: string) {
    setItems(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
  }

  function markAllRead() {
    setItems(prev => prev.map(n => ({ ...n, isRead: true })));
  }

  return (
    <AppLayout>
      {/* Page header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            Notifications
            {unread > 0 && (
              <Badge className="bg-primary text-white">{unread} unread</Badge>
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Stay up to date with your application activity.
          </p>
        </div>

        {unread > 0 && (
          <Button variant="outline" className="gap-2" onClick={markAllRead}>
            <CheckCheck className="w-4 h-4" /> Mark All Read
          </Button>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-24 text-muted-foreground gap-3">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading notifications…</span>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
          <BellOff className="w-10 h-10 text-muted-foreground/50" />
          <p className="text-muted-foreground">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
          <div className="p-5 rounded-2xl bg-muted/40">
            <BellOff className="w-10 h-10 text-muted-foreground/50" />
          </div>
          <div>
            <p className="font-semibold text-foreground">You're all caught up</p>
            <p className="text-sm text-muted-foreground mt-1">
              Notifications about interviews, applications, and messages will appear here.
            </p>
          </div>
        </div>
      )}

      {/* Notification list */}
      {!loading && !error && items.length > 0 && (
        <div className="space-y-2">
          {items.map(n => {
            const cfg = typeConfig[n.type] ?? typeConfig.message;
            const Icon = cfg.icon;

            return (
              <Card
                key={n.id}
                onClick={() => markRead(n.id)}
                className={`hover-elevate cursor-pointer transition-all ${
                  !n.isRead ? "border-primary/30 bg-primary/2" : "border-border/50"
                }`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Type icon */}
                    <div className={`p-2.5 rounded-xl flex-shrink-0 ${cfg.bg}`}>
                      <Icon className={`w-5 h-5 ${cfg.color}`} />
                    </div>

                    {/* Title + body */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className={`font-semibold text-sm ${!n.isRead ? "text-foreground" : "text-muted-foreground"}`}>
                          {n.title}
                        </p>
                        {!n.isRead && (
                          <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed">{n.message}</p>
                    </div>

                    {/* Relative timestamp */}
                    <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap">
                      {formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
