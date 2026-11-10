import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";
import {
  readCandidateDataDownload,
  saveCandidateDataDownload,
} from "@/lib/candidate-data-download";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function CandidateDataDownload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  async function download() {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setStarted(false);
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await apiFetch(`${apiBase}/portal/me/export`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const file = await readCandidateDataDownload(response);
      if (!mounted.current) return;
      if (controller.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      saveCandidateDataDownload(file);
      setStarted(true);
    } catch (err) {
      if (mounted.current) {
        setError(
          controller.signal.aborted
            ? "The download took too long. Please try again."
            : err instanceof Error
              ? err.message
              : "Could not download your data. Please try again.",
        );
      }
    } finally {
      window.clearTimeout(timeout);
      controllerRef.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Card data-testid="candidate-data-download">
      <CardHeader>
        <CardTitle className="text-lg">Your personal data</CardTitle>
        <CardDescription>
          Download a JSON copy of your records. Recruiter interview feedback is withheld.
          Downloading does not change your profile or privacy settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button type="button" variant="outline" onClick={download} disabled={busy} aria-busy={busy}>
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {busy ? "Preparing download…" : "Download my data"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {started && (
          <p role="status" className="text-sm text-muted-foreground">
            Download started. Check your browser&apos;s downloads. This file contains personal
            information—store it securely.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
