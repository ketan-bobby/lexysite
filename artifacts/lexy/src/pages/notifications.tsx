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
 *   GET  /api/user-notifications          — cursor-paginated history (50 per page)
 *   POST /api/user-notifications/:id/read — mark one read
 *   POST /api/user-notifications/read-all — mark all read
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /notifications  (shared route — AppLayout picks the right nav based on role)
 */
import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bell, Check, Loader2, Video, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { apiFetch, apiBase } from "@/lib/api";
import { format, parseISO } from "date-fns";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";

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

interface NotificationPage {
  items: Notification[];
  nextCursor: string | null;
}

export default function StaffNotifications() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const historyKey = ["staff-notification-history", user?.id] as const;
  const history = useInfiniteQuery({
    queryKey: historyKey,
    enabled: !!user,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<NotificationPage> => {
      const params = new URLSearchParams({ limit: "50" });
      if (pageParam) params.set("cursor", pageParam);
      const r = await apiFetch(`${apiBase}/user-notifications?${params}`, { signal });
      const data: unknown = await r.json();
      if (!Array.isArray(data)) throw new Error("Invalid notification response");
      return { items: data as Notification[], nextCursor: r.headers.get("X-Next-Cursor") };
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
  const count = useQuery<{ count: number }>({
    queryKey: ["staff-notification-count", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const r = await apiFetch(`${apiBase}/user-notifications/unread-count`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
  const items = [...new Map(
    (history.data?.pages.flatMap(page => page.items) ?? []).map(n => [n.id, n]),
  ).values()];
  const loading = history.isPending;
  const loadError = history.isError || count.isError
    ? "Could not refresh notifications. Retry to check the latest staff actions."
    : null;

  function updateRead(id?: string) {
    queryClient.setQueryData<InfiniteData<NotificationPage>>(historyKey, prev => prev && ({
      ...prev,
      pages: prev.pages.map(page => ({
        ...page,
        items: page.items.map(n => !id || n.id === id ? { ...n, isRead: true } : n),
      })),
    }));
    void queryClient.invalidateQueries({ queryKey: ["staff-notification-count"] });
    void queryClient.invalidateQueries({ queryKey: historyKey });
    setError(null);
  }

  async function markRead(id: string) {
    try {
      await apiFetch(`${apiBase}/user-notifications/${id}/read`, { method: "POST" });
      updateRead(id);
    } catch {
      setError("Could not mark this notification as read. Please try again.");
    }
  }

  async function markAllRead() {
    try {
      await apiFetch(`${apiBase}/user-notifications/read-all`, { method: "POST" });
      updateRead();
    } catch {
      setError("Could not mark notifications as read. Please try again.");
    }
  }

  const unread = Number.isInteger(count.data?.count) ? Math.max(0, count.data!.count) : null;

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Notifications</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {unread === null || count.isError ? "Checking unread notifications…" :
                unread > 0 ? `${unread} unread overall` : "You're all caught up."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {items.length} notifications loaded, newest first.
            </p>
          </div>
          {unread !== null && unread > 0 && (
            <Button onClick={markAllRead} variant="outline" size="sm" className="gap-2">
              <Check className="w-4 h-4" /> Mark all as read
            </Button>
          )}
        </div>

        {(error || loadError) && (
          <div role="alert" className="rounded-lg border p-3 text-sm flex flex-wrap items-center justify-between gap-2">
            <span>{error || loadError}</span>
            <Button variant="outline" size="sm" onClick={() => {
              setError(null);
              void history.refetch();
              void count.refetch();
            }}>Retry</Button>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : items.length === 0 && !history.isError ? (
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
        {history.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" disabled={history.isFetching} onClick={() => {
              void history.fetchNextPage();
            }} data-testid="notifications-load-older">
              {history.isFetchingNextPage && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {history.isFetchingNextPage ? "Loading older notifications…" : "Load older notifications"}
            </Button>
          </div>
        )}
        {!loading && items.length > 0 && !history.hasNextPage && !history.isError && (
          <p className="text-center text-xs text-muted-foreground">All available notifications loaded.</p>
        )}
      </div>
    </AppLayout>
  );
}
