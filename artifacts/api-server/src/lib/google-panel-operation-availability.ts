import { and, inArray } from "drizzle-orm";
import { dbAdmin, staffGoogleCalendarsTable as grants } from "@workspace/db";
import { digest, googleStaffConfig, googleStaffFailure } from "./google-staff-config";
import { googleStaffProvider } from "./google-staff-provider";
import { googleStaffStore } from "./google-staff-store";
import { openGoogleCredential, sealGoogleCredential } from "./google-staff-service";
import { googleInvitationSnapshot } from "./google-invitation-identity";
import {
  googleInterviewEventChanges,
  type GoogleObservedEvent,
} from "./google-interview-event-changes";
import type { GoogleEventDetails } from "./google-interview-event";
import type { GoogleInvitationCaller, GoogleInvitationReview } from "./google-invitation-store";

export type PreparedGooglePanelOperation = {
  access: (current: GoogleInvitationReview) => string;
  check: (
    current: GoogleInvitationReview,
    details: GoogleEventDetails,
    source: GoogleObservedEvent,
  ) => Promise<void>;
};

/** Credential maintenance commits BEFORE any schedule/panel read locks. The
 * returned capability is short-lived, private and usable only with fresh,
 * locked account/consent/panel/job and working-hours evidence.
 */
export async function prepareGooglePanelOperation(
  caller: GoogleInvitationCaller,
  original: GoogleInvitationReview,
  database: Pick<typeof dbAdmin, "transaction"> = dbAdmin,
  provider = googleStaffProvider,
  events = googleInterviewEventChanges(),
): Promise<PreparedGooglePanelOperation> {
  const fail = () => googleStaffFailure("google_panel_availability_unknown", 503);
  const cfg = googleStaffConfig(),
    panel = original.panel;
  if (!cfg || !panel || !original.connection) throw fail();
  const ids = [...new Set([caller.id, ...panel.recipients.map((p) => p.userId)])].sort();
  const tenants = [
    ...new Set(
      [caller.tenantId, original.context.job.tenantId].filter((value): value is string => !!value),
    ),
  ];
  const connections = await database.transaction((tx) =>
    tx
      .select()
      .from(grants)
      .where(and(inArray(grants.userId, ids), inArray(grants.tenantId, tenants))),
  );
  if (connections.length !== ids.length) throw fail();
  const tokens = new Map<string, string>();
  const fingerprint = googleInvitationSnapshot(original, caller);
  const buffer = panel.bufferMinutes ?? 0;
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 120) throw fail();
  try {
    for (const c of connections) {
      const member = panel.recipients.find((p) => p.userId === c.userId);
      if (
        !c.refreshTokenEnc ||
        c.needsReconnect ||
        !c.subject ||
        !c.accountEmail ||
        c.clientFingerprint !== cfg.fingerprint ||
        (c.userId === caller.id
          ? c.tenantId !== caller.tenantId ||
            c.revision !== original.connection.revision ||
            c.subject !== original.connection.subject ||
            !c.invitationConsent
          : !member ||
            member.connectionRevision !== c.revision ||
            member.subjectHash !== digest(c.subject) ||
            member.email !== c.accountEmail.trim().toLowerCase())
      )
        throw fail();
      const actor = { id: c.userId, tenantId: c.tenantId };
      const token = await provider(cfg).refresh(
        openGoogleCredential(actor, "refresh", c.refreshTokenEnc),
      );
      if (token.refreshToken) {
        const next = sealGoogleCredential(actor, "refresh", token.refreshToken);
        const rotated = await database.transaction((tx) =>
          googleStaffStore(tx).rotate(actor, c.revision, c.refreshTokenEnc!, next),
        );
        if (!rotated) throw fail();
      }
      tokens.set(c.userId, token.accessToken);
    }
  } catch {
    // A member's failed token must not revoke the organizer's independent grant,
    // disclose an account, or discard a rotation already committed for another.
    throw fail();
  }
  const preparedAt = Date.now();
  function current(r: GoogleInvitationReview) {
    if (
      Date.now() - preparedAt > 60_000 ||
      Date.now() < preparedAt ||
      googleStaffConfig()?.fingerprint !== cfg!.fingerprint ||
      r.panel?.binding !== panel!.binding ||
      (r.panel.bufferMinutes ?? 0) !== buffer ||
      googleInvitationSnapshot(r, caller) !== fingerprint ||
      !r.hoursAllowed
    )
      throw fail();
  }
  return {
    access(r) {
      current(r);
      return tokens.get(caller.id)!;
    },
    async check(r, d, source) {
      current(r);
      const interval = {
        ...d,
        startAt: new Date(Date.parse(d.startAt) - buffer * 60_000).toISOString(),
        endAt: new Date(Date.parse(d.endAt) + buffer * 60_000).toISOString(),
      };
      for (const c of connections) {
        if (c.userId === caller.id && !buffer) continue; // already checked by the operation
        await events.available(
          tokens.get(c.userId)!,
          interval,
          c.userId === caller.id
            ? undefined
            : { source, email: c.accountEmail!.trim().toLowerCase() },
        );
        current(r);
      }
    },
  };
}
