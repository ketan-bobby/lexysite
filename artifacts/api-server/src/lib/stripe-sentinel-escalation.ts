import { isPublicNotificationAddress } from "./notification-address";

type Recipient = { id: string; email: string | null };
export type SentinelEmailDecision = "production" | "authorized_test" | "non_public" | "environment";

/**
 * Non-production mail is denied by default. The allowlist is injectable only
 * by an isolated test harness; the running server supplies no override.
 * Unknown environments fail safe rather than treating a missing NODE_ENV as prod.
 */
export function sentinelEmailDecision(
  environment: string | undefined,
  email: string,
  testRecipients: readonly string[] = [],
): SentinelEmailDecision {
  if (!isPublicNotificationAddress(email)) return "non_public";
  if (environment === "production") return "production";
  const allowed = new Set(testRecipients.map((s) => s.trim().toLowerCase()));
  return allowed.has(email.trim().toLowerCase()) ? "authorized_test" : "environment";
}

export async function escalateStripeDormancy<T extends Recipient>({
  admins,
  environment,
  notify,
  send,
  suppressed,
  testRecipients = [],
}: {
  admins: readonly T[];
  environment: string | undefined;
  notify: (admin: T) => Promise<unknown>;
  send: (email: string, admin: T) => Promise<unknown>;
  suppressed: (admin: T, reason: "non_public" | "environment") => void;
  testRecipients?: readonly string[];
}) {
  let emailAttempts = 0;
  for (const admin of admins) {
    // Keep the internal warning even when external delivery is suppressed.
    await notify(admin).catch(() => {});
    if (!admin.email) continue;
    const decision = sentinelEmailDecision(environment, admin.email, testRecipients);
    if (decision === "environment" || decision === "non_public") {
      suppressed(admin, decision);
      continue;
    }
    emailAttempts++;
    await send(admin.email, admin).catch(() => {});
  }
  return { admins: admins.length, emailAttempts };
}
