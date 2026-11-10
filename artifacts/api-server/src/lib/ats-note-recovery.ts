import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
  interviewSessionsTable as sessions,
} from "@workspace/db";
import type { AtsNoteRecoveryAttempt, AtsNoteRecoveryInput } from "@workspace/api-zod";
import { applicantInterviewContext, applicantInterviewRevision } from "./ats-applicant-interviews";
import { lock } from "./ats-imports";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import {
  greenhouseGateway,
  boundedAtsRead,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";
import {
  recoveredGreenhouseNote,
  savedGreenhouseNoteId,
} from "./ats-connectors/greenhouse-note-policy";

type Handle = Parameters<typeof applicantInterviewContext>[0];
type Visible = Parameters<typeof applicantInterviewContext>[4];
function metadata(note: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(note ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Proves an approved note currently exists; never resends or infers email delivery. */
export function greenhouseNoteRecovery(gateway: GreenhouseGateway = greenhouseGateway()) {
  async function context(h: Handle, s: WorkflowScope, w: string, r: string, visible: Visible) {
    const c = await applicantInterviewContext(h, s, w, r, visible);
    if (!c.existing || c.existing.applicationId !== `greenhouse-import:${r}`)
      throw new WorkflowConflict("Prepare this imported applicant's interview first.");
    const [session] = await h
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, c.existing.id),
          eq(sessions.tenantId, s.tenantId),
          eq(sessions.candidateId, c.person.id),
        ),
      )
      .for("share");
    if (!session) throw new WorkflowConflict("Interview unavailable.", 404);
    const prefix = `gh-interview-note:${session.id}:`;
    const rows = await h
      .select({ receipt: receipts, event: events })
      .from(receipts)
      .leftJoin(
        events,
        and(
          eq(events.id, receipts.resultId),
          eq(events.tenantId, s.tenantId),
          eq(events.jobId, s.jobId),
        ),
      )
      .where(
        and(
          eq(receipts.tenantId, s.tenantId),
          eq(receipts.jobId, s.jobId),
          sql`left(${receipts.key},${prefix.length})=${prefix}`,
        ),
      )
      .orderBy(asc(receipts.createdAt), asc(receipts.id))
      .limit(101);
    if (rows.length > 100)
      throw new WorkflowConflict(
        "Too many note attempts for this recovery view. Administrative investigation is required.",
        422,
      );
    const attempts = [];
    for (const row of rows) {
      const outcome = metadata(row.event?.note);
      const claimId =
        row.event?.action === "ats.interview.note.claimed" ? row.event.id : outcome.attemptId;
      const [claim] =
        typeof claimId === "string" && claimId.length <= 128
          ? await h
              .select()
              .from(events)
              .where(
                and(
                  eq(events.id, claimId),
                  eq(events.tenantId, s.tenantId),
                  eq(events.jobId, s.jobId),
                  eq(events.workflowId, w),
                  eq(events.action, "ats.interview.note.claimed"),
                ),
              )
          : [];
      const original = metadata(claim?.note);
      const valid =
        !!claim &&
        row.event?.workflowId === w &&
        original.sessionId === session.id &&
        original.recordId === r &&
        original.reviewHash === row.receipt.requestHash &&
        ["progress", "assessment"].includes(String(original.mode)) &&
        (row.event?.action === "ats.interview.note.claimed" ||
          (outcome.sessionId === session.id &&
            outcome.recordId === r &&
            outcome.reviewHash === row.receipt.requestHash));
      const noteId = valid ? savedGreenhouseNoteId(row.event?.action, row.event?.note) : null;
      const status = noteId
        ? row.event?.action === "ats.interview.note.reconciled"
          ? "verified_existing"
          : "published"
        : "held";
      const supported =
        !!gateway.readNote && gateway.canReadNotes?.(c.a.binding.connectionId) === true;
      const state: AtsNoteRecoveryAttempt = {
        receiptId: row.receipt.id,
        reviewHash: fingerprint({
          authority: applicantInterviewRevision(c),
          receipt: row.receipt,
          claimId: claim?.id ?? null,
          resultId: row.event?.id ?? null,
        }),
        mode: valid ? (original.mode as "progress" | "assessment") : "unknown",
        claimedAt: (claim?.createdAt ?? row.receipt.createdAt).toISOString(),
        status,
        noteId,
        canVerify: valid && !noteId && supported,
        reason: !valid
          ? "The original approval audit is incomplete. The hold cannot be released here."
          : noteId
            ? "A matching note has a saved receipt. No resend is available."
            : !supported
              ? "The allocated direct connection must support note reads. No credentials are changed here."
              : "Enter the existing Greenhouse note ID. Exact matching evidence is required; absence never releases a hold.",
      };
      attempts.push({ ...row, claim, state });
    }
    return { c, prefix, sessionId: session.id, attempts };
  }
  async function current(s: WorkflowScope, w: string, r: string, visible: Visible) {
    return dbAdmin.transaction(async (tx) => {
      await lock(tx, s, w);
      return context(tx, s, w, r, visible);
    });
  }
  return {
    async read(s: WorkflowScope, w: string, r: string, visible: Visible) {
      return (await current(s, w, r, visible)).attempts.map((x) => x.state);
    },
    async reconcile(
      s: WorkflowScope,
      w: string,
      r: string,
      input: AtsNoteRecoveryInput,
      visible: Visible,
    ) {
      if (input.acknowledge !== true)
        throw new WorkflowConflict("Explicit verification acknowledgement is required.", 400);
      if (!/^[1-9]\d*$/.test(input.noteId) || !Number.isSafeInteger(Number(input.noteId)))
        throw new WorkflowConflict("Invalid Greenhouse note ID.", 400);
      const before = await current(s, w, r, visible);
      const target = before.attempts.find((x) => x.state.receiptId === input.receiptId);
      if (!target) throw new WorkflowConflict("Note attempt unavailable.", 404);
      if (target.state.noteId) {
        if (target.state.noteId !== input.noteId)
          throw new WorkflowConflict("This attempt already has a different note receipt.");
        return before.attempts.map((x) => x.state);
      }
      if (!target.state.canVerify || input.reviewHash !== target.state.reviewHash)
        throw new WorkflowConflict("Recovery authority or attempt changed. Review again.");
      let raw: unknown;
      try {
        raw = await boundedAtsRead(
          gateway.readNote!(before.c.a.binding.connectionId, input.noteId),
        );
      } catch {
        throw new WorkflowConflict(
          "Greenhouse note verification is unavailable. The original hold is unchanged.",
          503,
        );
      }
      try {
        const body = recoveredGreenhouseNote(raw, input.noteId);
        if (
          String(body.candidate_id) !== before.c.snapshot.application.candidateId ||
          String(body.application_id) !== before.c.r.externalApplicationId ||
          target.receipt.key !==
            before.prefix + fingerprint({ account: before.c.r.accountRef, body })
        )
          throw new Error("Unmatched original content.");
      } catch {
        throw new WorkflowConflict(
          "The returned note does not exactly match this approved attempt. The hold is unchanged.",
        );
      }
      return dbAdmin.transaction(async (tx) => {
        await lock(tx, s, w);
        const fresh = await context(tx, s, w, r, visible);
        const row = fresh.attempts.find((x) => x.state.receiptId === input.receiptId);
        if (row?.state.noteId === input.noteId) return fresh.attempts.map((x) => x.state);
        if (!row?.claim || !row.state.canVerify || row.state.reviewHash !== input.reviewHash)
          throw new WorkflowConflict("Recovery authority or attempt changed during verification.");
        const id = randomUUID();
        await tx.insert(events).values({
          id,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: "ats.interview.note.reconciled",
          note: JSON.stringify({
            attemptId: row.claim.id,
            sessionId: fresh.sessionId,
            recordId: r,
            mode: row.state.mode,
            reviewHash: row.receipt.requestHash,
            noteId: input.noteId,
            evidence: "exact_approved_note_observed",
            verifiedAt: new Date().toISOString(),
          }),
        });
        await tx
          .update(receipts)
          .set({ resultId: id })
          .where(
            and(
              eq(receipts.id, row.receipt.id),
              eq(receipts.tenantId, s.tenantId),
              eq(receipts.jobId, s.jobId),
              eq(receipts.resultId, row.receipt.resultId),
            ),
          );
        return (await context(tx, s, w, r, visible)).attempts.map((x) => x.state);
      });
    },
  };
}
