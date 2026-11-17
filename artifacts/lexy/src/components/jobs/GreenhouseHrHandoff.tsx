import { useState } from "react";
import type { AtsHandoffState } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { greenhouseHrHandoff } from "@/lib/greenhouse-hr-handoff";

export function GreenhouseHrHandoff({
  state,
  enabled,
}: {
  state: AtsHandoffState;
  enabled: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  if (state.mapping?.system.trim().toLowerCase() !== "greenhouse") return null;
  const text = enabled ? greenhouseHrHandoff(state) : null;
  return (
    <section className="space-y-2 border-t pt-2" aria-label="Greenhouse HR handoff guide">
      <p className="font-medium">Continue with employer HR in Greenhouse</p>
      <p>
        Manual handoff only. HR must match the job, candidate and application in its own account,
        inspect any existing offer and complete required fields, negotiations and approvals there.
        Lexy does not create, update, approve or send a Greenhouse offer.
      </p>
      {text ? (
        <>
          <label className="block space-y-1">
            <span>Copyable HR review reference — not published to Greenhouse</span>
            <textarea
              className="min-h-48 w-full rounded border bg-background p-2"
              readOnly
              value={text}
              data-testid="greenhouse-hr-reference"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            data-testid="greenhouse-hr-copy"
            onClick={async () => {
              setCopied(false);
              setCopyFailed(false);
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
              } catch {
                setCopyFailed(true);
              }
            }}
          >
            Copy HR review reference
          </Button>
          {copied && <p role="status">Copied locally. Nothing was sent to Greenhouse.</p>}
          {copyFailed && (
            <p role="status">Clipboard unavailable. Select and copy the reference text above.</p>
          )}
        </>
      ) : (
        <p role="status">
          Approve and export the current Greenhouse packet first. The reference is hidden while
          changes are unsaved, access is being refreshed, or the saved handoff is unavailable.
        </p>
      )}
    </section>
  );
}
