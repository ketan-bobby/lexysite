import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { dbAdmin, meetingNotesTable, jobsTable, applicationsTable } from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "./tenantUtils";
import { ObjectStorageService } from "./objectStorage";
import { isCandidateErased } from "./candidate-erasure-barrier";
import {
  meetingCanRetry,
  meetingSummaryPrompt,
  meetingTranscriptHash,
  meetingQuestionReviewInput,
  meetingQuestionEvidence,
  MeetingQuestionEvidenceError,
  MEETING_PROCESSING_MS,
  MAX_MEETING_BYTES,
} from "./meeting-notes-core";
import { boundedRecordingBody } from "./zoom-recordings-provider";
import { withMeetingAudio } from "./meeting-notes-media";
import { transcribeMeetingParts } from "./meeting-notes-transcription";
import { transcribeAudio, deepgramConfigured, deepgramLanguageFor } from "./transcribe";
import {
  transcribeMeetingSpeakers,
  meetingSpeakerReviewInput,
  meetingSpeakerLabels,
  MeetingSpeakerReviewError,
} from "./meeting-speakers";
import { generateWithAI } from "./ai";
import { logger } from "./logger";

type Note = typeof meetingNotesTable.$inferSelect;
export type MeetingScope = {
  actorId: string;
  jobId: string;
  candidateId: string;
  tenantId: string;
};
const storage = new ObjectStorageService();

export class MeetingNotesError extends Error {
  get statusCode() {
    return this.status;
  }
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function meetingScope(
  actorId: string,
  jobId: string,
  candidateId: string,
): Promise<MeetingScope> {
  let caller;
  try {
    caller = await calendarStaff(actorId);
  } catch {
    throw new MeetingNotesError(401, "Please sign in with an active staff account.");
  }
  if (
    !["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"].includes(
      caller.role,
    )
  ) {
    throw new MeetingNotesError(403, "Staff job access is required.");
  }
  const allowed = await getDataScopeTenantIds(caller, dbAdmin);
  const [job] = await dbAdmin
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, jobId),
        allowed === null ? undefined : inArray(jobsTable.tenantId, allowed),
      ),
    )
    .limit(1);
  if (
    !job ||
    (caller.role === "hiring_manager" && job.assignedHiringManagerId !== caller.id) ||
    (caller.role === "recruiter" &&
      !(await getRecruiterAssignedJobIds(caller, dbAdmin)).includes(jobId))
  ) {
    throw new MeetingNotesError(404, "Interview context not found.");
  }
  const [application] = await dbAdmin
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(and(eq(applicationsTable.jobId, jobId), eq(applicationsTable.candidateId, candidateId)))
    .limit(1);
  if (!application || (await isCandidateErased(candidateId)))
    throw new MeetingNotesError(404, "Interview context not found.");
  return { actorId, jobId, candidateId, tenantId: job.tenantId };
}

const noteWhere = (scope: MeetingScope, id?: string) =>
  and(
    eq(meetingNotesTable.tenantId, scope.tenantId),
    eq(meetingNotesTable.jobId, scope.jobId),
    eq(meetingNotesTable.candidateId, scope.candidateId),
    id ? eq(meetingNotesTable.id, id) : undefined,
  );

export function meetingNoteDTO(note: Note) {
  const {
    objectPath: _objectPath,
    processingToken: _token,
    createdBy: _actor,
    tenantId: _tenant,
    sourceKey: _sourceKey,
    ...safe
  } = note;
  return {
    ...safe,
    transcriptHash: meetingTranscriptHash(note.transcript),
    questionReview:
      note.questionReview?.sourceHash === meetingTranscriptHash(note.transcript)
        ? note.questionReview
        : null,
    canRetry:
      !note.error?.startsWith("Deletion pending.") &&
      meetingCanRetry(note.status, note.processingStartedAt),
  };
}

export async function meetingNotes(scope: MeetingScope) {
  return (
    await dbAdmin
      .select()
      .from(meetingNotesTable)
      .where(noteWhere(scope))
      .orderBy(desc(meetingNotesTable.createdAt))
      .limit(100)
  ).map(meetingNoteDTO);
}

