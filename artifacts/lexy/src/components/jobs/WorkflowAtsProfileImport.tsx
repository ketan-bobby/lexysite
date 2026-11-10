import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsProfileQueryKey,
  useControlCandidateAtsProfile,
  useGetCandidateAtsProfile,
  type AtsCandidateProfilePreview,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";

export function WorkflowAtsProfileImport({
  jobId,
  workflowId,
  recordId,
  bindingRevision,
  workflowRevision,
  importRevision,
}: {
  jobId: string;
  workflowId: string;
  recordId: string;
  bindingRevision: number;
  workflowRevision: number;
  importRevision: number;
}) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsProfileQueryKey(jobId, workflowId, recordId);
  const q = useGetCandidateAtsProfile(jobId, workflowId, recordId, {
    query: {
      queryKey: key,
      refetchOnMount: "always",
      staleTime: 0,
      gcTime: 0,
      retry: false,
    },
  });
  const m = useControlCandidateAtsProfile({ mutation: { retry: false, gcTime: 0 } });
  const resetRef = useRef(m.reset);
  resetRef.current = m.reset;

  const scope = `${jobId}|${workflowId}|${recordId}|${bindingRevision}|${workflowRevision}|${importRevision}`;
  const epoch = useRef(0);
  const lastScope = useRef(scope);
  const submitting = useRef(false);
  const [authority, setAuthority] = useState(false);
  const [includePro, setIncludePro] = useState(false);
  const [preview, setPreview] = useState<AtsCandidateProfilePreview | null>(null);
  const [email, setEmail] = useState("");
  const [linkId, setLinkId] = useState<string | null>(null);
  const [linkOk, setLinkOk] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const clearFlow = () => {
    setPreview(null);
    setEmail("");
    setLinkId(null);
    setLinkOk(false);
    setReviewed(false);
  };

  if (lastScope.current !== scope) {
    lastScope.current = scope;
    epoch.current++;
    submitting.current = false;
  }
  useEffect(() => {
    epoch.current++;
    submitting.current = false;
    setAuthority(false);
    setIncludePro(false);
    clearFlow();
    setError(null);
    setMsg(null);
    resetRef.current();
    void qc.invalidateQueries({ queryKey: key });
  }, [scope]);
  useEffect(
    () => () => {
      epoch.current++;
      resetRef.current();
    },
    [],
  );

  const state = q.isError ? undefined : q.data;
  const stale =
    !!state &&
    (state.bindingRevision !== bindingRevision ||
      state.workflowRevision !== workflowRevision ||
      state.importRevision !== importRevision);

  useEffect(() => {
    if (q.isError || stale || state?.canImport === false) {
      epoch.current++;
      submitting.current = false;
      clearFlow();
      setAuthority(false);
      setMsg(null);
    }
  }, [q.isError, stale, state?.canImport]);

  const refetchState = () => qc.invalidateQueries({ queryKey: key });

  const send = (action: "preview" | "import") => {
    if (!state || stale || submitting.current) return;
    if (action === "import" && !preview) return;
    submitting.current = true;
    const id = ++epoch.current;
    const sentPreview = preview;
    setError(null);
    setMsg(null);
    const mine = () => id === epoch.current;
    m.mutate(
      {
        jobId,
        workflowId,
        recordId,
        data: {
          action,
          expectedWorkflowRevision: state.workflowRevision,
          expectedBindingRevision: state.bindingRevision,
          expectedImportRevision: state.importRevision,
          idempotencyKey: crypto.randomUUID(),
          acknowledge: true,
          includeProfessional:
            action === "import" && sentPreview ? sentPreview.includeProfessional : includePro,
          ...(action === "import" && sentPreview
            ? {
                previewToken: sentPreview.token,
                email,
                ...(linkId ? { existingCandidateId: linkId } : {}),
              }
            : {}),
        },
      },
      {
        onSuccess: (res) => {
          if (!mine()) return;
          submitting.current = false;
          const current = qc.getQueryData<typeof res.state>(key);
          if (
            qc.getQueryState(key)?.status === "error" ||
            !current?.canImport ||
            current.workflowRevision !== res.state.workflowRevision ||
            current.bindingRevision !== res.state.bindingRevision ||
            current.importRevision !== res.state.importRevision ||
            (current.candidateId && current.candidateId !== res.state.candidateId)
          ) {
            clearFlow();
            setAuthority(false);
            void refetchState();
            return;
          }
          if (action === "preview") {
            if (!res.preview) {
              clearFlow();
              setAuthority(false);
              qc.setQueryData(key, res.state);
              setMsg(res.state.candidateId ? "This profile was already imported." : null);
              if (!res.state.candidateId) setError("Preview unavailable.");
              return;
            }
            setPreview(res.preview);
            setEmail(res.preview.emails[0] ?? "");
            setLinkId(null);
            setLinkOk(false);
            setReviewed(false);
            qc.setQueryData(key, res.state);
          } else {
            clearFlow();
            setAuthority(false);
            qc.setQueryData(key, res.state);
            qc.invalidateQueries({
              predicate: (qq) => String(qq.queryKey[0]).startsWith("/api/candidates"),
            });
            setMsg(
              res.outcome === "linked"
                ? "Linked to the existing local profile. It was not changed."
                : res.outcome === "already_imported"
                  ? "This record was already imported."
                  : "Local candidate profile created.",
            );
            refetchState();
          }
        },
        onError: (e) => {
          if (!mine()) return;
          submitting.current = false;
          clearFlow();
          setAuthority(false);
          setError(errText(e));
          refetchState();
        },
      },
    );
  };

  const busy = m.isPending;
  const matches = preview ? preview.matches.filter((x) => x.email === email) : [];
  const canPreview =
    !!state && !stale && state.canImport && !state.candidateId && authority && !busy;
  const canImport =
    !!preview &&
    !!email &&
    reviewed &&
    !busy &&
    !stale &&
    (matches.length === 0 || (!!linkId && linkOk)) &&
    !submitting.current;

  return (
    <div
      className="space-y-1 border-t border-border pt-1"
      role="group"
      aria-label="Candidate profile intake"
      data-testid={`ats-profile-${recordId}`}
    >
      <p className="font-medium">Local candidate profile</p>
      {q.isLoading && (
        <p role="status" className="text-muted-foreground">
          Loading profile status
        </p>
      )}
      {q.isError && (
        <div role="alert" className="text-destructive">
          Could not load profile status. Controls are hidden until it loads and is reviewed again.{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Reload
          </Button>
        </div>
      )}
      {stale && (
        <div role="alert" className="text-destructive">
          This record changed since it was displayed. Reload to review current state.{" "}
          <Button size="sm" variant="outline" onClick={() => refetchState()}>
            Reload
          </Button>
        </div>
      )}
      {state && !stale && state.candidateId && (
        <p data-testid={`ats-profile-linked-${recordId}`} className="[overflow-wrap:anywhere]">
          Linked to local candidate {state.candidateId}
          {state.importedAt ? ` · ${new Date(state.importedAt).toLocaleString()}` : ""}. Native
          profile was not overwritten.
        </p>
      )}
      {state && !stale && !state.candidateId && !state.canImport && (
        <p className="text-muted-foreground">
          Profile import is not available for this record right now.
        </p>
      )}
      {state && !stale && !state.candidateId && state.canImport && !preview && (
        <div className="space-y-1">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={authority}
              disabled={busy}
              onChange={(e) => setAuthority(e.target.checked)}
              data-testid={`ats-profile-authority-${recordId}`}
            />
            <span>
              I am authorised to read and import this candidate&apos;s name and email from the ATS,
              and optionally current title and company.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={includePro}
              disabled={busy}
              onChange={(e) => setIncludePro(e.target.checked)}
            />
            <span>Also include current title and company</span>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!canPreview}
            onClick={() => send("preview")}
            data-testid={`ats-profile-preview-${recordId}`}
          >
            Preview profile
          </Button>
        </div>
      )}
      {state && !stale && !state.candidateId && preview && (
        <div className="space-y-1" data-testid={`ats-profile-review-${recordId}`}>
          <ul className="[overflow-wrap:anywhere]">
            <li>
              Name: {preview.firstName} {preview.lastName}
            </li>
            {preview.includeProfessional && (
              <>
                <li>Current title: {preview.currentTitle ?? "none"}</li>
                <li>Current company: {preview.currentCompany ?? "none"}</li>
              </>
            )}
          </ul>
          {preview.emails.length === 0 ? (
            <p role="alert" className="text-destructive">
              No email returned; cannot import.
            </p>
          ) : (
            <fieldset className="space-y-0.5" disabled={busy}>
              <legend>Email to save</legend>
              {preview.emails.map((em) => (
                <label key={em} className="flex items-start gap-2 [overflow-wrap:anywhere]">
                  <input
                    type="radio"
                    name={`ats-profile-email-${recordId}`}
                    checked={email === em}
                    onChange={() => {
                      setEmail(em);
                      setLinkId(null);
                      setLinkOk(false);
                      setReviewed(false);
                    }}
                  />
                  <span>{em}</span>
                </label>
              ))}
            </fieldset>
          )}
          {matches.length > 0 && (
            <div className="space-y-0.5">
              <p>
                An existing local profile matches this ATS identity. Confirm the link to avoid a
                duplicate.
              </p>
              {matches.map((x) => (
                <label
                  key={x.candidateId}
                  className="flex items-start gap-2 [overflow-wrap:anywhere]"
                >
                  <input
                    type="radio"
                    name={`ats-profile-link-${recordId}`}
                    checked={linkId === x.candidateId}
                    disabled={busy}
                    onChange={() => {
                      setLinkId(x.candidateId);
                      setLinkOk(false);
                      setReviewed(false);
                    }}
                  />
                  <span>
                    Link existing {x.firstName} {x.lastName} ({x.candidateId})
                  </span>
                </label>
              ))}
              {linkId && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={linkOk}
                    disabled={busy}
                    onChange={(e) => setLinkOk(e.target.checked)}
                  />
                  <span>Link to this existing profile. Its data will not be overwritten.</span>
                </label>
              )}
              {!linkId && <p className="text-destructive">Select a profile to link to continue.</p>}
            </div>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={busy}
              onChange={(e) => setReviewed(e.target.checked)}
              data-testid={`ats-profile-reviewed-${recordId}`}
            />
            <span>
              I reviewed this profile and scope. No native stage, application, offer, message,
              consent or account changes are made.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canImport || (matches.length > 0 && !linkId)}
              onClick={() => send("import")}
              data-testid={`ats-profile-import-${recordId}`}
            >
              Import profile
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                epoch.current++;
                clearFlow();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {busy && (
        <p role="status" className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive" data-testid={`ats-profile-error-${recordId}`}>
          {error} Preview cleared; review again.
        </p>
      )}
      {msg && (
        <p role="status" data-testid={`ats-profile-success-${recordId}`}>
          {msg}
        </p>
      )}
    </div>
  );
}
