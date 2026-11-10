import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  interviewSessionsTable as sessions,
  interviewPlansTable as plans,
  interviewSummariesTable as summaries,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
} from "@workspace/db";
import type { AtsInterviewNoteInput, AtsInterviewNoteState } from "@workspace/api-zod";
import { applicantInterviewContext, applicantInterviewRevision } from "./ats-applicant-interviews";
import { lock } from "./ats-imports";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import {
  greenhouseGateway,
  boundedAtsRead,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";
import {
  greenhouseNoteInput,
  savedGreenhouseNoteId,
} from "./ats-connectors/greenhouse-note-policy";
import { previewJob, previewApplications } from "./ats-connectors/preview";
import { candidateProfile } from "./ats-connectors/profile";

type Handle = Parameters<typeof applicantInterviewContext>[0];
type Visible = Parameters<typeof applicantInterviewContext>[4];
type Mode = AtsInterviewNoteInput["mode"];

/** No transcript, private coaching, comments, recordings or access capabilities. */
export function assessmentNoteText(summary: typeof summaries.$inferSelect): string[] {
  const safe = (text: string) => text.replace(/https?:\/\/[^\s<>]+/gi, "[link omitted]");
  const score = summary.overallScore;
  if (!Number.isFinite(score) || score < 0 || score > 100 || !summary.recruiterSummary.trim())
    throw new WorkflowConflict("A valid completed interview assessment is required.");
  return [
    "",
    "Job-interview assessment — explicitly approved for disclosure by the publishing administrator",
    "AI-generated assessment; not an independent identity check or a final hiring decision.",
    `Interview score: ${score}`,
    `Summary: ${safe(summary.recruiterSummary)}`,
    `Recommendation: ${safe(summary.recommendation)}`,
    `Strengths: ${summary.strengths.map(safe).join("; ") || "not recorded"}`,
    `Development areas: ${summary.weaknesses.map(safe).join("; ") || "not recorded"}`,
    `Concerns: ${summary.redFlags.map(safe).join("; ") || "not recorded"}`,
  ];
}

export function greenhouseInterviewNotes(gateway: GreenhouseGateway = greenhouseGateway()) {
  async function document(
    h: Handle,
    s: WorkflowScope,
    w: string,
    r: string,
    mode: Mode,
    visible: Visible,
  ) {
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
    const [plan] = await h
      .select()
      .from(plans)
      .where(
        and(eq(plans.id, session.planId), eq(plans.tenantId, s.tenantId), eq(plans.jobId, s.jobId)),
      )
      .for("share");
    if (!plan) throw new WorkflowConflict("Interview plan unavailable.");
    // Summary has no tenant column; scope it through the exact authorized session.
    const [evidence] = await h
      .select({ summary: summaries })
      .from(summaries)
      .innerJoin(sessions, eq(sessions.id, summaries.interviewSessionId))
      .where(
        and(
          eq(sessions.id, session.id),
          eq(sessions.tenantId, s.tenantId),
          eq(sessions.candidateId, c.person.id),
        ),
      )
      .for("share");
    const lines = [
      "Lexy interview progress",
      `Greenhouse job: ${c.r.externalJobId}`,
      `Greenhouse application: ${c.r.externalApplicationId}`,
      `Greenhouse candidate: ${c.snapshot.application.candidateId}`,
      session.inviteSentAt
        ? "Invitation send acceptance recorded (inbox delivery unverified)"
        : "Invitation acceptance unconfirmed",
      `Interview state: ${session.status}`,
      ...(session.startedAt ? [`Started: ${session.startedAt.toISOString()}`] : []),
      ...(session.completedAt ? [`Completed: ${session.completedAt.toISOString()}`] : []),
    ];
    if (mode === "assessment") {
      if (
        !["completed", "reviewed"].includes(session.status) ||
        !session.completedAt ||
        !evidence?.summary ||
        !Array.isArray(session.answers) ||
        !session.answers.length ||
        !Array.isArray(plan.questions) ||
        !plan.questions.length
      )
        throw new WorkflowConflict(
          "Complete the job interview and its assessment before approving disclosure.",
        );
      lines.push(...assessmentNoteText(evidence.summary));
    }
    lines.push(
      "",
      "This note does not change an ATS hiring stage, reject a candidate, issue an offer or confirm employment.",
    );
    const title = `Lexy interview ${mode} — job ${c.r.externalJobId}`;
    const content = lines.join("\n");
    if (content.length > 12000)
      throw new WorkflowConflict("This note is too long to publish without omission.", 422);
    const body = greenhouseNoteInput.parse({
      candidate_id: Number(c.snapshot.application.candidateId),
      application_id: Number(c.r.externalApplicationId),
      note_type: "NOTE",
      visibility: "admin_only",
      subject: title,
      body: content,
    });
    const reviewHash = fingerprint({
      authority: applicantInterviewRevision(c),
      mode,
      body,
      plan,
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        inviteSentAt: session.inviteSentAt,
        answers: session.answers,
        score: session.score,
      },
      ...(mode === "assessment" ? { summary: evidence?.summary } : {}),
    });
    const prefix = `gh-interview-note:${session.id}:`;
    const key = prefix + fingerprint({ account: c.r.accountRef, body });
    const previous = await h
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
      );
    const matching = previous.find((x) => x.receipt.key === key);
    const unresolved = previous.some((x) => !savedGreenhouseNoteId(x.event?.action, x.event?.note));
    const status = unresolved ? "review_required" : matching ? "published" : "not_published";
    const writable =
      !!gateway.publishNote && gateway.canPublishNotes?.(c.a.binding.connectionId) === true;
    const reason = unresolved
      ? "An earlier note attempt is unresolved. Inspect Greenhouse; no automatic retry or changed-content bypass is allowed."
      : !writable
        ? "Publication requires the allocated direct Greenhouse connection with note-creation permission. Read-only managed connections remain unchanged."
        : matching
          ? "This exact note already has a publication receipt."
          : null;
    const noteId = savedGreenhouseNoteId(matching?.event?.action, matching?.event?.note);
    // Re-evaluate privacy after acquiring the session/assessment source locks.
    const latest = await applicantInterviewContext(h, s, w, r, visible);
    if (applicantInterviewRevision(latest) !== applicantInterviewRevision(c))
      throw new WorkflowConflict("Applicant authority changed. Preview again.");
    const state: AtsInterviewNoteState = {
      mode,
      title,
      content,
      reviewHash,
      status,
      canPublish: status === "not_published" && writable,
      reason,
      noteId,
    };
    return { c, state, key, prefix, body, matching, unresolved, sessionId: session.id };
  }
  async function current(s: WorkflowScope, w: string, r: string, mode: Mode, visible: Visible) {
    return dbAdmin.transaction(async (tx) => {
      await lock(tx, s, w);
      return document(tx, s, w, r, mode, visible);
    });
  }
  return {
    async read(s: WorkflowScope, w: string, r: string, mode: Mode, visible: Visible) {
      return (await current(s, w, r, mode, visible)).state;
    },
    async publish(
      s: WorkflowScope,
      w: string,
      r: string,
      input: AtsInterviewNoteInput,
      visible: Visible,
    ) {
      if (input.acknowledge !== true)
        throw new WorkflowConflict("Explicit approval of this exact note is required.", 400);
      const before = await current(s, w, r, input.mode, visible);
      if (before.matching || before.unresolved) return before.state;
      if (input.reviewHash !== before.state.reviewHash || !before.state.canPublish)
        throw new WorkflowConflict("Publication unavailable or the review changed. Preview again.");
      try {
        const remote = async (path: string) => {
          const fresh = await current(s, w, r, input.mode, visible);
          if (fresh.state.reviewHash !== input.reviewHash || !fresh.state.canPublish)
            throw new WorkflowConflict("Publication authority changed. Preview again.");
          return boundedAtsRead(gateway.read(before.c.a.binding.connectionId, path));
        };
        const job = previewJob(
          await remote(`/v3/jobs?ids=${before.c.r.externalJobId}`),
          before.c.r.externalJobId,
        );
        const applications = previewApplications(
          await remote(`/v3/applications?ids=${before.c.r.externalApplicationId}`),
          job.id,
        );
        const person = candidateProfile(
          await remote(`/v3/candidates?ids=${before.c.snapshot.application.candidateId}`),
          before.c.snapshot.application.candidateId,
          false,
        );
        if (
          fingerprint(job) !== fingerprint(before.c.snapshot.job) ||
          applications.length !== 1 ||
          fingerprint(applications[0]) !== fingerprint(before.c.snapshot.application) ||
          !person.emails.includes(before.c.person.email.trim().toLowerCase())
        )
          throw new WorkflowConflict(
            "Greenhouse applicant changed. Refresh and review before publication.",
          );
      } catch (error) {
        if (error instanceof WorkflowConflict) throw error;
        throw new WorkflowConflict(
          "Fresh Greenhouse verification failed. No note was published.",
          503,
        );
      }
      const claim = await dbAdmin.transaction(async (tx) => {
        await lock(tx, s, w);
        const fresh = await document(tx, s, w, r, input.mode, visible);
        if (fresh.matching || fresh.unresolved) return null;
        if (fresh.state.reviewHash !== input.reviewHash || !fresh.state.canPublish)
          throw new WorkflowConflict("Publication review changed. Nothing was published.");
        const id = randomUUID();
        await tx.insert(events).values({
          id,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: "ats.interview.note.claimed",
          note: JSON.stringify({
            sessionId: fresh.sessionId,
            recordId: r,
            mode: input.mode,
            reviewHash: input.reviewHash,
          }),
        });
        await tx.insert(receipts).values({
          tenantId: s.tenantId,
          jobId: s.jobId,
          key: fresh.key,
          requestHash: input.reviewHash,
          resultId: id,
        });
        return id;
      });
      if (!claim) return (await current(s, w, r, input.mode, visible)).state;
      // The committed claim survives provider errors, crashes and failed local
      // finalization. Never infer that an absent response means no remote effect.
      await dbAdmin.transaction(async (tx) => {
        await lock(tx, s, w);
        const fresh = await document(tx, s, w, r, input.mode, visible);
        if (
          fresh.state.reviewHash !== input.reviewHash ||
          fresh.matching?.receipt.resultId !== claim ||
          gateway.canPublishNotes?.(fresh.c.a.binding.connectionId) !== true
        )
          throw new WorkflowConflict("Claim held: publication source or authority changed.");
        let noteId: string | null = null;
        try {
          const id = await gateway.publishNote!(fresh.c.a.binding.connectionId, fresh.body);
          if (typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))
            noteId = id;
        } catch {
          /* The provider may have accepted this note. Keep it held. */
        }
        const resultId = randomUUID();
        await tx.insert(events).values({
          id: resultId,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: `ats.interview.note.${noteId ? "published" : "review_required"}`,
          note: JSON.stringify({
            attemptId: claim,
            sessionId: fresh.sessionId,
            recordId: r,
            mode: input.mode,
            reviewHash: input.reviewHash,
            ...(noteId ? { noteId } : {}),
          }),
        });
        await tx
          .update(receipts)
          .set({ resultId })
          .where(
            and(
              eq(receipts.tenantId, s.tenantId),
              eq(receipts.jobId, s.jobId),
              eq(receipts.key, fresh.key),
              eq(receipts.resultId, claim),
            ),
          );
      });
      return (await current(s, w, r, input.mode, visible)).state;
    },
  };
}
