import { Router, type Request, type Response, type NextFunction } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { meetingProcessingInput, meetingSpeakerReviewInput } from "../lib/meeting-speakers";
import { resolveUser } from "../middlewares/resolveUser";
import {
  meetingMediaType,
  meetingUploadInput,
  meetingQuestionReviewInput,
} from "../lib/meeting-notes-core";
import {
  MeetingNotesError,
  meetingScope,
  meetingNotes,
  meetingNote,
  meetingNoteDTO,
  saveMeetingNote,
  deleteMeetingNote,
  downloadMeetingNote,
  startMeetingNote,
  saveMeetingQuestionReview,
  saveMeetingSpeakerReview,
} from "../lib/meeting-notes-service";
import { meetingNotesExportReady, meetingNotesExportText } from "../lib/meeting-notes-export";
import {
  nativeZoomAppointments,
  previewNativeZoom,
  importNativeZoom,
} from "../lib/native-zoom-recordings";
import { nativeZoomPreviewInput, nativeZoomImportInput } from "../lib/native-recording-review";
import {
  nativeMeetAppointments,
  nativeMeetService,
  withNativeMeetUsage,
} from "../lib/native-meet-recordings";
import { nativeMeetPreviewInput } from "../lib/native-meet-recording-review";
import { GoogleMeetRecordingError } from "../lib/google-meet-recordings-provider";
import { CalendarError } from "../lib/outlook-calendar-core";
import { NativeRecordingError } from "../lib/zoom-recordings-provider";
import {
  meetingUploadHeader,
  receiveMeetingUpload,
  removeMeetingUpload,
} from "../lib/meeting-upload";

const router = Router();
const base = "/jobs/:jobId/candidates/:candidateId/meeting-notes";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);

async function scope(req: Request) {
  const jobId = identifier.parse(req.params.jobId);
  const candidateId = identifier.parse(req.params.candidateId);
  return meetingScope(req.resolvedUser!.id, jobId, candidateId);
}

