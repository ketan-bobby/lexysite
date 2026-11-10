import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { GoogleStaffCalendarStatus, GoogleStaffAvailabilityReceipt } from "@workspace/api-zod";
import { encryptSecret, decryptSecret } from "./crypto-secrets";
import { CalendarError } from "./outlook-calendar-core";
import {
  digest,
  opaque,
  googleStaffConsent,
  googleStaffFailure,
  type GoogleStaffConfig,
} from "./google-staff-config";
import type { GoogleStaffProvider } from "./google-staff-provider";
import type { GoogleStaffStore, GoogleStaffActor } from "./google-staff-store";

const valueSchema = z
  .object({
    purpose: z.literal("google-calendar"),
    userId: z.string(),
    tenantId: z.string(),
    kind: z.enum(["refresh", "verifier"]),
    value: z.string().min(1).max(16384),
  })
  .strict();
export function sealGoogleCredential(
  actor: GoogleStaffActor,
  kind: "refresh" | "verifier",
  value: string,
) {
  return encryptSecret(
    JSON.stringify({
      purpose: "google-calendar",
      userId: actor.id,
      tenantId: actor.tenantId,
      kind,
      value,
    }),
  );
}
export function openGoogleCredential(
  actor: GoogleStaffActor,
  kind: "refresh" | "verifier",
  blob: string,
) {
  try {
    const value = valueSchema.parse(JSON.parse(decryptSecret(blob)));
    if (value.userId !== actor.id || value.tenantId !== actor.tenantId || value.kind !== kind)
      throw new Error("context");
    return value.value;
  } catch {
    throw googleStaffFailure("google_reconnect_required", 409);
  }
}
const seal = sealGoogleCredential;
const open = openGoogleCredential;
export const googleStaffAvailabilityInput = z
  .object({
    revision: z.uuid(),
    startAt: z.iso.datetime({ offset: true }),
    durationMinutes: z.number().int().min(15).max(480),
  })
  .strict();
export function googleStaffService(deps: {
  store: GoogleStaffStore;
  config: GoogleStaffConfig | null;
  provider: () => GoogleStaffProvider;
  revalidate: (actor: GoogleStaffActor) => Promise<void>;
  now?: () => Date;
}) {
  const { store, config } = deps,
    now = deps.now ?? (() => new Date());
  const configured = () => {
    if (!config) throw googleStaffFailure("google_setup_required", 503);
    return config;
  };
  async function current(actor: GoogleStaffActor, revision: string) {
    await deps.revalidate(actor);
    const row = await store.get(actor);
    if (!row || row.revision !== revision)
      throw googleStaffFailure("google_connection_changed", 409);
    return row;
  }
  async function status(actor: GoogleStaffActor): Promise<GoogleStaffCalendarStatus> {
    const row = await store.get(actor);
    const connected = Boolean(
      row?.refreshTokenEnc &&
      !row.needsReconnect &&
      config &&
      row.clientFingerprint === config.fingerprint,
    );
    const pending = Boolean(row?.flowExpiresAt && row.flowExpiresAt > now());
    return {
      configured: Boolean(config),
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
      accountEmail: row?.accountEmail ?? null,
      connectedAt: row?.connectedAt ?? null,
      canCheckAvailability: connected,
      canSendInvitations: connected && row?.invitationConsent === true,
    };
  }
  return {
    status,
    async begin(actor: GoogleStaffActor, allowInvitations = false) {
      const cfg = configured();
      const state = opaque(),
        browser = opaque(),
        verifier = opaque(),
        nonce = opaque(),
        expires = new Date(now().getTime() + 10 * 60_000);
      await deps.revalidate(actor);
      await store.begin(actor, {
        revision: randomUUID(),
        clientFingerprint: cfg.fingerprint,
        flowHash: digest(state),
        browserHash: digest(browser),
        verifierEnc: seal(actor, "verifier", verifier),
        nonceHash: digest(nonce),
        flowExpiresAt: expires,
        flowInvitations: allowInvitations,
      });
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      return {
        browser,
        receipt: {
          authorizationUrl: googleStaffConsent(cfg, state, challenge, nonce, allowInvitations),
          expiresAt: expires.toISOString(),
        },
      };
    },
    async finish(
      actor: GoogleStaffActor,
      input: { state: string; browser: string; code: string; denied: boolean },
    ) {
      const cfg = configured();
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !/^[A-Za-z0-9_-]{43}$/.test(input.browser))
        throw googleStaffFailure("google_authorization_expired", 409);
      await deps.revalidate(actor);
      const row = await store.consume(actor, digest(input.state), digest(input.browser), now());
      if (!row || row.clientFingerprint !== cfg.fingerprint || !row.verifierEnc || !row.nonceHash)
        throw googleStaffFailure("google_authorization_expired", 409);
      if (input.denied || !input.code || input.code.length > 4096)
        throw googleStaffFailure("google_authorization_incomplete", 409);
      const grant = await deps
        .provider()
        .authorize(
          input.code,
          open(actor, "verifier", row.verifierEnc),
          row.nonceHash,
          row.flowInvitations,
        );
      await deps.revalidate(actor);
      if (
        !(await store.bind(actor, row.revision, {
          subject: grant.subject,
          accountEmail: grant.email,
          refreshTokenEnc: seal(actor, "refresh", grant.refreshToken),
          connectedAt: now(),
          invitationConsent: row.flowInvitations,
        }))
      )
        throw googleStaffFailure("google_connection_changed", 409);
    },
    async disconnect(actor: GoogleStaffActor, revision: string) {
      await deps.revalidate(actor);
      if (!(await store.clear(actor, revision)))
        throw googleStaffFailure("google_connection_changed", 409);
      return status(actor);
    },
    async availability(
      actor: GoogleStaffActor,
      raw: unknown,
    ): Promise<GoogleStaffAvailabilityReceipt> {
      configured();
      const parsed = googleStaffAvailabilityInput.safeParse(raw);
      if (!parsed.success) throw googleStaffFailure("google_interval_invalid", 400);
      const input = parsed.data,
        start = Date.parse(input.startAt),
        end = start + input.durationMinutes * 60_000;
      if (start < now().getTime() || start > now().getTime() + 90 * 86400_000)
        throw googleStaffFailure("google_interval_invalid", 400);
      const row = await current(actor, input.revision);
      if (
        !row.refreshTokenEnc ||
        row.needsReconnect ||
        row.clientFingerprint !== config!.fingerprint
      )
        throw googleStaffFailure("google_reconnect_required", 409);
      let result: "free" | "busy" | "outside_working_hours";
      try {
        if (!(await store.allows(actor, start, end))) result = "outside_working_hours";
        else {
          const provider = deps.provider();
          const token = await provider.refresh(open(actor, "refresh", row.refreshTokenEnc));
          if (
            token.refreshToken &&
            !(await store.rotate(
              actor,
              row.revision,
              row.refreshTokenEnc,
              seal(actor, "refresh", token.refreshToken),
            ))
          )
            throw googleStaffFailure("google_connection_changed", 409);
          await current(actor, input.revision);
          result = (await provider.busy(
            token.accessToken,
            new Date(start).toISOString(),
            new Date(end).toISOString(),
          ))
            ? "busy"
            : "free";
        }
      } catch (error) {
        if (error instanceof CalendarError && error.code === "google_reconnect_required")
          await store.clear(actor, row.revision, true);
        throw error;
      }
      await current(actor, input.revision);
      return {
        revision: row.revision,
        startAt: new Date(start),
        endAt: new Date(end),
        checkedAt: now(),
        status: result,
        reserved: false,
        invitationsEnabled: false,
      };
    },
  };
}
