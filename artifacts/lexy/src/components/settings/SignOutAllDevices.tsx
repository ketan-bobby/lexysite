import { useEffect, useState, useRef, type FormEvent } from "react";
import { logoutAllSessions } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { endSession, authHeaders } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignOutAllDevices() {
  const { user } = useAuth();
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const [password, setPassword] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setPassword("");
    setAck(false);
    setError("");
    setNotice("");
  }, [user?.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!user || busy || !password || !ack) return;
    setBusy(true);
    setError("");
    // Direct generated request, not mutation cache: never retain a password as
    // React Query mutation variables or in browser storage.
    const confirmation = password,
      owner = user.id,
      headers = authHeaders();
    setPassword("");
    setAck(false);
    try {
      const result = await logoutAllSessions(
        { password: confirmation, acknowledge: true },
        { headers, credentials: "include", signal: AbortSignal.timeout(15_000) },
      );
      if (identity.current !== owner || JSON.stringify(headers) !== JSON.stringify(authHeaders()))
        return;
      if (result.success !== true) throw Error("All-device sign-out could not be confirmed.");
      setNotice("All account sessions ended. Signing you out…");
      await endSession();
    } catch (cause) {
      if (identity.current !== owner) return;
      const failure = cause as { status?: number; data?: { error?: string } };
      setError(
        failure.data?.error ||
          "All-device sign-out could not be confirmed. Your sessions may already have ended. Retry or sign in again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign out all devices</CardTitle>
        <CardDescription>
          End every Lexy account session, including this one. Your password stays unchanged.
          Ordinary sign-out ends only the current session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" aria-label="Sign out all devices">
          <div className="space-y-2">
            <Label htmlFor="logout-all-password">Current password</Label>
            <Input
              id="logout-all-password"
              data-testid="logout-all-password"
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy || !user}
              required
            />
          </div>
          <Label className="flex items-start gap-2 font-normal">
            <input
              type="checkbox"
              className="mt-1"
              checked={ack}
              disabled={busy || !user}
              onChange={(event) => setAck(event.target.checked)}
            />
            I understand I will need to sign in again on every device.
          </Label>
          <p className="text-xs text-muted-foreground">
            Requires a local account password. Organization-only sign-in accounts cannot use
            password confirmation.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          <Button type="submit" variant="destructive" disabled={busy || !user || !password || !ack}>
            {busy ? "Signing out…" : "Sign out all devices"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
