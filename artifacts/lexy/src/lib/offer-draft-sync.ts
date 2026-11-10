/** A remote version must never silently replace a human's unsaved offer text. */
export function offerDraftSync(
  baseKey: string | null,
  currentKey: string,
  dirty: boolean,
): "sync" | "keep" | "conflict" {
  if (baseKey === currentKey) return "keep";
  if (baseKey !== null && dirty) return "conflict";
  return "sync";
}