export async function meetingNote(scope: MeetingScope, id: string): Promise<Note> {
  const [row] = await dbAdmin.select().from(meetingNotesTable).where(noteWhere(scope, id)).limit(1);
  if (!row) throw new MeetingNotesError(404, "Recording not found.");
  return row;
}

export async function saveMeetingNote(
  scope: MeetingScope,
  file: { originalname: string } & ({ buffer: Buffer } | { path: string; size: number }),
  input: {
    title: string;
    language: string;
    consentStatement: string;
    plannedQuestions: string;
  },
  mimeType: string,
  native?: {
    sourceKey: string;
    source: NonNullable<Note["nativeSource"]>;
    recheck: () => Promise<void>;
  },
) {
  const folder = `interview-recordings/${scope.candidateId}/meeting-notes`;
  const acl = { owner: "meeting-notes-service", visibility: "private" } as const;
  const path =
    "buffer" in file
      ? await storage.uploadBuffer(file.buffer, mimeType, folder, acl)
      : await storage.uploadFile(file.path, file.size, mimeType, folder, acl);
  try {
    await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
    await native?.recheck();
    const [row] = await dbAdmin
      .insert(meetingNotesTable)
      .values({
        id: randomUUID(),
        title: input.title,
        language: input.language,
        consentStatement: input.consentStatement,
        plannedQuestions: input.plannedQuestions,
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        candidateId: scope.candidateId,
        createdBy: scope.actorId,
        consentAt: new Date(),
        originalName: file.originalname.replace(/[^\w .()-]/g, "_").slice(0, 180),
        byteSize: "buffer" in file ? file.buffer.length : file.size,
        mimeType,
        objectPath: path,
        sourceKey: native?.sourceKey ?? null,
        nativeSource: native?.source ?? null,
      })
      .returning();
    return meetingNoteDTO(row!);
  } catch (error) {
    await storage.deleteObjectByPath(path);
    const pg = error as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const conflict = pg.code === "23505" ? pg : pg.cause;
    if (
      native &&
      conflict?.code === "23505" &&
      conflict.constraint === "meeting_notes_source_key_unique"
    ) {
      await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
      await native.recheck();
      const [existing] = await dbAdmin
        .select()
        .from(meetingNotesTable)
        .where(and(noteWhere(scope), eq(meetingNotesTable.sourceKey, native.sourceKey)))
        .limit(1);
      await native.recheck();
      if (existing && !existing.error?.startsWith("Deletion pending."))
        return meetingNoteDTO(existing);
    }
    throw error;
  }
}

