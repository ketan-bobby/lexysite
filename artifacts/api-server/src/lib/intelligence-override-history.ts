/** JSONB stores arrays natively; older feedback writes stored JSON strings.
 * Reject malformed history instead of replacing existing oversight evidence. */
export function readOverrideHistory(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error("Intelligence override history must be an array");
  }
  return [...parsed];
}
