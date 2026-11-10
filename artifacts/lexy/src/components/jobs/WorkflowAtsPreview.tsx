import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsVerificationQueryKey,
  getGetCandidateAtsImportsQueryKey,
  useGetCandidateAtsImports,
  useImportCandidateAtsRecords,
  usePreviewCandidateAtsRecords,
  type AtsPreviewPage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";
import { WorkflowAtsBatchRefresh } from "./WorkflowAtsBatchRefresh";
import { WorkflowAtsRefreshSchedule } from "./WorkflowAtsRefreshSchedule";

export function WorkflowAtsPreview({
  jobId,
  workflowId,
  bindingRevision,
  workflowRevision,
}: {
  jobId: string;
  workflowId: string;
  bindingRevision: number;
  workflowRevision: number;
}) {
  const qc = useQueryClient();
  const m = usePreviewCandidateAtsRecords({ mutation: { retry: false, gcTime: 0 } });
  const [page, setPage] = useState<AtsPreviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imp = useImportCandidateAtsRecords({ mutation: { retry: false, gcTime: 0 } });
  const impResetRef = useRef(imp.reset);
  impResetRef.current = imp.reset;
  const [ack, setAck] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedMsg, setImportedMsg] = useState<string | null>(null);
  const submitting = useRef(false);
  const imports = useGetCandidateAtsImports(jobId, workflowId, {
    query: {
      queryKey: getGetCandidateAtsImportsQueryKey(jobId, workflowId),
      refetchInterval: 15000,
      refetchOnMount: "always",
      staleTime: 0,
      gcTime: 0,
    },
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const mounted = useRef(true);
  const reqId = useRef(0);
  const resetRef = useRef(m.reset);
  resetRef.current = m.reset;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resetRef.current();
      impResetRef.current();
    };
  }, []);

  const load = (cursor?: string) => {
    const id = ++reqId.current;
    setPage(null);
    setError(null);
    setSelected(new Set());
    setAck(false);
    setImportError(null);
    setImportedMsg(null);
    m.mutate(
      {
        jobId,
        workflowId,
        data: {
          expectedBindingRevision: bindingRevision,
          expectedWorkflowRevision: workflowRevision,
          ...(cursor ? { cursor } : {}),
        },
      },
      {
        onSuccess: (p) => {
          if (!mounted.current || id !== reqId.current) return;
          setPage(p);
        },
        onError: (e) => {
          if (!mounted.current || id !== reqId.current) return;
          setPage(null);
          setSelected(new Set());
          setError(errText(e));
          qc.invalidateQueries({
            queryKey: getGetCandidateAtsVerificationQueryKey(jobId, workflowId),
          });
        },
      },
    );
  };

  const importing = imp.isPending;
  const busy = m.isPending || importing;
  const canImport = selected.size >= 1 && selected.size <= 10 && ack && !busy;
  const doImport = () => {
    if (!canImport || !page || submitting.current) return;
    submitting.current = true;
    const id = ++reqId.current;
    setImportError(null);
    setImportedMsg(null);
    imp.mutate(
      {
        jobId,
        workflowId,
        data: {
          expectedBindingRevision: bindingRevision,
          expectedWorkflowRevision: workflowRevision,
          previewToken: page.previewToken,
          applicationIds: Array.from(selected),
          acknowledgeMetadataOnly: true,
        },
      },
      {
        onSuccess: (result) => {
          submitting.current = false;
          qc.invalidateQueries({ queryKey: getGetCandidateAtsImportsQueryKey(jobId, workflowId) });
          if (!mounted.current || id !== reqId.current) return;
          setSelected(new Set());
          setAck(false);
          setImportedMsg(
            `${result.importedCount} imported, ${result.existingCount} already existed. Saved metadata only; no native pipeline changes.`,
          );
        },
        onError: (e) => {
          submitting.current = false;
          qc.invalidateQueries({
            queryKey: getGetCandidateAtsVerificationQueryKey(jobId, workflowId),
          });
          if (!mounted.current || id !== reqId.current) return;
          setPage(null);
          setSelected(new Set());
          setAck(false);
          setImportError(errText(e));
        },
      },
    );
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div
      className="space-y-1.5 border-t border-border pt-2"
      role="group"
      aria-label="Greenhouse read-only preview"
      data-testid={`ats-preview-${workflowId}`}
    >
      <p className="font-medium">Greenhouse read-only preview</p>
      <p className="text-muted-foreground">
        Reads applications for the saved mapped job only, not all employer jobs. Loading a preview
        saves nothing. Select records below, then explicitly import them; only selected records are
        saved, as metadata only.
      </p>
      <div className="flex flex-wrap gap-2">
        {!page && !error && !importError && !busy && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => load()}
            data-testid={`ats-preview-load-${workflowId}`}
          >
            Load preview from Greenhouse
          </Button>
        )}
        {page?.nextCursor && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => load(page.nextCursor ?? undefined)}
            data-testid={`ats-preview-next-${workflowId}`}
          >
            Next page
          </Button>
        )}
        {(page || error || importError) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => load()}
            data-testid={`ats-preview-restart-${workflowId}`}
          >
            Restart from first page
          </Button>
        )}
      </div>
      {busy && (
        <p role="status" className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading preview
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-destructive"
          data-testid={`ats-preview-error-${workflowId}`}
        >
          Preview failed. {error}
        </p>
      )}
      {importing && (
        <p role="status" className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing
        </p>
      )}
      {importError && (
        <p role="alert" className="text-destructive" data-testid={`ats-import-error-${workflowId}`}>
          Import failed. {importError}
        </p>
      )}
      {importedMsg && (
        <p role="status" data-testid={`ats-import-success-${workflowId}`}>
          {importedMsg}
        </p>
      )}
      {page && (
        <div className="space-y-1" data-testid={`ats-preview-result-${workflowId}`}>
          <p className="[overflow-wrap:anywhere]">
            Job {page.job.name} ({page.job.id}) · {page.job.status} · checked{" "}
            {new Date(page.checkedAt).toLocaleString()}
          </p>
          {page.applications.length === 0 ? (
            <p className="text-muted-foreground">No applications on this page.</p>
          ) : (
            <ul className="space-y-0.5">
              {page.applications.map((a) => (
                <li key={a.id}>
                  <label className="flex items-start gap-2 [overflow-wrap:anywhere]">
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      disabled={busy}
                      onChange={() => toggle(a.id)}
                      data-testid={`ats-preview-select-${a.id}`}
                    />
                    <span>
                      Application {a.id} · Candidate {a.candidateId} · {a.status} ·{" "}
                      {a.stageName ?? "no stage"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground" data-testid={`ats-preview-count-${workflowId}`}>
            {selected.size} selected (max 10). Nothing is saved until you import.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
              data-testid={`ats-import-ack-${workflowId}`}
            />
            <span>
              I understand only application metadata is saved. No candidate profiles, native stages,
              outreach or offers are created, and there is no automatic sync afterwards (a separate
              explicit read-only refresh is available per record).
            </span>
          </label>
          <Button
            size="sm"
            disabled={!canImport}
            onClick={doImport}
            data-testid={`ats-import-submit-${workflowId}`}
          >
            Import selected metadata
          </Button>
        </div>
      )}
      <div
        className="space-y-1 border-t border-border pt-2"
        data-testid={`ats-imports-${workflowId}`}
      >
        <p className="font-medium">Imported records</p>
        <p className="text-muted-foreground">
          Saved metadata from the original import or a later successful check. There is no automatic
          or background sync; explicit, read-only refreshes of one or selected records only update
          the saved metadata here. The remote job stays authoritative; stages here are not editable.
        </p>
        <WorkflowAtsRefreshSchedule
          key={`${jobId}|${workflowId}|${bindingRevision}|${workflowRevision}`}
          jobId={jobId}
          workflowId={workflowId}
          bindingRevision={bindingRevision}
          workflowRevision={workflowRevision}
          records={imports.data?.records ?? []}
          recordsUnavailable={imports.isError || imports.isLoading}
        />
        {imports.isLoading && (
          <p role="status" className="text-muted-foreground">
            Loading imported records
          </p>
        )}
        {imports.isError && (
          <div role="alert" className="text-destructive">
            Could not load imported records.{" "}
            <Button size="sm" variant="outline" onClick={() => imports.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {!imports.isError && imports.data && imports.data.records.length === 0 && (
          <p className="text-muted-foreground">No records imported yet.</p>
        )}
        {!imports.isError && imports.data && imports.data.records.length > 0 && (
          <WorkflowAtsBatchRefresh
            key={`${jobId}:${workflowId}:${bindingRevision}:${workflowRevision}`}
            jobId={jobId}
            workflowId={workflowId}
            bindingRevision={bindingRevision}
            workflowRevision={workflowRevision}
            records={imports.data.records}
            truncated={imports.data.truncated}
          />
        )}
      </div>
    </div>
  );
}
