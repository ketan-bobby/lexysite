/**
 * lib/candidate-merge.ts — Candidate de-duplication / merge helper
 *
 * One person should exist as exactly ONE candidate row per tenant, keyed on
 * (tenant_id, lower(email)). When a recruiter adds/uploads someone whose email
 * already exists, the route surfaces a merge PROMPT built from
 * computeCandidateMerge() and — on confirmation (mergeIntoExisting:true) —
 * updates the existing row with the newer info instead of creating a duplicate.
 *
 * "Newer info wins": for scalar fields, a non-empty incoming value that differs
 * from the stored value replaces it. Skills are UNIONED (additive) so a partial
 * upload never drops previously-known skills. Empty/absent incoming fields never
 * blank out existing data.
 */

/** Subset of candidate columns that an add/upload can contribute. */
export interface MergeableCandidate {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  location?: string | null;
  currentTitle?: string | null;
  currentCompany?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  resumeUrl?: string | null;
  skills?: string[] | null;
}

export interface FieldChange {
  field: string;
  /** Human-readable label for the merge-prompt UI. */
  label: string;
  from: string | null;
  to: string | null;
}

export interface CandidateMergeResult {
  /** Column → value patch to apply to the existing row (already includes updatedAt). */
  values: Record<string, unknown>;
  /** Per-field diffs for the recruiter prompt. Empty ⇒ nothing new to apply. */
  changes: FieldChange[];
}

const SCALAR_FIELDS: { key: keyof MergeableCandidate; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "currentTitle", label: "Current title" },
  { key: "currentCompany", label: "Current company" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "githubUrl", label: "GitHub URL" },
  { key: "resumeUrl", label: "Resume" },
];

function norm(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/**
 * Compute the merge of `incoming` (the newly added/uploaded data) into
 * `existing` (the stored candidate). Returns the column patch plus a per-field
 * diff for the prompt. If `changes` is empty there is nothing new to apply.
 */
export function computeCandidateMerge(
  existing: MergeableCandidate,
  incoming: MergeableCandidate,
): CandidateMergeResult {
  const values: Record<string, unknown> = {};
  const changes: FieldChange[] = [];

  for (const { key, label } of SCALAR_FIELDS) {
    const next = norm(incoming[key]);
    if (!next) continue; // never blank out existing data with an empty upload
    const prev = norm(existing[key]);
    if (next.toLowerCase() === prev.toLowerCase()) continue; // unchanged
    values[key] = next;
    changes.push({ field: key, label, from: prev || null, to: next });
  }

  // Skills: additive union (case-insensitive de-dupe), original casing preserved.
  const incomingSkills = Array.isArray(incoming.skills)
    ? incoming.skills.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (incomingSkills.length > 0) {
    const existingSkills = Array.isArray(existing.skills)
      ? existing.skills.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const seen = new Set(existingSkills.map((s) => s.toLowerCase()));
    const added: string[] = [];
    for (const s of incomingSkills) {
      if (!seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        added.push(s);
      }
    }
    if (added.length > 0) {
      values.skills = [...existingSkills, ...added];
      changes.push({
        field: "skills",
        label: "Skills",
        from: existingSkills.length ? existingSkills.join(", ") : null,
        to: added.join(", "),
      });
    }
  }

  if (changes.length > 0) values.updatedAt = new Date();
  return { values, changes };
}
