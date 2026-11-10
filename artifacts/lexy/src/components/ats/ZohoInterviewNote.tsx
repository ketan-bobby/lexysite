import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { previewZohoInterviewNote, publishZohoInterviewNote } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { useZohoRequestScope } from "./useZohoRequestScope";

/** Deliberate publication of exact preview text; never a stage/offer action. */
export function ZohoInterviewNote({
  campaignId,
  recipientId,
  allowAssessment = false,
}: {
  campaignId: string;
  recipientId: string;
  allowAssessment?: boolean;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [includeAssessment, setIncludeAssessment] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const identity = `${user?.id}:${user?.tenantId}:${user?.role}:${campaignId}:${recipientId}`;
  const current = useZohoRequestScope(`${identity}:${includeAssessment}`);
  const key = ["zoho-interview-note", identity, includeAssessment];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      previewZohoInterviewNote(
        campaignId,
        recipientId,
        { includeAssessment },
        { signal, cache: "no-store" },
      ),
    enabled: open && user?.role === "tenant_admin",
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: open ? 15000 : false,
  });
  useEffect(() => {
    setOpen(false);
    setIncludeAssessment(false);
    setConfirm(false);
    setError("");
    setNotice("");
    setBusy(false);
  }, [identity]);
  useEffect(() => {
    setConfirm(false);
    setNotice("");
  }, [query.data?.revision, includeAssessment]);
  const view = !query.isError && !query.isLoading ? query.data : undefined;
  async function publish() {
    if (!view?.canPublish || !confirm || busy || query.isFetching) return;
    const stillCurrent = current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const receipt = await publishZohoInterviewNote(campaignId, recipientId, {
        includeAssessment,
        expectedRevision: view.revision,
        confirm: true,
      });
      if (!stillCurrent()) return;
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: ["zoho-interview-note"] });
      if (stillCurrent())
        setNotice(
          receipt.state === "published"
            ? `Zoho acknowledged note ${receipt.providerNoteId}. No hiring stage was changed.`
            : "An earlier attempt is unconfirmed. Inspect Zoho; do not resend.",
        );
    } catch {
      if (stillCurrent()) {
        setError(
          "Publication could not be confirmed. Refresh the preview and inspect its receipt before trying anything else.",
        );
        setConfirm(false);
        await qc.invalidateQueries({ queryKey: ["zoho-interview-note"] });
      }
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  if (user?.role !== "tenant_admin") return null;
  return (
    <section
      className="min-w-0 space-y-3 rounded border p-3 text-sm"
      data-testid={`zoho-note-${recipientId}`}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)} disabled={busy}>
        {open ? "Hide Zoho note" : "Preview Zoho interview note"}
      </Button>
      {open && (
        <>
          <p className="text-muted-foreground">
            Publish to the candidate’s Notes in Zoho. The text identifies this job and application.
            This is a reviewed snapshot, not automatic background sync.
          </p>
          {allowAssessment && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={includeAssessment}
                disabled={busy}
                onChange={(e) => {
                  setIncludeAssessment(e.target.checked);
                  setError("");
                  setNotice("");
                }}
              />
              Include assessment from the current human-reviewed interview
            </label>
          )}
          {query.isLoading && <p role="status">Preparing the current note…</p>}
          {query.isError && (
            <div role="alert">
              <p>
                Preview unavailable. Assessment publication requires a completed interview and a
                current human review.
              </p>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Refresh preview
              </Button>
            </div>
          )}
          {view && (
            <>
              <p className="break-all">
                Candidate {view.externalCandidateId} · Job {view.externalJobId} · Application{" "}
                {view.applicationId}
              </p>
              <h4 className="font-medium">{view.title}</h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-sans text-xs">
                {view.content}
              </pre>
              {!view.writeAuthorized && (
                <p role="status">
                  Note write permission is not enabled. An employer administrator can reconnect in
                  ATS connections and select interview-note creation permission, then confirm the
                  employer account. Nothing is sent by reconnecting.
                </p>
              )}
              {view.history.length > 0 && (
                <ul className="space-y-1">
                  {view.history.map((h) => (
                    <li key={h.id}>
                      {h.state === "published"
                        ? `Zoho acknowledged note ${h.providerNoteId}`
                        : "Unconfirmed attempt — inspect Zoho; automatic retry blocked"}
                      {" · "}
                      {new Date(h.at).toLocaleString()}
                    </li>
                  ))}
                </ul>
              )}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirm}
                  disabled={!view.canPublish || busy || query.isFetching}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                I approve this exact text for the employer’s Zoho candidate record
                {includeAssessment ? ", including the assessment" : ""}. Zoho administrators and
                users with access to its notes may read it.
              </label>
              <Button
                disabled={!view.canPublish || !confirm || busy || query.isFetching}
                onClick={() => void publish()}
              >
                {busy ? "Publishing…" : "Approve and publish note"}
              </Button>
              <Button
                className="ml-2"
                variant="outline"
                disabled={busy}
                onClick={() => void query.refetch()}
              >
                Refresh preview
              </Button>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
