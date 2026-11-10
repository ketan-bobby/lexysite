import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import type { GoogleInvitationOperation } from "@workspace/db";
import type { GoogleInvitationOperationView } from "@workspace/api-zod";
import { scheduleVersion } from "./coordinator-schedule-version";
import { eligible } from "../routes/outlook-candidate-invitations";
import { invitationRecipientHash } from "./outlook-candidate-invitation";
import { digest, googleStaffFailure, type GoogleStaffConfig } from "./google-staff-config";
import { googleInvitationSnapshot } from "./google-invitation-identity";
import { sameGoogleInvitationPanel } from "./google-invitation-panel";
import { googleInterviewEventId, type GoogleEventDetails } from "./google-interview-event";
import {
  googleInterviewEventChanges,
  type GoogleObservedEvent,
} from "./google-interview-event-changes";
import { openGoogleCredential, sealGoogleCredential } from "./google-staff-service";
import { googleStaffProvider } from "./google-staff-provider";
import type {
  GoogleInvitationActions,
  GoogleInvitationCaller,
  GoogleInvitationReview,
  GoogleInvitationStore,
} from "./google-invitation-store";

export const googleOperationInput = z.strictObject({
  confirm: z.literal(true),
  kind: z.enum(["reschedule", "cancel"]),
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
  expectedApprovalToken: z.string().regex(/^gc_[a-f0-9]{64}$/),
  reviewExpiresAt: z.iso.datetime(),
});
type Input = z.infer<typeof googleOperationInput>;
const operations = (r: GoogleInvitationReview) => r.attempt?.googleSnapshot?.operations ?? [];
const kind = (r: GoogleInvitationReview) =>
  r.context.schedule.status === "cancelled" ? ("cancel" as const) : ("reschedule" as const);