export async function downloadMeetingNote(scope: MeetingScope, id: string) {
  const note = await meetingNote(scope, id);
  const response = await storage.downloadObject(
    await storage.getObjectEntityFile(note.objectPath),
    0,
  );
  try {
    await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
    await meetingNote(scope, id);
    return { note, response };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

export async function deleteMeetingNote(scope: MeetingScope, id: string) {
  const note = await meetingNote(scope, id);
  // Invalidate any in-flight worker before deleting bytes. Keep a recoverable row
  // on storage failure rather than reporting deletion while retaining a recording.
  await dbAdmin
    .update(meetingNotesTable)
    .set({
      processingToken: null,
      status: "failed",
      error: "Deletion pending. Retry Delete to remove the recording.",
      transcript: null,
      summary: null,
      questionReview: null,
      speakerEvidence: null,
      updatedAt: new Date(),
    })
    .where(noteWhere(scope, id));
  const deleted = await storage.deleteObjectByPath(note.objectPath);
  if (!deleted.ok)
    throw new MeetingNotesError(503, "Recording deletion did not complete. Please retry Delete.");
  await dbAdmin.delete(meetingNotesTable).where(noteWhere(scope, id));
}

/** One explicit, leased processing attempt. No scheduler or automatic paid retry. */
export async function startMeetingNote(scope: MeetingScope, id: string, separateSpeakers = false) {
  const note = await meetingNote(scope, id);
  if (separateSpeakers && (!deepgramConfigured() || !deepgramLanguageFor(note.language))) {
    throw new MeetingNotesError(
      422,
      "Speaker separation is unavailable for this recording language or provider configuration. Standard processing remains available.",
    );
  }
  if (note.error?.startsWith("Deletion pending.")) {
    throw new MeetingNotesError(
      409,
      "Finish deleting this recording before starting another action.",
    );
  }
  if (note.status === "completed")
    throw new MeetingNotesError(409, "This recording has already been processed.");
  if (note.status === "processing" && !meetingCanRetry(note.status, note.processingStartedAt)) {
    throw new MeetingNotesError(409, "This recording is already processing.");
  }
  const token = randomUUID();
  const [claimed] = await dbAdmin
    .update(meetingNotesTable)
    .set({
      status: "processing",
      processingToken: token,
      processingStartedAt: new Date(),
      transcript: null,
      summary: null,
      questionReview: null,
      speakerEvidence: null,
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        noteWhere(scope, id),
        eq(meetingNotesTable.status, note.status),
        note.processingToken === null
          ? isNull(meetingNotesTable.processingToken)
          : eq(meetingNotesTable.processingToken, note.processingToken),
        note.error === null
          ? isNull(meetingNotesTable.error)
          : eq(meetingNotesTable.error, note.error),
      ),
    )
    .returning();
  if (!claimed)
    throw new MeetingNotesError(409, "The recording changed. Refresh before processing.");
  // This attempt is recoverable, not a durable background queue: if the process
  // exits the persisted recording remains and staff can explicitly retry at lease expiry.
  void processMeetingNote(scope, claimed, token, separateSpeakers);
  return meetingNoteDTO(claimed);
}

export async function saveMeetingQuestionReview(
  scope: MeetingScope,
  id: string,
  input: ReturnType<typeof meetingQuestionReviewInput.parse>,
) {
  const note = await meetingNote(scope, id);
  if (
    !note.transcript ||
    !["completed", "failed"].includes(note.status) ||
    note.error?.startsWith("Deletion pending.") ||
    meetingTranscriptHash(note.transcript) !== input.sourceHash ||
    (note.questionReview?.revision ?? null) !== input.previousRevision
  ) {
    throw new MeetingNotesError(
      409,
      "The transcript or review changed. Refresh and review the current source before saving.",
    );
  }
  let entries;
  try {
    entries = meetingQuestionEvidence(input, note.plannedQuestions, note.transcript);
  } catch (error) {
    if (error instanceof MeetingQuestionEvidenceError)
      throw new MeetingNotesError(422, error.message);
    throw error;
  }
  await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
  const [saved] = await dbAdmin
    .update(meetingNotesTable)
    .set({
      questionReview: {
        revision: randomUUID(),
        sourceHash: input.sourceHash,
        reviewedBy: scope.actorId,
        reviewedAt: new Date().toISOString(),
        entries,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        noteWhere(scope, id),
        eq(meetingNotesTable.status, note.status),
        eq(meetingNotesTable.transcript, note.transcript),
        input.previousRevision === null
          ? isNull(meetingNotesTable.questionReview)
          : sql`${meetingNotesTable.questionReview}->>'revision' = ${input.previousRevision}`,
      ),
    )
    .returning();
  if (!saved)
    throw new MeetingNotesError(409, "The transcript or review changed. Refresh before saving.");
  return meetingNoteDTO(saved);
}

export async function saveMeetingSpeakerReview(
  scope: MeetingScope,
  id: string,
  input: ReturnType<typeof meetingSpeakerReviewInput.parse>,
) {
  const note = await meetingNote(scope, id);
  const evidence = note.speakerEvidence;
  if (
    !note.transcript ||
    !evidence ||
    !["completed", "failed"].includes(note.status) ||
    note.error?.startsWith("Deletion pending.") ||
    evidence.revision !== input.sourceRevision ||
    (evidence.review?.revision ?? null) !== input.previousRevision
  ) {
    throw new MeetingNotesError(
      409,
      "The speaker source or review changed. Refresh before saving.",
    );
  }
  let labels;
  try {
    labels = meetingSpeakerLabels(input, evidence);
  } catch (error) {
    if (error instanceof MeetingSpeakerReviewError) throw new MeetingNotesError(422, error.message);
    throw error;
  }
  await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
  const [saved] = await dbAdmin
    .update(meetingNotesTable)
    .set({
      speakerEvidence: {
        ...evidence,
        review: {
          revision: randomUUID(),
          reviewedBy: scope.actorId,
          reviewedAt: new Date().toISOString(),
          labels,
        },
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        noteWhere(scope, id),
        eq(meetingNotesTable.status, note.status),
        eq(meetingNotesTable.transcript, note.transcript),
        sql`${meetingNotesTable.speakerEvidence}->>'revision' = ${input.sourceRevision}`,
        sql`coalesce(${meetingNotesTable.speakerEvidence}->'review'->>'revision', '') = ${input.previousRevision ?? ""}`,
      ),
    )
    .returning();
  if (!saved)
    throw new MeetingNotesError(
      409,
      "The speaker source or review changed. Refresh before saving.",
    );
  return meetingNoteDTO(saved);
}

async function processMeetingNote(
  scope: MeetingScope,
  note: Note,
  token: string,
  separateSpeakers: boolean,
) {
  const currentAttempt = async () => {
    await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
    const live = await meetingNote(scope, note.id);
    if (live.processingToken !== token || live.status !== "processing")
      throw new Error("Attempt no longer current.");
    if (Date.now() - note.processingStartedAt!.getTime() >= MEETING_PROCESSING_MS)
      throw new Error("Attempt timed out.");
  };
  const persist = async (values: Partial<Note>) => {
    await currentAttempt();
    await dbAdmin
      .update(meetingNotesTable)
      .set({ ...values, updatedAt: new Date() })
      .where(and(noteWhere(scope, note.id), eq(meetingNotesTable.processingToken, token)));
  };
  try {
    await currentAttempt();
    const response = await storage.downloadObject(
      await storage.getObjectEntityFile(note.objectPath),
      0,
    );
    const bytes = await boundedRecordingBody(response, MAX_MEETING_BYTES);
    let speakerEvidence: Awaited<ReturnType<typeof transcribeMeetingSpeakers>>["evidence"] | null =
      null;
    const transcript = await withMeetingAudio(bytes, async (parts, read) => {
      if (separateSpeakers) {
        await currentAttempt();
        const result = await transcribeMeetingSpeakers({
          bytes,
          contentType: note.mimeType,
          language: note.language,
          tenantId: scope.tenantId,
          jobId: scope.jobId,
        });
        speakerEvidence = result.evidence;
        return result.transcript;
      }
      return transcribeMeetingParts(
        parts,
        read,
        async (buf) =>
          (
            await transcribeAudio({
              buf,
              contentType: "audio/wav",
              rawLang: note.language,
            })
          ).transcript,
        currentAttempt,
      );
    });
    await persist({ transcript, speakerEvidence });
    const request = meetingSummaryPrompt(transcript);
    await currentAttempt();
    const summary = (await generateWithAI(request.prompt, request.system, note.language))?.trim();
    if (!summary) throw new Error("Summary unavailable.");
    await persist({
      status: "completed",
      summary: summary.slice(0, 12_000),
      processingToken: null,
      error: null,
    });
  } catch {
    // Never log captured audio/transcript, provider exception payloads or contact data.
    logger.warn({ noteId: note.id }, "[meeting-notes] Processing did not complete");
    try {
      // Do not require old actor authority to retire this exact lease. The DB
      // erasure trigger still fences candidate persistence.
      await dbAdmin
        .update(meetingNotesTable)
        .set({
          status: "failed",
          processingToken: null,
          updatedAt: new Date(),
          error:
            "Processing did not complete. Check recording audio, supported duration, provider availability and current access before an explicit retry.",
        })
        .where(and(noteWhere(scope, note.id), eq(meetingNotesTable.processingToken, token)));
    } catch {
      /* Erasure/deletion has authority; never restore the removed row. */
    }
  }
}
