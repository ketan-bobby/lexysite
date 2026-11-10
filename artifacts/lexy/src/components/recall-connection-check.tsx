import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { RecallReadiness } from "@workspace/api-client-react";

/** Diagnostic only. Deliberately contains no Join, Record or Enable action. */
export function RecallConnectionCheck() {
  const { user } = useAuth();
  const [view, setView] = useState<RecallReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (user?.role !== "platform_admin") return null;
  async function check() {
    setView(null);
    setError("");
    setBusy(true);
    try {
      const response = await apiFetch(`${apiBase}/meeting-assistant/readiness`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("The Recall connection check is unavailable.");
      setView(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The connection could not be checked.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card data-testid="recall-connection-check">
      <CardHeader>
        <CardTitle>Meeting assistant · Recall</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Check the project connection without joining a meeting, recording participants or changing
          Lexy's AI models.
        </p>
        <p className="text-muted-foreground">
          Connection readiness is not employer authorization. Configure optional attendance in the
          candidate&apos;s Meeting Notes panel, with workspace authorization, participant consent
          and separate host approval. This check never dispatches an assistant.
        </p>
        <Button onClick={check} disabled={busy} variant="outline">
          {busy ? "Checking Recall…" : "Check Recall connection"}
        </Button>
        {view && (
          <p role="status" data-testid="recall-readiness-result">
            {view.message} Checked {new Date(view.checkedAt).toLocaleTimeString()}.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