export function googleInvitationOperationService(deps: {
  store: GoogleInvitationStore;
  config: () => GoogleStaffConfig | null;
  events?: ReturnType<typeof googleInterviewEventChanges>;
  provider?: typeof googleStaffProvider;
  now?: () => Date;
}) {
  const events = deps.events ?? googleInterviewEventChanges(),
    now = deps.now ?? (() => new Date());
  const fail = () => googleStaffFailure("google_operation_changed", 409);
  function allowed(r: GoogleInvitationReview, caller: GoogleInvitationCaller) {
    const c = r.connection,
      a = r.attempt,
      g = a?.googleSnapshot,
      cfg = deps.config();
    if (
      !cfg ||
      !c?.refreshTokenEnc ||
      !c.invitationConsent ||
      c.needsReconnect ||
      !c.subject ||
      !c.accountEmail ||
      c.clientFingerprint !== cfg.fingerprint ||
      !a ||
      a.provider !== "google" ||
      a.status !== "accepted" ||
      a.eventId !== googleInterviewEventId(a.transactionId) ||
      !g ||
      a.panelSnapshot ||
      !sameGoogleInvitationPanel(r.context.schedule.panelRevision, r.panel, g.panelSnapshot) ||
      a.organizerId !== caller.id ||
      a.candidateId !== r.context.candidate.id ||
      a.applicationId !== r.context.application.id ||
      a.recipientHash !== invitationRecipientHash(r.context.candidate.email) ||
      g.subjectHash !== digest(c.subject) ||
      c.accountEmail.toLowerCase() === r.context.candidate.email.trim().toLowerCase()
    )
      throw fail();
    const row = r.context;
    eligible(
      kind(r) === "cancel" ? { ...row, schedule: { ...row.schedule, status: "confirmed" } } : row,
    );
    if (kind(r) === "reschedule" && !r.hoursAllowed) throw fail();
    if (!Array.isArray(operations(r)) || operations(r).length > 1000) throw fail();
  }
  function details(r: GoogleInvitationReview): GoogleEventDetails {
    const s = r.context.schedule,
      a = r.attempt!;
    return {
      transactionId: a.transactionId,
      binding: digest(`${s.tenantId}|${s.id}`),
      jobTitle: r.context.job.title,
      recipientEmail: r.context.candidate.email.trim().toLowerCase(),
      organizerEmail: r.connection!.accountEmail!,
      ...(r.panel
        ? {
            panelEmails: r.panel.recipients
              .map((member) => member.email)
              .filter((email) => email !== r.connection!.accountEmail!.trim().toLowerCase()),
          }
        : {}),
      startAt: s.scheduledAt.toISOString(),
      endAt: new Date(s.scheduledAt.getTime() + s.durationMinutes * 60000).toISOString(),
    };
  }
  function base(r: GoogleInvitationReview): GoogleInvitationOperationView {
    const d = r.context.schedule,
      k = kind(r);
    return {
      provider: "google",
      scheduleId: d.id,
      version: scheduleVersion(d),
      kind: k,
      status: "unavailable",
      recipientEmail: r.context.candidate.email,
      ...(r.panel
        ? {
            panelRecipientEmails: r.panel.recipients
              .map((member) => member.email)
              .filter((email) => email !== r.connection?.accountEmail?.trim().toLowerCase()),
          }
        : {}),
      organizerEmail: r.connection?.accountEmail ?? null,
      previousStart: null,
      previousEnd: null,
      targetStart: k === "cancel" ? null : d.scheduledAt,
      targetEnd:
        k === "cancel" ? null : new Date(d.scheduledAt.getTime() + d.durationMinutes * 60000),
      sourceEtag: null,
      approvalToken: null,
      reviewExpiresAt: null,
      operationId: null,
      acceptedAt: null,
      meetUrl: null,
      deliveryConfirmed: false,
    };
  }
  function signed(
    r: GoogleInvitationReview,
    caller: GoogleInvitationCaller,
    e: GoogleObservedEvent,
    expiry: string,
    priorId: string | null,
  ) {
    const data = [
      googleInvitationSnapshot(r, caller),
      caller.role,
      kind(r),
      r.attempt!.transactionId,
      priorId,
      e.id,
      e.etag,
      e.startAt,
      e.endAt,
      e.meetUrl,
      e.conferenceStatus,
      e.changeId,
      expiry,
    ];
    return (
      "gc_" +
      createHmac("sha256", deps.config()!.clientSecret).update(JSON.stringify(data)).digest("hex")
    );
  }
  function approve(
    r: GoogleInvitationReview,
    c: GoogleInvitationCaller,
    e: GoogleObservedEvent,
    i: Input,
    priorId: string | null,
  ) {
    allowed(r, c);
    const expiry = Date.parse(i.reviewExpiresAt);
    if (
      i.kind !== kind(r) ||
      i.expectedVersion !== scheduleVersion(r.context.schedule) ||
      expiry <= now().getTime() ||
      expiry > now().getTime() + 600000 ||
      Date.parse(e.startAt) <= now().getTime()
    )
      throw fail();
    const expected = signed(r, c, e, i.reviewExpiresAt, priorId);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(i.expectedApprovalToken))) throw fail();
  }
  async function access(
    r: GoogleInvitationReview,
    c: GoogleInvitationCaller,
    a: GoogleInvitationActions,
  ) {
    allowed(r, c);
    const connection = r.connection!,
      actor = { id: c.id, tenantId: c.tenantId ?? "" };
    const token = await (deps.provider ?? googleStaffProvider)(deps.config()!).refresh(
      openGoogleCredential(actor, "refresh", connection.refreshTokenEnc!),
      true,
    );
    if (token.refreshToken)
      await a.rotate(
        connection.refreshTokenEnc!,
        sealGoogleCredential(actor, "refresh", token.refreshToken),
      );
    return token.accessToken;
  }
  async function revoke(error: unknown, c: GoogleInvitationCaller, r: GoogleInvitationReview) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "google_reconnect_required" &&
      r.connection
    )
      await deps.store.reconnect(c, r.connection.revision);
  }
  function accepted(
    r: GoogleInvitationReview,
    op: GoogleInvitationOperation,
  ): GoogleInvitationOperationView {
    return {
      ...base(r),
      kind: op.kind,
      status: "accepted",
      operationId: op.id,
      acceptedAt: op.acceptedAt ? new Date(op.acceptedAt) : null,
      previousStart: new Date(op.previousStart),
      previousEnd: new Date(op.previousEnd),
      targetStart: op.targetStart ? new Date(op.targetStart) : null,
      targetEnd: op.targetEnd ? new Date(op.targetEnd) : null,
      meetUrl: op.kind === "cancel" ? null : r.attempt!.googleSnapshot!.meetUrl,
    };
  }
  async function uncertain(
    c: GoogleInvitationCaller,
    id: string,
  ): Promise<GoogleInvitationOperationView> {
    // Fresh authorization/erasure fence: never send a cached private snapshot.
    const current = await deps.store.read(c, id);
    return {
      ...base(current),
      status: "needs_review",
      operationId: operations(current).at(-1)?.id ?? null,
    };
  }
  return {
    async review(c: GoogleInvitationCaller, id: string): Promise<GoogleInvitationOperationView> {
      const original = await deps.store.read(c, id);
      try {
        allowed(original, c);
      } catch {
        return base(original);
      }
      try {
        return await deps.store.run(
          c,
          original,
          async (r, a) => {
            allowed(r, c);
            let last = operations(r).at(-1);
            if (last?.kind === "cancel" && last.acceptedAt) return accepted(r, last);
            const token = await access(r, c, a),
              remote = await events.observe(token, details(r));
            if (last && !last.acceptedAt) {
              if (
                last.kind !== "reschedule" ||
                remote.changeId !== last.id ||
                remote.startAt !== last.targetStart ||
                remote.endAt !== last.targetEnd ||
                (last.meetUrl && remote.meetUrl !== last.meetUrl) ||
                !a.finishOperation
              )
                return { ...base(r), status: "needs_review", operationId: last.id };
              await a.finishOperation(last.id, remote);
              last = operations(r).at(-1);
            }
            const view = {
              ...base(r),
              previousStart: new Date(remote.startAt),
              previousEnd: new Date(remote.endAt),
              sourceEtag: remote.etag,
              meetUrl: remote.meetUrl,
              operationId: last?.id ?? null,
            };
            const d = details(r);
            if (
              kind(r) === "reschedule" &&
              remote.startAt === d.startAt &&
              remote.endAt === d.endAt
            )
              return { ...view, status: "current" };
            if (Date.parse(remote.startAt) <= now().getTime())
              return { ...view, status: "unavailable" };
            const expiry = new Date(now().getTime() + 600000).toISOString();
            return {
              ...view,
              status: "ready",
              approvalToken: signed(r, c, remote, expiry, last?.id ?? null),
              reviewExpiresAt: new Date(expiry),
            };
          },
          true,
        );
      } catch (error) {
        await revoke(error, c, original);
        return uncertain(c, id);
      }
    },
    async apply(
      c: GoogleInvitationCaller,
      id: string,
      raw: unknown,
    ): Promise<GoogleInvitationOperationView> {
      const parsed = googleOperationInput.safeParse(raw);
      if (!parsed.success) throw googleStaffFailure("invalid_input", 400);
      const input = parsed.data,
        original = await deps.store.read(c, id);
      allowed(original, c);
      // Preparation may durably rotate credentials; never do that through an
      // independent connection while this operation holds panel/grant locks.
      const panel =
        original.panel && input.kind === "reschedule"
          ? await deps.store.preparePanelAvailability?.(c, original)
          : undefined;
      if (original.panel && input.kind === "reschedule" && !panel) throw fail();
      let intent: { review: GoogleInvitationReview; op: GoogleInvitationOperation };
      try {
        intent = await deps.store.run(
          c,
          original,
          async (r, a) => {
            allowed(r, c);
            const last = operations(r).at(-1);
            if ((last && !last.acceptedAt) || last?.kind === "cancel" || !a.appendOperation)
              throw fail();
            const token = panel ? panel.access(r) : await access(r, c, a),
              d = details(r),
              source = await events.observe(token, d);
            approve(r, c, source, input, last?.id ?? null);
            if (input.kind === "reschedule") {
              if (source.startAt === d.startAt && source.endAt === d.endAt) throw fail();
              await events.available(token, d);
              await panel?.check(r, d, source);
            }
            approve(r, c, source, input, last?.id ?? null);
            if (Date.parse(input.reviewExpiresAt) - now().getTime() < 60000) throw fail();
            const op: GoogleInvitationOperation = {
              id: randomUUID(),
              priorId: last?.id ?? null,
              kind: input.kind,
              nativeVersion: scheduleVersion(r.context.schedule),
              targetSnapshotHash: googleInvitationSnapshot(r, c),
              sourceEtag: source.etag,
              previousStart: source.startAt,
              previousEnd: source.endAt,
              targetStart: input.kind === "cancel" ? null : d.startAt,
              targetEnd: input.kind === "cancel" ? null : d.endAt,
              meetUrl: source.meetUrl,
              approvalHash: digest(input.expectedApprovalToken),
              attemptedAt: now().toISOString(),
              acceptedAt: null,
            };
            await a.appendOperation(op);
            return { review: r, op };
          },
          true,
        );
      } catch (error) {
        await revoke(error, c, original);
        throw error;
      }
      try {
        return await deps.store.run(
          c,
          intent.review,
          async (r, a) => {
            const last = operations(r).at(-1),
              op = intent.op;
            if (
              last?.id !== op.id ||
              last.acceptedAt ||
              !a.finishOperation ||
              digest(input.expectedApprovalToken) !== last.approvalHash
            )
              throw fail();
            allowed(r, c);
            const token = panel ? panel.access(r) : await access(r, c, a),
              d = details(r),
              source = await events.observe(token, d);
            approve(r, c, source, input, op.priorId);
            if (
              source.etag !== op.sourceEtag ||
              googleInvitationSnapshot(r, c) !== op.targetSnapshotHash
            )
              throw fail();
            if (op.kind === "reschedule") {
              await events.available(token, d);
              await panel?.check(r, d, source);
              approve(r, c, source, input, op.priorId);
              const receipt = await events.reschedule(token, d, source, op.id);
              await a.finishOperation(op.id, receipt);
            } else {
              approve(r, c, source, input, op.priorId);
              await events.cancel(token, d, source);
              await a.finishOperation(op.id);
            }
            return accepted(r, operations(r).at(-1)!);
          },
          true,
        );
      } catch (error) {
        await revoke(error, c, intent.review);
        return uncertain(c, id);
      }
    },
  };
}
