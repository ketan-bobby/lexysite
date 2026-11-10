/** Canonical candidate records store name parts, not a fullName column. */
export function candidateDisplayName(
  candidate: { firstName?: string | null; lastName?: string | null } | null | undefined,
): string | null {
  if (!candidate) return null;
  return (
    [candidate.firstName?.trim(), candidate.lastName?.trim()].filter(Boolean).join(" ") || null
  );
}
