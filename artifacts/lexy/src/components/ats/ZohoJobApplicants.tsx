import { useEffect, useState } from "react";
import type { ZohoJobApplicantPage } from "@workspace/api-client-react";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

/** Read-only application identities; an association is not an invitation. */
export function ZohoJobApplicants({ revision }: { revision: string }) {
  const [jobId, setJobId] = useState("");
  const [result, setResult] = useState<ZohoJobApplicantPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setResult(null);
    setError("");
  }, [revision]);
  async function load(page: number) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!/^[1-9]\d{0,39}$/.test(jobId) || page > 100)
        throw Error("Enter a valid Zoho job-opening ID.");
      const response = await apiFetch(`${apiBase}/zoho-recruit/applicants`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, jobId, page, confirm: true }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw Error(body?.error || "Job applicants could not be verified.");
      if (body?.jobId !== jobId || body?.page !== page || !Array.isArray(body?.applications))
        throw Error("The Zoho connection or job changed. Reload and try again.");
      setResult(body as ZohoJobApplicantPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Job applicants could not be verified.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0 space-y-3 rounded border p-4" aria-label="Zoho job applicants">
      <h2 className="font-semibold">Review applications for a Zoho job</h2>
      <p className="text-muted-foreground">
        Read one page of verified applications for a specific opening. This is not an interview
        campaign: no candidate is imported, enrolled, contacted, or advanced. Search access requires
        the employer administrator to reconnect Zoho after this update.
      </p>
      <label className="block min-w-0 space-y-1">
        Zoho job-opening ID
        <input
          className="block w-full min-w-0 rounded border bg-background p-2 sm:w-72"
          value={jobId}
          inputMode="numeric"
          disabled={busy}
          onChange={(e) => {
            setJobId(e.target.value.trim());
            setResult(null);
            setError("");
          }}
          placeholder="Numeric ID from Zoho URL"
        />
      </label>
      <Button
        variant="outline"
        disabled={busy || !/^[1-9]\d{0,39}$/.test(jobId)}
        onClick={() => void load(1)}
      >
        {busy ? "Checking…" : "Review applications"}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="space-y-2">
          <p>
            <strong>{result.jobTitle}</strong> — page {result.page}, {result.applications.length}{" "}
            verified applications on this page.
          </p>
          {result.applications.length === 0 && (
            <p>
              No applications returned for this page. This does not prove there are none elsewhere.
            </p>
          )}
          <ul className="max-h-64 space-y-1 overflow-auto break-all">
            {result.applications.map((item) => (
              <li key={item.applicationId}>
                Application {item.applicationId} · candidate {item.candidateId}
              </li>
            ))}
          </ul>
          {result.moreRecords && result.page < 100 && (
            <Button variant="outline" disabled={busy} onClick={() => void load(result.page + 1)}>
              Next page
            </Button>
          )}
          {result.moreRecords && result.page === 100 && (
            <p>More records exist; this review is incomplete.</p>
          )}
        </div>
      )}
    </section>
  );
}
