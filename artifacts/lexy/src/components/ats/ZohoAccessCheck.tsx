import { useEffect, useState } from "react";
import type { ZohoRecruitAccessCheck } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";

const labels = {
  Job_Openings: "Job openings",
  Candidates: "Candidates",
  Applications: "Applications",
};
const reasons = {
  scope_missing: "Required read permission is missing",
  access_denied: "Zoho denied access",
  unsupported: "Module is unavailable or not supported for this account",
  request_failed: "Read could not be verified",
};

export function ZohoAccessCheck({ revision }: { revision: string }) {
  const [result, setResult] = useState<ZohoRecruitAccessCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [result]);
  async function check() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await apiFetch(`${apiBase}/zoho-recruit/account/check-access`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, confirm: true }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Zoho read access could not be checked.");
      if (body?.revision !== revision || !Array.isArray(body?.modules))
        throw new Error("Connection changed. Reload this page before checking again.");
      setResult(body as ZohoRecruitAccessCheck);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoho read access could not be checked.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded border p-4" aria-label="Zoho read-access check">
      <h2 className="font-semibold">Check Recruit read access</h2>
      <p className="text-muted-foreground">
        Manually checks job openings, candidates and applications. Requests an ID-only sample of at
        most one record per module; no record details are displayed or saved. This does not import
        records, change stages or send messages.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void check()}>
        {busy ? "Checking Zoho permissions…" : "Check read access"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status" className="space-y-2">
          <p>Checked {new Date(result.checkedAt).toLocaleString()}</p>
          <ul className="space-y-1">
            {result.modules.map((item) => (
              <li key={item.module}>
                <strong>{labels[item.module]}: </strong>
                {item.status === "readable"
                  ? "Read verified"
                  : item.status === "empty"
                    ? "Read accepted; no records returned"
                    : reasons[item.reason ?? "request_failed"]}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            These are observations from this check, not total counts or import approval. Empty
            results do not prove the account has no records. Results clear after five minutes or
            when you leave this page. This check does not verify job-scoped application search.
          </p>
        </div>
      )}
    </section>
  );
}
