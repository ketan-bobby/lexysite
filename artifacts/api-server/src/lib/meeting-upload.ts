import multer from "multer";
import type { Request } from "express";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { MAX_MEETING_BYTES } from "./meeting-notes-core";

/** One private directory per file; never use a caller-supplied path or filename. */
export async function removeMeetingUpload(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

const storage: multer.StorageEngine = {
  _handleFile(req, file, callback) {
    void (async () => {
      const directory = await mkdtemp(join(tmpdir(), "lexy-meeting-upload-"));
      const path = join(directory, "recording");
      const abort = () => file.stream.destroy(new Error("Recording upload interrupted."));
      req.once("aborted", abort);
      try {
        if (req.aborted) throw new Error("Recording upload interrupted.");
        await pipeline(file.stream, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        const handle = await open(path, "r");
        let size: number;
        try {
          size = (await handle.stat()).size;
        } finally {
          await handle.close();
        }
        if (size > MAX_MEETING_BYTES) throw new multer.MulterError("LIMIT_FILE_SIZE");
        callback(null, { destination: directory, filename: "recording", path, size });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        callback(error as Error);
      } finally {
        req.off("aborted", abort);
      }
    })().catch((error: Error) => callback(error));
  },
  _removeFile(_req, file, callback) {
    removeMeetingUpload(file.path).then(() => callback(null), callback);
  },
};

export const meetingUpload = multer({
  storage,
  // Busboy flags a limit when it reaches the threshold, not only above it.
  // Receive one sentinel byte, then enforce the inclusive bound before saving.
  limits: { fileSize: MAX_MEETING_BYTES + 1, files: 1, fields: 5, fieldSize: 8000 },
}).single("file");

/** Only signature bytes are read into memory, not the complete recording. */
export async function meetingUploadHeader(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function receiveMeetingUpload(req: Request, res: Parameters<typeof meetingUpload>[1]) {
  return new Promise<void>((resolve, reject) => {
    meetingUpload(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
  });
}
