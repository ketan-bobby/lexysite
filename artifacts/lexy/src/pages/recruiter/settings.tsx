/**
 * pages/recruiter/settings.tsx — Recruiter personal settings
 *
 * Currently hosts the "Email Sending" connection: link your Microsoft 365 /
 * Outlook mailbox so Lexy sends your manual 1:1 emails and the first/approved
 * outreach step for candidates you own FROM YOUR OWN mailbox (replies land in
 * your Outlook and are synced back). Automated follow-ups and system mail keep
 * going from Lexy's shared sender. If your mailbox isn't connected (or the
 * connection fails) Lexy automatically falls back to that shared sender.
 *
 *   Status:     GET  /api/auth/microsoft-graph/status
 *   Connect:    GET  /api/auth/microsoft-graph/start      → { url } then navigate
 *   Disconnect: POST /api/auth/microsoft-graph/disconnect
 *
 * The OAuth callback redirects back here with ?outlook=connected|error.
 */
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@workspace/react-hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { Mail, Loader2, CheckCircle2, AlertTriangle, Plug, Unplug } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface MailStatus {
  configured: boolean;
  connected: boolean;
  status: string | null;
  email: string | null;
  lastError: string | null;
}

export default function RecruiterSettings() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<MailStatus>({
    queryKey: ["ms-graph-status"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE}/api/auth/microsoft-graph/status`);
      if (!res.ok) throw new Error("Failed to load mailbox status");
      return res.json();
    },
  });

  // Surface the OAuth callback result (?outlook=connected|error) once, then
  // strip the query string so a refresh doesn't re-toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("outlook");
    if (!outcome) return;
    if (outcome === "connected") {
      toast({ title: "Outlook connected", description: "Your emails will now send from your own mailbox." });
      qc.invalidateQueries({ queryKey: ["ms-graph-status"] });
    } else {
      toast({
        title: "Couldn't connect Outlook",
        description: "Please try again. Lexy will keep sending from the shared sender meanwhile.",
        variant: "destructive",
      });
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("outlook");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());
  }, [toast, qc]);

  const connect = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${BASE}/api/auth/microsoft-graph/start`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error === "not_configured" ? "not_configured" : "start_failed");
      }
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't start the connection",
        description:
          err?.message === "not_configured"
            ? "Microsoft sign-in isn't configured on the server yet."
            : "Please try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${BASE}/api/auth/microsoft-graph/disconnect`, { method: "POST" });
      if (!res.ok) throw new Error("disconnect_failed");
    },
    onSuccess: () => {
      toast({ title: "Outlook disconnected", description: "Lexy will send from the shared sender." });
      qc.invalidateQueries({ queryKey: ["ms-graph-status"] });
    },
    onError: () =>
      toast({ title: "Couldn't disconnect", description: "Please try again.", variant: "destructive" }),
  });

  const connected = data?.connected;
  const unhealthy = data && !data.connected && data.status && data.status !== null;

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage how your candidate emails are sent.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="w-4 h-4 text-primary" />
              Email Sending
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Connect your Microsoft&nbsp;365 / Outlook mailbox to send your manual replies and the
              first step of outreach to candidates you own <strong>from your own address</strong>.
              Replies come straight back to your Outlook and into Lexy. Automated follow-ups always
              send from Lexy's shared sender, and if your mailbox ever fails Lexy falls back to it
              automatically.
            </p>

            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : data && !data.configured ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                Microsoft sign-in isn't configured on the server yet. Once it is, you'll be able to
                connect your mailbox here.
              </div>
            ) : connected ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Connected</p>
                    <p className="text-xs text-muted-foreground truncate">
                      Sending as {data?.email || "your Outlook mailbox"}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  {disconnect.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Unplug className="w-4 h-4 mr-1.5" /> Disconnect
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {unhealthy && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    Your mailbox connection stopped working
                    {data?.status === "revoked" ? " (access was revoked)" : ""}. Reconnect to keep
                    sending from your own address.
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <Badge variant="outline" className="text-[11px]">
                    Not connected
                  </Badge>
                  <Button size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
                    {connect.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Plug className="w-4 h-4 mr-1.5" /> Connect Outlook
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
