import React from "react";
/** Only display the structured, server-recorded Graph fields, never raw metadata. */
export function GraphMailEvidence({ metadata }: { metadata?: Record<string, unknown> | null }) {
  if (metadata?.transport !== "graph") return null;
  const labels: Record<string, string> = {
    accepted: "Outlook accepted the request for processing.",
    unknown: "Outlook outcome uncertain. Review the original attempt before any resend.",
    rejected: "Outlook explicitly rejected this request. An alternate provider may have been used.",
    not_attempted: "Outlook was not attempted. An alternate provider may have been used.",
  };
  const status = typeof metadata.acceptance === "string" ? labels[metadata.acceptance] : undefined;
  const safeId = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(v) ? v : null;
  const client = safeId(metadata.clientRequestId),
    provider = safeId(metadata.providerRequestId);
  return (
    <React.Fragment>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <p>{status ?? "No structured Outlook acceptance result was recorded."}</p>
        <p>Recipient delivery and reading are unverified. Request IDs are not email message IDs.</p>
        {metadata.fallbackPrevented === true && <p>No automatic SES fallback was attempted.</p>}
        {client && (
          <p>
            Lexy request reference: <span className="font-mono">{client}</span>
          </p>
        )}
        {provider && (
          <p>
            Microsoft request reference: <span className="font-mono">{provider}</span>
          </p>
        )}
      </div>
    </React.Fragment>
  );
}
