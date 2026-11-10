import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InterviewCaptureDiagnosticReport } from "@workspace/api-client-react";
import { apiBase, apiFetch } from "@/lib/api";

export function InterviewCaptureDiagnostics({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery<InterviewCaptureDiagnosticReport>({
    queryKey: ["interview-capture-diagnostics", sessionId],
    enabled: open,
    queryFn: async () => {
      const response = await apiFetch(`${apiBase}/interviews/${sessionId}/capture-diagnostics`);
      if (!response.ok) throw new Error("Capture diagnostics unavailable");
      return response.json();
    },
    refetchInterval: open ? 15000 : false,
    retry: 1,
  });
  return (
    <details
      className="mb-4 rounded-xl border border-border p-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-semibold">Answer-capture diagnostics</summary>
      <p className="mt-2 text-sm text-muted-foreground">
        Client-reported capture and review decisions. These are not speech-confidence, accuracy,
        proctoring or hiring scores. No answer text or audio is logged here.
      </p>
      {query.isLoading && <p className="mt-3 text-sm">Loading diagnostics…</p>}
      {query.isError && (
        <p role="status" className="mt-3 text-sm">
          Diagnostics are temporarily unavailable. This does not affect the saved assessment.
        </p>
      )}
      {query.data && query.data.events.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          No capture diagnostics were recorded for this interview. Older completed interviews are
          not backfilled.
        </p>
      )}
      <ol className="mt-3 max-h-80 space-y-3 overflow-y-auto">
        {query.data?.events.map((event) => (
          <li key={event.eventId} className="rounded-lg bg-muted/30 p-3 text-sm">
            <div className="font-medium">
              Question {event.turnNumber} · {event.event.replaceAll("_", " ")}
            </div>
            <div className="text-muted-foreground">
              {event.reason.replaceAll("_", " ")} ·{" "}
              {new Date(event.recordedAt).toLocaleTimeString()}
              {event.source && ` · ${event.source}`}
            </div>
            {event.longestRunMs != null && (
              <div className="text-xs text-muted-foreground">
                Sustained level: {event.longestRunMs} ms / {event.thresholdMs} ms threshold
                {" · "}
                {event.aboveThresholdSamples}/{event.sampleCount} samples above the microphone
                threshold
              </div>
            )}
            {event.edited != null && (
              <div className="text-xs text-muted-foreground">
                {event.edited
                  ? "Candidate edited the captured text"
                  : "Candidate confirmed without editing"}
              </div>
            )}
            {event.inViewport != null && (
              <div className="text-xs text-muted-foreground">
                {event.inViewport
                  ? "Panel rendered within the viewport"
                  : "Panel rendered outside the viewport or without visible dimensions"}
                . This does not prove the candidate saw it.
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
