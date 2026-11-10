import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { GoogleMeetRecordingAccountStatus } from "@workspace/api-zod";
import { encryptSecret, decryptSecret } from "./crypto-secrets";
import { CalendarError } from "./outlook-calendar-core";
import { digest, opaque, type GoogleStaffConfig } from "./google-staff-config";
import type { GoogleStaffActor as Actor } from "./google-staff-store";
import type { MeetRecordingStore } from "./google-meet-recording-store";
import {
  googleMeetRecordingConsent,
  meetAccountFailure,
  type MeetRecordingOAuthProvider,
} from "./google-meet-recording-oauth";

const credential = z
  .object({
    purpose: z.literal("google-meet-recordings"),
    userId: z.string(),
    tenantId: z.string(),
    kind: z.enum(["refresh", "verifier"]),
    value: z.string().min(1).max(16384),
  })
  .strict();
export function sealMeetCredential(actor: Actor, kind: "refresh" | "verifier", value: string) {
  return encryptSecret(
    JSON.stringify({
      purpose: "google-meet-recordings",
      userId: actor.id,
      tenantId: actor.tenantId,
      kind,
      value,
    }),
  );
}
export function openMeetCredential(actor: Actor, kind: "refresh" | "verifier", blob: string) {
  try {
    const row = credential.parse(JSON.parse(decryptSecret(blob)));
    if (row.userId !== actor.id || row.tenantId !== actor.tenantId || row.kind !== kind)
      throw new Error("context");
    return row.value;
  } catch {
    throw meetAccountFailure("meet_recording_reconnect_required", 409);
  }
}
export function googleMeetRecordingAccount(deps: {
  store: MeetRecordingStore;
  config: GoogleStaffConfig | null;
  provider: () => MeetRecordingOAuthProvider;
  revalidate: (actor: Actor) => Promise<void>;
  now?: () => Date;
}) {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const configured = () => {
    if (!config) throw meetAccountFailure("meet_recording_setup_required");
    return config;
  };
  async function current(actor: Actor, revision: string) {
    await deps.revalidate(actor);
    const row = await store.get(actor);
    if (!row || row.revision !== revision)
      throw meetAccountFailure("meet_recording_account_changed", 409);
    return row;
  }
  async function status(actor: Actor): Promise<GoogleMeetRecordingAccountStatus> {
    await deps.revalidate(actor);
    const row = await store.get(actor);
    const connected = Boolean(
      config &&
      row?.refreshTokenEnc &&
      row.subject &&
      !row.needsReconnect &&
      row.clientFingerprint === config.fingerprint,
    );
    const pending = Boolean(
      config &&
      row?.flowHash &&
      row.flowExpiresAt &&
      row.flowExpiresAt > now() &&
      row.clientFingerprint === config.fingerprint,
    );
    return {
      configured: !!config,
      state: connected
        ? "connected"
        : pending
          ? "authorization_pending"
          : row?.needsReconnect || row?.refreshTokenEnc
            ? "reconnect_required"
            : config
              ? "disconnected"
              : "setup_required",
      revision: row?.revision ?? null,
      accountEmail: connected ? (row?.accountEmail ?? null) : null,
      connectedAt: connected ? (row?.connectedAt ?? null) : null,
      canReadRecordings: connected,
      redirectUri: config?.redirectUri ?? null,
    };
  }
  return {
    status,
    async begin(actor: Actor) {
      const cfg = configured();
      await deps.revalidate(actor);
      const state = opaque(),
        browser = opaque(),
        verifier = opaque(),
        nonce = opaque();
      const expires = new Date(now().getTime() + 10 * 60_000);
      await store.begin(actor, {
        revision: randomUUID(),
        clientFingerprint: cfg.fingerprint,
        flowHash: digest(state),
        browserHash: digest(browser),
        verifierEnc: sealMeetCredential(actor, "verifier", verifier),
        nonceHash: digest(nonce),
        flowExpiresAt: expires,
      });
      return {
        browser,
        receipt: {
          authorizationUrl: googleMeetRecordingConsent(
            cfg,
            state,
            createHash("sha256").update(verifier).digest("base64url"),
            nonce,
          ),
          expiresAt: expires.toISOString(),
        },
      };
    },
    async finish(
      actor: Actor,
      input: { state: string; browser: string; code: string; denied: boolean },
    ) {
      const cfg = configured();
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !/^[A-Za-z0-9_-]{43}$/.test(input.browser))
        throw meetAccountFailure("meet_recording_authorization_expired", 409);
      await deps.revalidate(actor);
      const row = await store.consume(actor, digest(input.state), digest(input.browser), now());
      if (!row || row.clientFingerprint !== cfg.fingerprint || !row.verifierEnc || !row.nonceHash)
        throw meetAccountFailure("meet_recording_authorization_expired", 409);
      if (input.denied || !input.code || input.code.length > 4096)
        throw meetAccountFailure("meet_recording_authorization_incomplete", 409);
      const grant = await deps
        .provider()
        .authorize(
          input.code,
          openMeetCredential(actor, "verifier", row.verifierEnc),
          row.nonceHash,
        );
      await deps.revalidate(actor);
      if (
        !(await store.bind(actor, row.revision, {
          subject: grant.subject,
          accountEmail: grant.email,
          refreshTokenEnc: sealMeetCredential(actor, "refresh", grant.refreshToken),
          connectedAt: now(),
        }))
      )
        throw meetAccountFailure("meet_recording_account_changed", 409);
    },
    async disconnect(actor: Actor, revision: string) {
      await deps.revalidate(actor);
      if (!(await store.clear(actor, revision)))
        throw meetAccountFailure("meet_recording_account_changed", 409);
      return status(actor);
    },
    async access(actor: Actor, revision: string) {
      configured();
      const row = await current(actor, revision);
      if (
        !row.refreshTokenEnc ||
        !row.subject ||
        row.needsReconnect ||
        row.clientFingerprint !== config!.fingerprint
      )
        throw meetAccountFailure("meet_recording_reconnect_required", 409);
      try {
        const token = await deps
          .provider()
          .refresh(openMeetCredential(actor, "refresh", row.refreshTokenEnc));
        if (
          token.refreshToken &&
          !(await store.rotate(
            actor,
            revision,
            row.refreshTokenEnc,
            sealMeetCredential(actor, "refresh", token.refreshToken),
          ))
        )
          throw meetAccountFailure("meet_recording_account_changed", 409);
        await current(actor, revision);
        return {
          accessToken: token.accessToken,
          subject: row.subject,
          accountEmail: row.accountEmail,
        };
      } catch (error) {
        if (error instanceof CalendarError && error.code === "meet_recording_reconnect_required")
          await store.clear(actor, revision, true);
        throw error;
      }
    },
  };
}
