import { useRef, useState } from "react";
import {
  getGetPanelCalendarConsentQueryKey,
  useGetPanelCalendarConsent,
  useSetPanelCalendarConsent,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Loader2 } from "lucide-react";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import { useAuth } from "@/lib/auth-context";

export function CalendarPanelConsent() {
  const { user } = useAuth();
  return user ? <CalendarPanelConsentInner key={user.id} userId={user.id} /> : null;
}
function CalendarPanelConsentInner({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const key = [...getGetPanelCalendarConsentQueryKey(), userId];
  const query = useGetPanelCalendarConsent({
    query: { queryKey: key, refetchOnWindowFocus: "always", retry: false },
  });
  const set = useSetPanelCalendarConsent({ mutation: { retry: false } });
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const raw = query.data as unknown;
  const receipt = raw as { enabled?: unknown; grantedAt?: unknown } | null;
  const valid =
    !!receipt &&
    typeof receipt.enabled === "boolean" &&
    (receipt.enabled
      ? typeof receipt.grantedAt === "string" && Number.isFinite(Date.parse(receipt.grantedAt))
      : receipt.grantedAt === null);
  const enabled = valid && (raw as { enabled: boolean }).enabled;
  const grantedAt = valid ? (raw as { grantedAt?: unknown }).grantedAt : null;

  async function save(next: boolean) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const result = (await set.mutateAsync({ data: { enabled: next } })) as unknown as {
        enabled?: unknown;
        grantedAt?: unknown;
      };
      if (
        typeof result?.enabled !== "boolean" ||
        result.enabled !== next ||
        (next
          ? typeof result.grantedAt !== "string" || !Number.isFinite(Date.parse(result.grantedAt))
          : result.grantedAt !== null)
      )
        throw new Error("unconfirmed");
      qc.setQueryData(key, result);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const data = (e as { data?: { error?: unknown } })?.data;
      const known = status && [400, 403, 409].includes(status) && typeof data?.error === "string";
      setError(
        known
          ? `${data!.error as string} Your sharing choice was not changed.`
          : "Lexy could not confirm this change. Check the saved choice below, or reload it if unavailable, before trying again. Nothing was retried automatically.",
      );
      await qc.invalidateQueries({ queryKey: key });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="w-4 h-4 text-primary" /> Interview panel availability
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          If you opt in, authorised coordinators within your organisation's work-order scope can
          check <strong>common suggested times</strong> that include you. They cannot see your
          events or busy details, and candidates never see calendars. You can withdraw at any time
          without disconnecting your mail or calendar.
        </p>
        {query.isError || (query.data !== undefined && !valid) ? (
          <div role="alert" className="text-sm text-destructive space-y-2">
            <p>Your sharing choice could not be loaded. This does not mean sharing is off.</p>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Reload choice
            </Button>
          </div>
        ) : query.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="space-y-1">
                <Badge variant="outline" data-testid="status-panel-consent">
                  {enabled ? "Sharing on" : "Sharing off"}
                </Badge>
                {enabled && typeof grantedAt === "string" && (
                  <p className="text-xs text-muted-foreground">
                    Opted in {formatInterviewInstant(grantedAt)}
                  </p>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                {enabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void save(true)}
                    data-testid="button-panel-reconfirm"
                  >
                    {pending ? "Saving…" : "Reconfirm sharing"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={enabled ? "outline" : "default"}
                  disabled={pending || query.isFetching}
                  onClick={() => void save(!enabled)}
                  data-testid="button-panel-toggle"
                >
                  {pending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                  {enabled ? "Stop sharing" : "Share panel availability"}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Turning sharing on verifies your connected Outlook mailbox and ties your choice to it.
              This stored choice is not proof the connection is healthy today. If you change
              mailbox, reconfirm sharing. Turning it off does not need a connection.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
