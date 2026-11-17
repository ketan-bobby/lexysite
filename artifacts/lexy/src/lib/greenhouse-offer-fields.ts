import type {
  GreenhouseOfferProposal,
  GreenhouseOfferWorkspace,
} from "@workspace/api-client-react";

export type FieldType = "text" | "number" | "currency";
export type Row = { id: string; name: string; type: FieldType; value: string; currency: string };
export type Form = {
  openingId: string;
  startDate: string;
  approverId: string;
  submitterId: string;
  rows: Row[];
};

export const EMPTY_FORM: Form = {
  openingId: "",
  startDate: "",
  approverId: "",
  submitterId: "",
  rows: [],
};

/** Attempt states exactly as the backend reports them. */
export const RESOLVED_ATTEMPT_STATES = [
  "prepared",
  "approved",
  "verified_submission",
  "not_sent",
] as const;
export const RECOVERABLE_ATTEMPT_STATES = [
  "claimed",
  "draft_created",
  "provider_accepted",
  "review_required",
  "observed_match",
  "observed_other",
] as const;

export function fromProposal(p: GreenhouseOfferProposal | null, rid: () => string): Form {
  if (!p) return EMPTY_FORM;
  return {
    openingId: p.openingId ?? "",
    startDate: p.startDate ?? "",
    approverId: p.approverId,
    submitterId: p.submitterId,
    rows: Object.entries(p.values).map(([name, v]) =>
      typeof v === "object"
        ? { id: rid(), name, type: "currency", value: String(v.amountMinor), currency: v.currency }
        : typeof v === "number"
          ? { id: rid(), name, type: "number", value: String(v), currency: "" }
          : { id: rid(), name, type: "text", value: v, currency: "" },
    ),
  };
}

export function toProposal(f: Form): { proposal?: GreenhouseOfferProposal; error?: string } {
  if (!f.approverId || !f.submitterId) return { error: "Choose an approver and a submitter." };
  if (f.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.startDate))
    return { error: "Start date must be YYYY-MM-DD." };
  const values: GreenhouseOfferProposal["values"] = {};
  for (const r of f.rows) {
    const name = r.name.trim();
    if (
      !/^[a-z][a-z0-9_]{0,79}$/.test(name) ||
      ["constructor", "prototype", "__proto__"].includes(name)
    )
      return { error: "Use employer field keys in lowercase, with numbers or underscores only." };
    if (Object.prototype.hasOwnProperty.call(values, name))
      return { error: `Field "${name}" appears twice.` };
    if (r.type === "text") values[name] = r.value;
    else if (r.type === "number") {
      const n = Number(r.value);
      if (r.value.trim() === "" || !Number.isFinite(n))
        return { error: `"${name}" must be a number.` };
      values[name] = n;
    } else {
      const raw = r.value.trim();
      if (!/^\d+$/.test(raw))
        return { error: `"${name}" must be a whole number of minor units (for example cents).` };
      const amountMinor = Number(raw);
      if (!Number.isSafeInteger(amountMinor)) return { error: `"${name}" is too large.` };
      if (!/^[A-Z]{3}$/.test(r.currency))
        return { error: `"${name}" needs a 3-letter currency code.` };
      values[name] = { amountMinor, currency: r.currency };
    }
  }
  return {
    proposal: {
      openingId: f.openingId.trim() || null,
      startDate: f.startDate || null,
      approverId: f.approverId,
      submitterId: f.submitterId,
      values,
    },
  };
}

type Ws = Pick<
  GreenhouseOfferWorkspace,
  | "executionMode"
  | "blockers"
  | "controlRevision"
  | "canEdit"
  | "canApprove"
  | "canSubmit"
  | "proposal"
  | "attempt"
>;

const ready = (ws: Ws) =>
  ws.executionMode !== "unavailable" && ws.blockers.length === 0 && !!ws.controlRevision;

export const canPrepare = (ws: Ws) => ready(ws) && ws.canEdit && !!ws.proposal;
export const canApproveOp = (ws: Ws) => ready(ws) && ws.canApprove && !!ws.attempt;
export const canSubmitOp = (ws: Ws) => ready(ws) && ws.canSubmit && !!ws.attempt;
/** Read-only recovery; never offered without a provider (unavailable mode). */
export const canRecover = (ws: Ws) =>
  ws.executionMode !== "unavailable" &&
  !!ws.attempt &&
  (RECOVERABLE_ATTEMPT_STATES as readonly string[]).includes(ws.attempt.state);
