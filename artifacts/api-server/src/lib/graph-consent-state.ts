import { encryptSecret, decryptSecret } from "./crypto-secrets";

export interface GraphConsentState {
  state: string;
  verifier: string;
  userId: string;
  tenantId: string;
  calendar: boolean;
  issuedAt: number;
}

export function sealGraphConsent(value: GraphConsentState): string {
  return encryptSecret(JSON.stringify(value));
}

export function openGraphConsent(
  cookie: string | undefined,
  state: unknown,
  now = Date.now(),
): GraphConsentState | null {
  try {
    const value = JSON.parse(decryptSecret(cookie ?? "")) as GraphConsentState;
    if (
      typeof state !== "string" ||
      !state ||
      value.state !== state ||
      !value.userId ||
      !value.verifier ||
      typeof value.tenantId !== "string" ||
      typeof value.calendar !== "boolean" ||
      !Number.isFinite(value.issuedAt) ||
      value.issuedAt > now ||
      now - value.issuedAt > 600000
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
