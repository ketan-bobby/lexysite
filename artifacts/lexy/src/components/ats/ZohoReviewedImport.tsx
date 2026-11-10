import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListJobsQueryKey,
  getListCandidatesQueryKey,
  type ZohoRecruitImportPreview,
  type ZohoRecruitImportResult,
} from "@workspace/api-client-react";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

async function post<T>(action: "preview" | "confirm", body: unknown): Promise<T> {
  const response = await apiFetch(`${apiBase}/zoho-recruit/imports/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      error?.error || "Zoho import could not be completed. Review the connection and try again.",
    );
  }
  return response.json() as Promise<T>;
}

export function ZohoReviewedImport({ revision }: { revision: string }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"job" | "candidate">("job");
  const [recordId, setRecordId] = useState("");
  const [preview, setPreview] = useState<ZohoRecruitImportPreview | null>(null);
  const [result, setResult] = useState<ZohoRecruitImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    if (remaining <= 0) {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPreview(null);
      setAgreed(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [preview]);
  const clear = () => {
    setPreview(null);
    setResult(null);
    setError("");
    setAgreed(false);
  };
  async function onPreview() {
    clear();
    if (!/^[1-9]\d{0,39}$/.test(recordId)) {
      setError("Enter the numeric Zoho Recruit record ID from the record URL.");
      return;
    }
    setBusy(true);
    try {
      const next = await post<ZohoRecruitImportPreview>("preview", {
        revision,
        kind,
        recordId,
        confirm: true,
      });
      if (next.revision !== revision || next.kind !== kind || next.recordId !== recordId)
        throw new Error("Connection or record changed. Reload before importing.");
      setPreview(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview this record.");
    } finally {
      setBusy(false);
    }
  }
  async function onConfirm() {
    if (!preview || !agreed || Date.parse(preview.expiresAt) <= Date.now()) {
      setPreview(null);
      setError("Preview expired. Review the record again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await post<ZohoRecruitImportResult>("confirm", {
        revision,
        kind: preview.kind,
        recordId: preview.recordId,
        confirm: true,
        previewToken: preview.previewToken,
        existingId: preview.existingId,
      });
      setResult(next);
      setPreview(null);
      setAgreed(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/jobs"] }),
        qc.invalidateQueries({ queryKey: getListJobsQueryKey() }),
        qc.invalidateQueries({ queryKey: ["/api/candidates"] }),
        qc.invalidateQueries({ queryKey: getListCandidatesQueryKey() }),
      ]);
    } catch (cause) {
      setPreview(null);
      setAgreed(false);
      setError(cause instanceof Error ? cause.message : "Import failed. Review the record again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0 space-y-3 rounded border p-4" aria-label="Reviewed Zoho import">
      <h2 className="font-semibold">Import a reviewed Zoho record</h2>
      <p className="text-muted-foreground">
        Enter one Zoho Recruit record ID, review its details, then confirm. No automatic sync,
        messages, application enrollment, stage change or offer is triggered. Imported jobs remain
        drafts.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-full min-w-0 space-y-1 text-sm sm:w-auto">
          Record type
          <select
            className="block w-full min-w-0 rounded border bg-background p-2 sm:w-auto"
            value={kind}
            disabled={busy}
            onChange={(e) => {
              setKind(e.target.value as "job" | "candidate");
              clear();
            }}
          >
            <option value="job">Job opening</option>
            <option value="candidate">Candidate</option>
          </select>
        </label>
        <label className="w-full min-w-0 space-y-1 text-sm sm:w-auto">
          Zoho record ID
          <input
            className="block w-full min-w-0 rounded border bg-background p-2 sm:w-72"
            value={recordId}
            disabled={busy}
            inputMode="numeric"
            placeholder="Numeric ID from Zoho URL"
            onChange={(e) => {
              setRecordId(e.target.value.trim());
              clear();
            }}
          />
        </label>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void onPreview()}>
          {busy ? "Working…" : "Preview record"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {preview && (
        <div className="min-w-0 space-y-3 break-words rounded border p-3">
          <h3 className="font-semibold">
            {preview.kind === "job"
              ? preview.fields.title
              : `${preview.fields.firstName ?? ""} ${preview.fields.lastName ?? ""}`.trim()}
          </h3>
          {preview.kind === "job" ? (
            <>
              <p>Location: {preview.fields.location || "Not provided"}</p>
              <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                {preview.fields.description}
              </p>
            </>
          ) : (
            <p>Email: {preview.fields.email}</p>
          )}
          <p>
            {preview.disposition === "create"
              ? "New local record."
              : preview.disposition === "link"
                ? `An existing Lexy candidate matches this email. Confirm to link Zoho identity to local candidate ${preview.existingId}, without overwriting their profile.`
                : `Already imported as local ${preview.kind} ${preview.existingId}. No duplicate will be created.`}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              I reviewed this{" "}
              {preview.kind === "job"
                ? "job and approve a draft import"
                : "candidate and approve the indicated import or identity link"}{" "}
              for this employer.
            </span>
          </label>
          <Button type="button" disabled={!agreed || busy} onClick={() => void onConfirm()}>
            {busy
              ? "Importing…"
              : preview.disposition === "already_imported"
                ? "Confirm existing record"
                : preview.disposition === "link"
                  ? "Confirm identity link"
                  : "Confirm import"}
          </Button>
        </div>
      )}
      {result && (
        <p role="status">
          {result.outcome === "created"
            ? "Imported"
            : result.outcome === "linked"
              ? "Linked"
              : "Already imported"}{" "}
          in Lexy.{" "}
          <Link
            href={
              result.kind === "job" ? `/jobs/${result.localId}` : `/candidates/${result.localId}`
            }
            className="underline"
          >
            Open {result.kind}
          </Link>
        </p>
      )}
    </section>
  );
}
