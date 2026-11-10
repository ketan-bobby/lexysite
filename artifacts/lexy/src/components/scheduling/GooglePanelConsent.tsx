import { useRef, useState } from "react";
import {
  getGetGooglePanelConsentQueryKey,
  useGetGooglePanelConsent,
  useSetGooglePanelConsent,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Loader2 } from "lucide-react";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import { useAuth } from "@/lib/auth-context";
import { isUuid, parseConsent } from "@/lib/google-panel";

export function GooglePanelConsent() {
  const { user } = useAuth();
  if (!user || user.role === "candidate") return null;
  return <Inner key={`${user.id}:${user.role}`} userId={user.id} role={user.role} />;
}

function Inner({ userId, role }: { userId: string; role: string }) {
  const qc = useQueryClient();
  const key = [...getGetGooglePanelConsentQueryKey(), userId, role];
  const query = useGetGooglePanelConsent({
    query: { queryKey: key, refetchOnWindowFocus: "always", retry: false },
  });
  const set = useSetGooglePanelConsent({ mutation: { retry: false } });
  const lock = useRef(false);
  const [ack, setAck] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const view = parseConsent(query.data);
  const bad = query.isError || (query.data !== undefined && !view);

  async function save(next: boolean) {
    if (lock.current || !view) return;
    if (next && !ack) return;
    if (!isUuid(view.revision)) return; // only the server-provided revision
    if (next && !view.canEnable) return; // revoking never needs a healthy connection
    lock.current = true;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const r = parseConsent(
        await set.mutateAsync({
          data: next
            ? { enabled: true, expectedRevision: view.revision, confirmShare: true }
            : { enabled: false, expectedRevision: view.revision },
        }),
      );
      if (!r || r.enabled !== next) throw new Error("unconfirmed");
      qc.setQueryData(key, r);
      setAck(false);
      setDone(next ? "Google panel sharing is on." : "Google panel sharing is off.");
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const msg = (e as { data?: { error?: unknown } })?.data?.error;
      setError(
        status && [400, 403, 409].includes(status) && typeof msg === "string"
          ? `${msg} Your sharing choice was not changed.`
          : "Lexy could not confirm this change. Reload the saved choice before trying again.",
      );
      void qc.invalidateQueries({ queryKey: key });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <Card data-testid="card-google-panel-consent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="w-4 h-4 text-primary" /> Google panel availability
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          If you opt in, authorised coordinators can search <strong>common suggested times</strong>{" "}
          that include you using your Google calendar. They never see events or busy details. This
          is separate from connecting Google or allowing invitations, and from your Outlook choice
          above.
        </p>
        {bad ? (
          <div role="alert" className="text-sm text-destructive space-y-2">
            <p>
              Your Google sharing choice could not be loaded. This does not mean sharing is off.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Reload choice
            </Button>
          </div>
        ) : query.isLoading || !view ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="space-y-1">
                <Badge variant="outline" data-testid="status-google-panel-consent">
                  {view.enabled ? "Google sharing on" : "Google sharing off"}
                </Badge>
                {view.enabled && view.grantedAt && (
                  <p className="text-xs text-muted-foreground">
                    Opted in {formatInterviewInstant(view.grantedAt)}
                  </p>
                )}
              </div>
              {view.enabled && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || query.isFetching}
                  onClick={() => void save(false)}
                  data-testid="button-google-panel-revoke"
                >
                  {pending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                  Stop sharing
                </Button>
              )}
            </div>
            {view.enabled && !view.canEnable && (
              <p
                role="status"
                className="text-sm text-muted-foreground"
                data-testid="text-google-panel-unhealthy"
              >
                Your Google connection needs attention, so you may not appear in searches. You can
                still stop sharing now.
              </p>
            )}
            {!view.enabled && (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                    data-testid="checkbox-google-panel-ack"
                  />
                  I agree to let authorised coordinators in my organisation include my Google
                  calendar availability in common-time searches.
                </label>
                {!view.canEnable && (
                  <p
                    role="status"
                    className="text-sm text-muted-foreground"
                    data-testid="text-google-panel-needs-connection"
                  >
                    Connect or reconnect your Google calendar in the Google calendar section first.
                    Sharing can only be turned on for a healthy, verified Google account.
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={
                    !view.canEnable || !view.revision || !ack || pending || query.isFetching
                  }
                  onClick={() => void save(true)}
                  data-testid="button-google-panel-enable"
                >
                  {pending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                  Share Google panel availability
                </Button>
              </>
            )}
          </div>
        )}
        {done && (
          <p role="status" className="text-sm" data-testid="text-google-panel-done">
            {done}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="text-google-panel-error"
          >
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
