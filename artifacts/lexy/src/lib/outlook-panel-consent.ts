export interface OutlookPanelConsent {
  enabled: boolean;
  grantedAt: string | null;
}

export function parseOutlookPanelConsent(value: unknown): OutlookPanelConsent | null {
  if (!value || typeof value !== "object" || !("enabled" in value) || !("grantedAt" in value))
    return null;
  if (typeof value.enabled !== "boolean") return null;
  if (value.enabled) {
    if (typeof value.grantedAt !== "string" || !Number.isFinite(Date.parse(value.grantedAt)))
      return null;
    return { enabled: true, grantedAt: value.grantedAt };
  }
  return value.grantedAt === null ? { enabled: false, grantedAt: null } : null;
}

/** A pre-save read must not overwrite the newly confirmed choice on completion. */
export async function saveOutlookPanelConsent(
  enabled: boolean,
  dependencies: {
    cancelPendingRead: () => Promise<unknown>;
    write: (enabled: boolean) => Promise<unknown>;
  },
): Promise<OutlookPanelConsent> {
  await dependencies.cancelPendingRead();
  const receipt = parseOutlookPanelConsent(await dependencies.write(enabled));
  if (!receipt || receipt.enabled !== enabled) throw new Error("unconfirmed");
  return receipt;
}
