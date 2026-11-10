import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  googleInvitationSnapshot,
  googleCandidateInvitationSnapshot,
} from "./google-invitation-identity";
import type { GoogleInterviewInvitationStatus } from "@workspace/api-zod";
import { digest, googleStaffFailure, type GoogleStaffConfig } from "./google-staff-config";
import { googleStaffProvider, type GoogleStaffProvider } from "./google-staff-provider";
import { openGoogleCredential, sealGoogleCredential } from "./google-staff-service";
import { googleInterviewEvents, type GoogleEventDetails } from "./google-interview-event";
import type {
  GoogleInvitationStore,
  GoogleInvitationCaller,
  GoogleInvitationReview,
  GoogleInvitationActions,
} from "./google-invitation-store";
import { eligible } from "../routes/outlook-candidate-invitations";
import { scheduleVersion } from "./coordinator-schedule-version";
import { invitationRecipientHash } from "./outlook-candidate-invitation";
import { CalendarError } from "./outlook-calendar-core";
import { sameGoogleInvitationPanel } from "./google-invitation-panel";
export const googleInvitationInput = z.strictObject({
  confirm: z.literal(true),
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
  expectedApprovalToken: z.string().regex(/^gi_[a-f0-9]{64}$/),
  reviewExpiresAt: z.iso.datetime({ offset: true }),
});
export function googleInvitationService(deps: {
  config: () => GoogleStaffConfig | null;
  store: GoogleInvitationStore;
  provider?: (config: GoogleStaffConfig) => GoogleStaffProvider;
  events?: ReturnType<typeof googleInterviewEvents>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date()),
    events = deps.events ?? googleInterviewEvents();
  const fail = () => googleStaffFailure("google_invitation_changed", 409);
  async function revoke(error: unknown, caller: GoogleInvitationCaller, r: GoogleInvitationReview) {
    if (
      error instanceof CalendarError &&
      error.code === "google_reconnect_required" &&
      r.connection
    )
      await deps.store.reconnect(caller, r.connection.revision);
  }
  function reason(r: GoogleInvitationReview): GoogleInterviewInvitationStatus["reason"] {
    const cfg = deps.config(),
      c = r.connection;
    if (!cfg) return "setup_required";
    if (
      !c?.refreshTokenEnc ||
      !c.subject ||
      !c.accountEmail ||
      c.needsReconnect ||
      c.clientFingerprint !== cfg.fingerprint
    )
      return "connection_required";
    if (!c.invitationConsent) return "write_consent_required";
    try {
      eligible(r.context);
    } catch {
      return "ineligible";
    }
    // Only a current Google panel can extend this organizer's approved invitation.
    // Never borrow an Outlook panel or treat availability consent as write permission.
    if (r.context.schedule.panelRevision && r.panel?.revision !== r.context.schedule.panelRevision)
      return "panel_unsupported";
    if (
      r.panel?.recipients.some(
        (p) => p.userId !== c.userId && p.email === c.accountEmail!.trim().toLowerCase(),
      )
    )
      return "ineligible";
    if (
      !r.hoursAllowed ||
      r.context.candidate.email.trim().toLowerCase() === c.accountEmail.toLowerCase()
    )
      return "ineligible";
    return null;
  }
  function snapshot(r: GoogleInvitationReview, caller: GoogleInvitationCaller) {
    return googleInvitationSnapshot(r, caller);
  }
  function signed(r: GoogleInvitationReview, caller: GoogleInvitationCaller, expiry: string) {
    return `gi_${createHmac("sha256", deps.config()!.clientSecret)
      .update(`${snapshot(r, caller)}|${expiry}`)
      .digest("hex")}`;
  }
  function matches(r: GoogleInvitationReview, caller: GoogleInvitationCaller) {
    const a = r.attempt;
    const latest = a?.googleSnapshot?.operations?.at(-1);
    return !!(
      a?.provider === "google" &&
      a.googleSnapshot &&
      !a.panelSnapshot &&
      sameGoogleInvitationPanel(
        r.context.schedule.panelRevision,
        r.panel,
        a.googleSnapshot.panelSnapshot,
      ) &&
      a.organizerId === caller.id &&
      a.applicationId === r.context.application.id &&
      a.candidateId === r.context.candidate.id &&
      (!latest || (!!latest.acceptedAt && latest.kind === "reschedule")) &&
      ((latest?.targetSnapshotHash ?? a.googleSnapshot.snapshotHash) === snapshot(r, caller) ||
        (a.status === "accepted" &&
          a.googleSnapshot.candidateSnapshotHash ===
            googleCandidateInvitationSnapshot(r, caller))) &&
      a.googleSnapshot.subjectHash === digest(r.connection?.subject ?? "") &&
      a.recipientHash === invitationRecipientHash(r.context.candidate.email)
    );
  }
  function view(
    r: GoogleInvitationReview,
    caller: GoogleInvitationCaller,
    expiry?: string,
  ): GoogleInterviewInvitationStatus {
    const {
        context: { schedule, job, candidate },
        connection: c,
        attempt: a,
      } = r,
      why = reason(r);
    const other = !!a && a.provider !== "google";
    const accepted = !!a && a.status === "accepted" && matches(r, caller) && !why;
    const ready = !a && !why;
    const until = expiry ?? new Date(now().getTime() + 10 * 60_000).toISOString();
    return {
      provider: "google",
      scheduleId: schedule.id,
      version: scheduleVersion(schedule),
      scheduledAt: schedule.scheduledAt,
      durationMinutes: schedule.durationMinutes,
      jobTitle: job.title,
      recipientEmail: candidate.email,
      ...(r.panel
        ? {
            panelRecipientEmails: r.panel.recipients
              .filter((p) => p.userId !== caller.id)
              .map((p) => p.email),
          }
        : {}),
      organizerEmail: c?.accountEmail ?? null,
      connectionRevision: c?.revision ?? null,
      status: other
        ? "blocked_other_provider"
        : a
          ? accepted
            ? "accepted"
            : "needs_review"
          : ready
            ? "ready"
            : "unavailable",
      reason: other ? "another_provider" : a && !accepted ? (why ?? "changed") : why,
      approvalToken: ready ? signed(r, caller, until) : null,
      reviewExpiresAt: ready ? new Date(until) : null,
      acceptedAt: a?.provider === "google" ? a.acceptedAt : null,
      meetUrl: accepted ? (a?.googleSnapshot?.meetUrl ?? null) : null,
      conferenceStatus:
        a?.provider === "google"
          ? (a.googleSnapshot?.conferenceStatus ?? "pending")
          : "not_requested",
      deliveryConfirmed: false,
    };
  }
  function details(r: GoogleInvitationReview): GoogleEventDetails {
    const s = r.context.schedule,
      a = r.attempt!;
    return {
      transactionId: a.transactionId,
      binding: digest(`${s.tenantId}|${s.id}`),
      jobTitle: r.context.job.title,
      recipientEmail: r.context.candidate.email.trim().toLowerCase(),
      ...(r.panel
        ? {
            panelEmails: r.panel.recipients
              .filter((p) => p.userId !== r.connection!.userId)
              .map((p) => p.email),
          }
        : {}),
      organizerEmail: r.connection!.accountEmail!,
      startAt: s.scheduledAt.toISOString(),
      endAt: new Date(s.scheduledAt.getTime() + s.durationMinutes * 60_000).toISOString(),
    };
  }
  async function access(
    r: GoogleInvitationReview,
    caller: GoogleInvitationCaller,
    actions: GoogleInvitationActions,
  ) {
    if (reason(r)) throw fail();
    const c = r.connection!,
      actor = { id: caller.id, tenantId: caller.tenantId ?? "" };
    const provider = (deps.provider ?? googleStaffProvider)(deps.config()!);
    const token = await provider.refresh(
      openGoogleCredential(actor, "refresh", c.refreshTokenEnc!),
      true,
    );
    if (token.refreshToken)
      await actions.rotate(
        c.refreshTokenEnc!,
        sealGoogleCredential(actor, "refresh", token.refreshToken),
      );
    return { provider, token: token.accessToken };
  }
  function approve(
    r: GoogleInvitationReview,
    caller: GoogleInvitationCaller,
    input: z.infer<typeof googleInvitationInput>,
  ) {
    const expiry = Date.parse(input.reviewExpiresAt);
    if (
      reason(r) ||
      input.expectedVersion !== scheduleVersion(r.context.schedule) ||
      expiry <= now().getTime() ||
      expiry > now().getTime() + 10 * 60_000
    )
      throw fail();
    const expected = signed(r, caller, input.reviewExpiresAt);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.expectedApprovalToken)))
      throw fail();
  }
  return {
    async review(caller: GoogleInvitationCaller, id: string) {
      const original = await deps.store.read(caller, id);
      if (!original.attempt || reason(original) || !matches(original, caller))
        return view(original, caller);
      // Explicit status/recovery reads only. This method never creates or retries.
      try {
        return await deps.store.run(caller, original, async (r, actions) => {
          if (!matches(r, caller) || reason(r)) return view(r, caller);
          const { token } = await access(r, caller, actions);
          const receipt = await events.read(token, details(r));
          await actions.save(r.attempt!, receipt);
          return view(r, caller);
        });
      } catch (error) {
        await revoke(error, caller, original);
        // Reauthorize before returning private details after a failed/late operation.
        const result = view(await deps.store.read(caller, id), caller);
        return {
          ...result,
          status: "needs_review" as const,
          reason: "unknown" as const,
          meetUrl: null,
          approvalToken: null,
          reviewExpiresAt: null,
        };
      }
    },
    async send(caller: GoogleInvitationCaller, id: string, raw: unknown) {
      const parsed = googleInvitationInput.safeParse(raw);
      if (!parsed.success)
        throw new CalendarError(
          400,
          "invalid_input",
          "Review and explicitly approve this Google invitation.",
        );
      const input = parsed.data,
        original = await deps.store.read(caller, id);
      // Any durable claim, regardless of provider or provider response, stops new writes.
      if (original.attempt) throw fail();
      const intent = await deps.store
        .run(caller, original, async (r, actions) => {
          approve(r, caller, input);
          if (r.attempt) throw fail();
          const { provider, token } = await access(r, caller, actions);
          await events.canMeet(token);
          const start = r.context.schedule.scheduledAt.toISOString(),
            end = new Date(
              Date.parse(start) + r.context.schedule.durationMinutes * 60_000,
            ).toISOString();
          if (await provider.busy(token, start, end))
            throw googleStaffFailure("google_interval_busy", 409);
          // Provider preflight can take time. Approval and future eligibility are checked again.
          approve(r, caller, input);
          if (Date.parse(input.reviewExpiresAt) - now().getTime() < 60_000) throw fail();
          const saved = await actions.insert({
            scheduleId: r.context.schedule.id,
            applicationId: r.context.application.id,
            candidateId: r.context.candidate.id,
            organizerId: caller.id,
            recipientHash: invitationRecipientHash(r.context.candidate.email),
            scheduleVersion: scheduleVersion(r.context.schedule),
            transactionId: randomUUID(),
            status: "attempted",
            attemptedAt: now(),
            provider: "google",
            googleSnapshot: {
              connectionRevision: r.connection!.revision,
              subjectHash: digest(r.connection!.subject!),
              snapshotHash: snapshot(r, caller),
              meetUrl: null,
              conferenceStatus: "pending",
              ...(r.panel
                ? { panelSnapshot: { revision: r.panel.revision, binding: r.panel.binding } }
                : {}),
            },
          });
          return { ...r, attempt: saved };
        })
        .catch(async (error) => {
          await revoke(error, caller, original);
          throw error;
        });
      // A separate transaction commits the intent before the external mutation.
      try {
        return await deps.store.run(caller, intent, async (r, actions) => {
          if (
            !matches(r, caller) ||
            r.attempt?.transactionId !== intent.attempt.transactionId ||
            r.attempt.status !== "attempted"
          )
            throw fail();
          approve(r, caller, input);
          const { provider, token } = await access(r, caller, actions),
            d = details(r);
          if (await provider.busy(token, d.startAt, d.endAt)) throw fail();
          approve(r, caller, input);
          const receipt = await events.create(token, d);
          await actions.save(r.attempt, receipt);
          return view(r, caller);
        });
      } catch (error) {
        await revoke(error, caller, intent);
        // The write may have succeeded. Keep the committed claim, never delete/reset/retry.
        return {
          ...view(await deps.store.read(caller, id), caller),
          status: "needs_review" as const,
          reason: "unknown" as const,
          meetUrl: null,
          approvalToken: null,
          reviewExpiresAt: null,
        };
      }
    },
  };
}