// Authenticate and authorize before receiving private media.
router.use(base, resolveUser, async (req: Request, _res: Response, next: NextFunction) => {
  try {
    await scope(req);
    next();
  } catch (error) {
    next(error);
  }
});
router.get(base, async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store").json(await meetingNotes(await scope(req)));
});
router.post(base, async (req, res): Promise<void> => {
  try {
    try {
      await receiveMeetingUpload(req, res);
    } catch (error) {
      if (!req.aborted)
        res
          .status((error as { code?: string }).code === "LIMIT_FILE_SIZE" ? 413 : 400)
          .json({ error: "Upload one supported recording, at most 100 MB." });
      return;
    }
    const input = meetingUploadInput.parse(req.body);
    if (!req.file) {
      res.status(400).json({ error: "Choose a recording." });
      return;
    }
    const mime = meetingMediaType(await meetingUploadHeader(req.file.path));
    if (!mime) {
      res.status(415).json({ error: "Use a WAV, MP3, WEBM, MP4, OGG or FLAC recording." });
      return;
    }
    // Duration/audio validity is checked in isolated temporary files at processing.
    if (req.aborted) return;
    res
      .status(201)
      .json(
        await saveMeetingNote(
          await scope(req),
          { path: req.file.path, size: req.file.size, originalname: req.file.originalname },
          input,
          mime,
        ),
      );
  } finally {
    if (req.file?.path) await removeMeetingUpload(req.file.path);
  }
});
router.get(`${base}/native-google-meet/appointments`, async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store").json(await nativeMeetAppointments(await scope(req)));
});
router.post(`${base}/native-google-meet/conferences`, async (req, res): Promise<void> => {
  const input = nativeZoomPreviewInput.parse(req.body),
    current = await scope(req);
  res
    .set("Cache-Control", "no-store")
    .json(
      await withNativeMeetUsage(current, () =>
        nativeMeetService.conferences(current, input.scheduleId),
      ),
    );
});
router.post(`${base}/native-google-meet/preview`, async (req, res): Promise<void> => {
  const input = nativeMeetPreviewInput.parse(req.body),
    current = await scope(req);
  res
    .set("Cache-Control", "no-store")
    .json(
      await withNativeMeetUsage(current, () =>
        nativeMeetService.preview(current, input.scheduleId, input.conferenceName),
      ),
    );
});
router.post(`${base}/native-google-meet/import`, async (req, res): Promise<void> => {
  const input = nativeZoomImportInput.parse(req.body),
    current = await scope(req);
  res
    .set("Cache-Control", "no-store")
    .status(201)
    .json(await withNativeMeetUsage(current, () => nativeMeetService.import(current, input)));
});
router.get(`${base}/native-zoom/appointments`, async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store").json(await nativeZoomAppointments(await scope(req)));
});
router.post(`${base}/native-zoom/preview`, async (req, res): Promise<void> => {
  const input = nativeZoomPreviewInput.parse(req.body);
  res
    .set("Cache-Control", "no-store")
    .json(await previewNativeZoom(await scope(req), input.scheduleId));
});
router.post(`${base}/native-zoom/import`, async (req, res): Promise<void> => {
  const input = nativeZoomImportInput.parse(req.body);
  res
    .set("Cache-Control", "no-store")
    .status(201)
    .json(await importNativeZoom(await scope(req), input));
});
router.get(`${base}/:noteId`, async (req, res): Promise<void> => {
  res
    .set("Cache-Control", "no-store")
    .json(meetingNoteDTO(await meetingNote(await scope(req), identifier.parse(req.params.noteId))));
});
router.post(`${base}/:noteId/process`, async (req, res): Promise<void> => {
  const input = meetingProcessingInput.parse(req.body);
  res
    .status(202)
    .json(
      await startMeetingNote(
        await scope(req),
        identifier.parse(req.params.noteId),
        input.separateSpeakers,
      ),
    );
});
router.put(`${base}/:noteId/speaker-review`, async (req, res): Promise<void> => {
  const input = meetingSpeakerReviewInput.parse(req.body);
  res
    .set("Cache-Control", "no-store")
    .json(
      await saveMeetingSpeakerReview(await scope(req), identifier.parse(req.params.noteId), input),
    );
});
router.put(`${base}/:noteId/question-review`, async (req, res): Promise<void> => {
  const input = meetingQuestionReviewInput.parse(req.body);
  res
    .set("Cache-Control", "no-store")
    .json(
      await saveMeetingQuestionReview(await scope(req), identifier.parse(req.params.noteId), input),
    );
});
router.delete(`${base}/:noteId`, async (req, res): Promise<void> => {
  await deleteMeetingNote(await scope(req), identifier.parse(req.params.noteId));
  res.status(204).end();
});
router.get(`${base}/:noteId/notes-export`, async (req, res): Promise<void> => {
  const note = await meetingNote(await scope(req), identifier.parse(req.params.noteId));
  if (!meetingNotesExportReady(note) || note.error?.startsWith("Deletion pending."))
    throw new MeetingNotesError(
      409,
      "A saved transcript must be available before downloading notes.",
    );
  res
    .set({
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-notes-${note.id}.txt"`,
      "X-Content-Type-Options": "nosniff",
    })
    .send(meetingNotesExportText(note, new Date()));
});
router.get(`${base}/:noteId/recording`, async (req, res): Promise<void> => {
  const { note, response } = await downloadMeetingNote(
    await scope(req),
    identifier.parse(req.params.noteId),
  );
  // Private fetch-only download: no public/presigned object URL or token is exposed.
  res.set({
    "Cache-Control": "no-store",
    "Content-Type": note.mimeType,
    "Content-Disposition": `attachment; filename="${note.originalName || "interview-recording"}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (!response.body) {
    res.status(503).end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});
router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (
    error instanceof MeetingNotesError ||
    error instanceof NativeRecordingError ||
    error instanceof GoogleMeetRecordingError ||
    error instanceof CalendarError
  ) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Check the recording details and consent." });
    return;
  }
  next(error);
});
export default router;
