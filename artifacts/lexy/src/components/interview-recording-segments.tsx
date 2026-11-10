import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
type Recording = { attemptId: string; partCount: number; startedAt: string; contiguous: boolean };

export function InterviewSavedRecordings({ interviewId }: { interviewId: string }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setRecordings([]);
    setSelected("");
    setError("");
    fetch(`${BASE}/api/interviews/${interviewId}/recording-segments`, {
      headers: authHeaders(),
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Saved recording segments are temporarily unavailable.");
        const data = await response.json();
        setRecordings(data.recordings);
        setSelected(data.recordings[0]?.attemptId ?? "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [interviewId]);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setSource("");
    if (!selected) return () => controller.abort();
    setLoading(true);
    setError("");
    fetch(`${BASE}/api/interviews/${interviewId}/recording-segments/${selected}`, {
      headers: authHeaders(),
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 409
              ? "Some chunks are missing. Use the final session recording below if available."
              : "This recording could not be loaded.",
          );
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selected, interviewId]);

  if (!recordings.length && !error) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved recording segments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Recordings from before and after a resume are retained separately. Periodic checkpoints
          may not include the last few seconds before an abrupt close.
        </p>
        {recordings.length > 0 && (
          <label className="block text-sm">
            Recording
            <select
              className="ml-2 rounded border bg-background p-2"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {recordings.map((recording, index) => (
                <option key={recording.attemptId} value={recording.attemptId}>
                  Segment {index + 1} · {new Date(recording.startedAt).toLocaleString()}
                  {!recording.contiguous ? " · incomplete" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {loading && <p role="status">Loading saved recording…</p>}
        {error && (
          <p role="alert" className="text-sm text-amber-600">
            {error}
          </p>
        )}
        {source && (
          <video
            aria-label="Saved interview recording segment"
            controls
            src={source}
            className="w-full rounded"
          />
        )}
      </CardContent>
    </Card>
  );
}
