import { useEffect, useRef, useState } from "react";
import { checkGoogleCalendarPilot } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, Loader2 } from "lucide-react";
import { googlePilotReceipt, type GooglePilotReceipt } from "./google-calendar-pilot-state";

export function GoogleCalendarPilot() {
  const { user } = useAuth();
  return user?.role === "platform_admin" ? <GoogleCalendarPilotInner key={user.id} /> : null;
}

function GoogleCalendarPilotInner() {
  const [result, setResult] = useState<GooglePilotReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );

  async function check() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setResult(null);
    setError(null);
    try {
      const receipt = googlePilotReceipt(
        await checkGoogleCalendarPilot(
          { confirmReadOnlyCheck: true },
          { signal: controller.signal },
        ),
      );
      if (controller.signal.aborted) return;
      if (!receipt) throw new Error("Invalid pilot receipt");
      setResult(receipt);
    } catch {
      if (!controller.signal.aborted)
        setError(
          "The Google read check could not be verified. Nothing has been enabled; check the connection and try again.",
        );
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setPending(false);
      }
    }
  }

  return (
    <Card data-testid="google-calendar-pilot">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarDays className="h-5 w-5" /> Google Calendar pilot
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Badge variant="secondary">Admin-only · read-only</Badge>
        <p className="text-sm text-muted-foreground">
          Check the project-connected Google account before implementing staff calendar access. This
          reads primary-calendar metadata and verifies a 15-minute availability query. No account
          identifiers, event details or busy periods are displayed.
        </p>
        <Button onClick={() => void check()} disabled={pending} data-testid="google-pilot-check">
          {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {pending ? "Checking reads…" : "Check Google connection"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="rounded-lg border p-3 space-y-2 text-sm">
            <p className="font-medium">
              {result.status === "verified"
                ? "Read checks passed"
                : result.status === "not_connected"
                  ? "No accessible project connection"
                  : "Multiple Google connections need explicit selection"}
            </p>
            {result.status === "verified" && (
              <p>
                Calendar metadata and availability reads verified. Google Meet:{" "}
                {result.meetSupported === null
                  ? "not verified"
                  : result.meetSupported
                    ? "advertised by this calendar"
                    : "not advertised by this calendar"}
                . This is not proof of meeting-creation permission.
              </p>
            )}
            <p className="text-muted-foreground">
              Checked: {new Date(result.checkedAt).toLocaleString()}
            </p>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Staff/employer account binding is not configured. This check does not authorize recruiting
          access, publish candidate slots, create meeting links or send invitations. Candidate and
          panel calendars remain unchanged.
        </p>
      </CardContent>
    </Card>
  );
}
