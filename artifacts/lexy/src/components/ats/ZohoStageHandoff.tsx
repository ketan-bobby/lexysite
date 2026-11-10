import { useEffect, useRef, useState } from "react";
import { ZohoStageRequests } from "./ZohoStageRequests";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetZohoStageHandoffQueryKey,
  getZohoStageHandoff,
  saveZohoStageMapping,
  testZohoStageHandoff,
  checkZohoStageMetadata,
} from "@workspace/api-client-react";
import type {
  ZohoStageHandoff as Handoff,
  ZohoStageMapping,
  ZohoStageMetadataCheck,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

type Field = "advance" | "hold" | "decline";
const FIELDS: { key: Field; label: string }[] = [
  { key: "advance", label: "Advance to next-round review" },
  { key: "hold", label: "Hold" },
  { key: "decline", label: "Do not advance" },
];
const MAX = 100;
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const data = cause.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    return `${fallback} (HTTP ${cause.status}).`;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
function isHandoff(v: unknown, c: string, r: string): v is Handoff {
  const h = v as Handoff | null;
  return (
    !!h &&
    h.campaignId === c &&
    h.recipientId === r &&
    typeof h.revision === "string" &&
    !!h.mapping &&
    typeof h.mapping.revision === "string" &&
    Array.isArray(h.history)
  );
}
function isMapping(v: unknown): v is ZohoStageMapping {
  const m = v as ZohoStageMapping | null;
  return !!m && typeof m.revision === "string";
}
const toDraft = (m: ZohoStageMapping) => ({
  advance: m.advance ?? "",
  hold: m.hold ?? "",
  decline: m.decline ?? "",
});
const norm = (s: string) => (s.trim() ? s.trim() : null);

/** Prepares and simulates a human-approved Zoho stage handoff. Never writes to Zoho. */
export function ZohoStageHandoff({
  campaignId,
  recipientId,
  reviewRevision,
}: {
  campaignId: string;
  recipientId: string;
  reviewRevision: string;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === "tenant_admin";
  const scope = `${user?.id}:${user?.tenantId}:${user?.role}:${campaignId}:${recipientId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [draft, setDraft] = useState({ advance: "", hold: "", decline: "" });
  const [dirty, setDirty] = useState(false);
  const [mapAck, setMapAck] = useState(false);
  const [testAck, setTestAck] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "clear" | "test" | "metadata">("");
  const [metadataAck, setMetadataAck] = useState(false);
  const [metadata, setMetadata] = useState<ZohoStageMetadataCheck | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef<{ key: string; id: string } | null>(null);

  const key = [...getGetZohoStageHandoffQueryKey(campaignId, recipientId), scope];
  const q = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const body = await getZohoStageHandoff(campaignId, recipientId, {
        signal,
        cache: "no-store",
      });
      if (!isHandoff(body, campaignId, recipientId))
        throw new Error("Stage handoff returned an unexpected response.");
      return body;
    },
    enabled: !!user,
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
  });
  const h = q.data;
  const seenHandoff = useRef<string | null>(null);
  useEffect(() => {
    if (h && seenHandoff.current && seenHandoff.current !== h.revision) {
      setMapAck(false);
      setTestAck(false);
      setMetadataAck(false);
      setMetadata(null);
      requestRef.current = null;
    }
    seenHandoff.current = h?.revision ?? null;
  }, [h?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkMetadata() {
    if (!h || !isAdmin || !metadataAck || dirty || busy) return;
    const started = scope;
    const revision = h.revision;
    setBusy("metadata");
    setMetadata(null);
    setError("");
    try {
      const result = await checkZohoStageMetadata(campaignId, recipientId, {
        expectedRevision: revision,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      if (
        result.handoffRevision !== revision ||
        result.liveEnabled ||
        result.transitionEligibilityVerified
      )
        throw new Error("Metadata response was not recognized. Reload before checking again.");
      setMetadata(result);
    } catch (cause) {
      if (scopeRef.current === started)
        setError(errorText(cause, "Zoho stage metadata could not be checked"));
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        setMetadataAck(false);
        void qc.invalidateQueries({ queryKey: key });
      }
    }
  }

  useEffect(() => {
    setDirty(false);
    setMetadata(null);
    setMetadataAck(false);
    setMapAck(false);
    setTestAck(false);
    setBusy("");
    setError("");
    setNotice("");
    requestRef.current = null;
  }, [scope]);

  // Decision changed upstream: refetch and require fresh simulation confirmation.
  const firstRev = useRef(true);
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false;
      return;
    }
    setTestAck(false);
    setMetadataAck(false);
    setMetadata(null);
    requestRef.current = null;
    void qc.invalidateQueries({ queryKey: key });
  }, [reviewRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync draft from server unless the admin has unsaved edits.
  useEffect(() => {
    if (h && !dirty) setDraft(toDraft(h.mapping));
  }, [h?.mapping.revision, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const lengthsOk = FIELDS.every((f) => draft[f.key].trim().length <= MAX);
  const changed = !!h && FIELDS.some((f) => norm(draft[f.key]) !== (h.mapping[f.key] ?? null));
  const hasAny = !!h && FIELDS.some((f) => h.mapping[f.key]);

  async function putMapping(values: Record<Field, string | null>, kind: "save" | "clear") {
    if (!h || !isAdmin || !mapAck || busy) return;
    const started = scope;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const body = await saveZohoStageMapping(campaignId, {
        expectedRevision: h.mapping.revision,
        ...values,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      if (!isMapping(body)) throw new Error("Mapping response was not recognized. Refresh first.");
      setDirty(false);
      setMapAck(false);
      setTestAck(false);
      requestRef.current = null;
      setDraft(toDraft(body));
      setNotice(
        kind === "clear"
          ? "Proposed mapping cleared in Lexy. Nothing changed in Zoho."
          : "Proposed mapping saved in Lexy only. It is not verified against Zoho and nothing changed in Zoho.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      setMapAck(false);
      setTestAck(false);
      if (cause instanceof ApiError && cause.status === 409) {
        setError(
          "The mapping changed since you loaded it. Your entries are kept. Review the refreshed mapping and acknowledge again.",
        );
      } else setError(errorText(cause, "Mapping was not saved"));
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        await qc.invalidateQueries({ queryKey: key });
      }
    }
  }

  async function simulate() {
    if (!h || !h.ready || !testAck || busy) return;
    const started = scope;
    const payload = { expectedRevision: h.revision, mode: "simulation" as const };
    const k = `${scope}:${JSON.stringify(payload)}`;
    if (requestRef.current?.key !== k) requestRef.current = { key: k, id: crypto.randomUUID() };
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const body = await testZohoStageHandoff(campaignId, recipientId, {
        ...payload,
        requestId: requestRef.current.id,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      if (!isHandoff(body, campaignId, recipientId))
        throw new Error("Simulation response was not recognized. Refresh before retrying.");
      requestRef.current = null;
      setTestAck(false);
      qc.setQueryData(key, body);
      setNotice("Simulation recorded in Lexy. No Zoho stage was changed and no one was contacted.");
    } catch (cause) {
      if (scopeRef.current !== started) return;
      if (cause instanceof ApiError && cause.status === 409) {
        requestRef.current = null;
        setTestAck(false);
        setError(
          "The decision or mapping changed before the simulation. Nothing was recorded. Review the refreshed details and confirm again.",
        );
      } else
        setError(errorText(cause, "Simulation was not recorded. Retrying keeps the same request"));
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        await qc.invalidateQueries({ queryKey: key });
      }
    }
  }

  return (
    <section
      className="min-w-0 space-y-4 border-t border-dashed pt-3 sm:rounded sm:border sm:p-3"
      aria-label="Zoho stage handoff preparation"
      data-testid="section-stage-handoff"
    >
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Stage handoff, simulation only
        </p>
        <h5 className="text-sm font-medium">Prepare Zoho stage handoff</h5>
        <p
          className="rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs"
          data-testid="text-handoff-scope"
        >
          Status mappings are proposed by your team and not verified against Zoho. Live stage
          updates are disabled until Zoho write authorization and employer stage validation are in
          place. A simulation records what would be sent; it never changes Zoho or contacts the
          candidate.
        </p>
      </header>

      {q.isLoading && (
        <div className="space-y-2" role="status" aria-label="Loading stage handoff">
          <div className="h-16 animate-pulse rounded bg-muted" />
          <div className="h-10 animate-pulse rounded bg-muted" />
        </div>
      )}
      {q.isError && (
        <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3">
          <p className="break-words text-destructive" data-testid="text-handoff-load-error">
            {errorText(q.error, "Stage handoff could not be loaded")}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="button-retry-handoff"
            onClick={() => void q.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {h && (
        <>
          {isAdmin && (
            <section
              className="min-w-0 space-y-3 rounded border p-3"
              data-testid="panel-stage-metadata"
            >
              <h4 className="text-sm font-semibold">Check Zoho application and stage metadata</h4>
              <p className="text-xs text-muted-foreground">
                Checks the exact application, job and candidate, then compares saved values with
                Zoho’s default stage catalogue. A match does not prove this application permits a
                transition.
              </p>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={metadataAck}
                  disabled={!!busy || dirty}
                  data-testid="checkbox-stage-metadata"
                  onChange={(e) => setMetadataAck(e.target.checked)}
                />
                <span>Run a read-only Zoho check. Do not change any status or permission.</span>
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={!metadataAck || !!busy || dirty}
                data-testid="button-check-stage-metadata"
                onClick={() => void checkMetadata()}
              >
                {busy === "metadata" ? "Checking Zoho…" : "Check saved mappings in Zoho"}
              </Button>
              {metadata && metadata.handoffRevision === h.revision && (
                <div
                  className="space-y-2 break-words text-xs"
                  data-testid="result-stage-metadata"
                  role="status"
                >
                  <p>
                    Checked {fmt(metadata.checkedAt)}. Current application status:{" "}
                    {metadata.currentApplicationStatus}.
                  </p>
                  <ul className="space-y-1">
                    {metadata.mappings.map((m) => (
                      <li key={m.decision}>
                        {FIELDS.find((f) => f.key === m.decision)?.label}:{" "}
                        {m.targetStatus ?? "Not mapped"} —{" "}
                        {
                          {
                            unset: "Not mapped",
                            matched: "Found in default catalogue only",
                            missing: "Not found",
                            ambiguous: "Ambiguous; review required",
                            restricted:
                              "Offer or employment status; separate human process required",
                          }[m.result]
                        }
                        {m.statusId ? ` (status ID ${m.statusId})` : ""}
                        <p className="mt-1 text-muted-foreground">{m.explanation}</p>
                      </li>
                    ))}
                  </ul>
                  <p>{metadata.reason}</p>
                  <p className="font-semibold">
                    Job-specific transition permission remains unverified. Live updates are
                    disabled.
                  </p>
                </div>
              )}
            </section>
          )}
          <form
            className="min-w-0 space-y-3 rounded bg-muted/30 p-2 sm:p-3"
            data-testid="form-stage-mapping"
            onSubmit={(e) => {
              e.preventDefault();
              if (changed && lengthsOk)
                void putMapping(
                  {
                    advance: norm(draft.advance),
                    hold: norm(draft.hold),
                    decline: norm(draft.decline),
                  },
                  "save",
                );
            }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">Proposed decision to Zoho status mapping</p>
              <span className="text-xs text-muted-foreground" data-testid="text-mapping-updated">
                {h.mapping.updatedAt
                  ? `Updated by ${h.mapping.updatedBy ?? "unknown"} · ${fmt(h.mapping.updatedAt)}`
                  : "Not set yet"}
              </span>
            </div>
            {!isAdmin && (
              <p className="text-xs text-muted-foreground" data-testid="text-mapping-readonly">
                Only a tenant admin can change the proposed mapping.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {FIELDS.map((f) => (
                <label key={f.key} className="block min-w-0 space-y-1">
                  <span className="text-xs text-muted-foreground">{f.label}</span>
                  <input
                    className="block w-full min-w-0 rounded border bg-background p-2 text-sm"
                    value={draft[f.key]}
                    maxLength={MAX}
                    placeholder="No status proposed"
                    disabled={!isAdmin || !!busy}
                    data-testid={`input-mapping-${f.key}`}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                      setDirty(true);
                      setMapAck(false);
                      setTestAck(false);
                      setMetadataAck(false);
                      setMetadata(null);
                    }}
                  />
                </label>
              ))}
            </div>
            {isAdmin && (
              <>
                <label className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={mapAck}
                    disabled={!!busy}
                    data-testid="checkbox-mapping-ack"
                    onChange={(e) => setMapAck(e.target.checked)}
                  />
                  <span className="min-w-0 break-words text-sm">
                    I understand these are proposed status names saved only in Lexy. They are not
                    checked against our Zoho stages and saving them does not change Zoho.
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    className="h-auto whitespace-normal"
                    disabled={!mapAck || !changed || !lengthsOk || !!busy}
                    data-testid="button-save-mapping"
                  >
                    {busy === "save" ? "Saving proposal..." : "Save proposed mapping"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-auto whitespace-normal"
                    disabled={!mapAck || !hasAny || !!busy}
                    data-testid="button-clear-mapping"
                    onClick={() => {
                      setDraft({ advance: "", hold: "", decline: "" });
                      void putMapping({ advance: null, hold: null, decline: null }, "clear");
                    }}
                  >
                    {busy === "clear" ? "Clearing..." : "Clear all mappings"}
                  </Button>
                  {dirty && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      data-testid="button-discard-mapping"
                      onClick={() => {
                        setDraft(toDraft(h.mapping));
                        setDirty(false);
                        setMapAck(false);
                      }}
                    >
                      Discard edits
                    </Button>
                  )}
                </div>
              </>
            )}
          </form>

          <div
            className="min-w-0 space-y-3 rounded border p-2 sm:p-3"
            data-testid="panel-handoff-preview"
          >
            <p className="text-sm font-medium">What a simulation would record</p>
            <dl className="grid min-w-0 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Application</dt>
              <dd className="break-all" data-testid="text-handoff-application">
                {h.applicationId}
              </dd>
              <dt className="text-muted-foreground">Job</dt>
              <dd className="break-all" data-testid="text-handoff-job">
                {h.externalJobId}
              </dd>
              <dt className="text-muted-foreground">Candidate</dt>
              <dd className="break-all" data-testid="text-handoff-candidate">
                {h.externalCandidateId}
              </dd>
              <dt className="text-muted-foreground">Human decision</dt>
              <dd className="break-words" data-testid="text-handoff-decision">
                {h.decision
                  ? (FIELDS.find((f) => f.key === h.decision)?.label ?? h.decision)
                  : "None"}
              </dd>
              <dt className="text-muted-foreground">Proposed status</dt>
              <dd className="break-words" data-testid="text-handoff-target">
                {h.targetStatus ?? "No mapped status"}
              </dd>
              <dt className="text-muted-foreground">Live update</dt>
              <dd data-testid="text-handoff-live">Disabled</dd>
            </dl>
            <p
              className={`break-words rounded p-2 text-xs ${h.ready ? "bg-primary/5" : "border border-dashed text-muted-foreground"}`}
              data-testid="text-handoff-reason"
            >
              {h.reason}
            </p>
            <label className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={testAck}
                disabled={!h.ready || !!busy || dirty}
                data-testid="checkbox-handoff-ack"
                onChange={(e) => setTestAck(e.target.checked)}
              />
              <span className="min-w-0 break-words text-sm">
                I checked the identifiers, decision and proposed status above. Record a simulation
                only. I understand no Zoho stage will change and the candidate will not be
                contacted.
              </span>
            </label>
            {dirty && (
              <p className="text-xs text-muted-foreground">
                Save or discard mapping edits before simulating.
              </p>
            )}
            <Button
              type="button"
              className="h-auto max-w-full whitespace-normal"
              disabled={!h.ready || !testAck || !!busy || dirty}
              data-testid="button-simulate-handoff"
              onClick={() => void simulate()}
            >
              {busy === "test" ? "Recording simulation..." : "Record simulated handoff"}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Simulation history</p>
            <p className="text-xs text-muted-foreground">
              Entries are permanent and show what would have been sent. None of them changed Zoho or
              contacted anyone.
            </p>
            {h.history.length === 0 ? (
              <p
                className="rounded border border-dashed p-2 text-muted-foreground"
                data-testid="text-no-handoff-history"
              >
                No simulations recorded yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {h.history.map((e) => (
                  <li
                    key={e.id}
                    className="min-w-0 space-y-1 rounded border p-2 text-sm [overflow-wrap:anywhere]"
                    data-testid={`row-handoff-history-${e.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-dashed px-2 py-0.5 text-xs">
                        Simulated, not sent
                      </span>
                      <span className="break-words">
                        {FIELDS.find((f) => f.key === e.decision)?.label ?? e.decision} to "
                        {e.targetStatus}"
                      </span>
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      {e.approvedBy} · {fmt(e.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ZohoStageRequests
            campaignId={campaignId}
            recipientId={recipientId}
            reviewRevision={reviewRevision}
          />
        </>
      )}

      {notice && (
        <p
          role="status"
          className="break-words rounded border border-primary/40 bg-primary/5 p-3"
          data-testid="text-handoff-notice"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="break-words rounded border border-destructive/40 p-3 text-destructive"
          data-testid="text-handoff-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}
