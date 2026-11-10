import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface SourcingProfileAdmissionProps {
  url: string;
  imported: boolean;
  disabled: boolean;
  onAdmit: (fullName: string, done: () => void) => void;
}

export function SourcingProfileAdmission({
  url,
  imported,
  disabled,
  onAdmit,
}: SourcingProfileAdmissionProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ack, setAck] = useState(false);
  const trimmed = name.trim();
  if (imported) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="text-profile-imported">
        Already linked to this work order.
      </p>
    );
  }
  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled}
        data-testid="button-admit-profile"
      >
        Add to Sourced
      </Button>
    );
  }
  return (
    <div
      className="min-w-0 max-w-full space-y-2 rounded border p-2 text-xs"
      data-testid="form-admit-profile"
    >
      <p>
        Open the{" "}
        <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
          public reference
        </a>{" "}
        and confirm who it belongs to. The name is not inferred from the search-result title.
      </p>
      <label className="block space-y-1">
        <span>Confirmed full name</span>
        <input
          className="min-w-0 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          value={name}
          maxLength={160}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-admit-name"
        />
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          data-testid="checkbox-admit-ack"
        />
        <span>
          New links enter Sourced; existing stages are preserved. No AI scoring, assessment,
          enrichment, invitation or outreach happens. Provider costs remain unknown and there is no
          billing prerequisite.
        </span>
      </label>
      <div className="flex flex-wrap gap-2 [&>button]:h-auto [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-2">
        <Button
          size="sm"
          disabled={disabled || !ack || trimmed.length < 2}
          onClick={() =>
            onAdmit(trimmed, () => {
              setOpen(false);
              setName("");
              setAck(false);
            })
          }
          data-testid="button-admit-confirm"
        >
          Confirm and add to Sourced
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={disabled}>
          Close
        </Button>
      </div>
    </div>
  );
}
