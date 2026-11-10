import type { Request, Response } from "express";
import { once } from "node:events";
import { createHash } from "node:crypto";
import multer from "multer";
import { z } from "zod";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { ObjectStorageService, s3Client } from "./objectStorage";

const storage = new ObjectStorageService();
const uuid = z.string().uuid();
const fields = z
  .object({
    attemptId: uuid,
    index: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(9999)),
  })
  .strict();
export const recordingSegmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
});

function prefix(sessionId: string) {
  return `${storage.getPrivatePrefix()}/recording-segments/${uuid.parse(sessionId)}/`;
}

async function objects(sessionId: string) {
  const found: Array<{ key: string; size: number; modified: string }> = [];
  let token: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: storage.getBucket(),
        Prefix: prefix(sessionId),
        ContinuationToken: token,
      }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key)
        found.push({
          key: item.Key,
          size: item.Size ?? 0,
          modified: item.LastModified?.toISOString() ?? "",
        });
    }
    token = page.NextContinuationToken;
    if (found.length > 10000) throw new Error("Recording segment limit exceeded");
  } while (token);
  return found;
}

/** Pure grouping: missing middle chunks must never be presented as a complete stream. */
export function groupRecordingSegments(
  items: Array<{ key: string; size: number; modified: string }>,
) {
  const groups = new Map<
    string,
    {
      attemptId: string;
      partCount: number;
      bytes: number;
      startedAt: string;
      contiguous: boolean;
      indices: number[];
    }
  >();
  for (const item of items) {
    const match = item.key.match(/\/([0-9a-f-]{36})\/part_(\d{4})\.(webm|mp4)$/i);
    if (!match || !uuid.safeParse(match[1]).success) continue;
    const group = groups.get(match[1]) ?? {
      attemptId: match[1],
      partCount: 0,
      bytes: 0,
      startedAt: item.modified,
      contiguous: false,
      indices: [],
    };
    group.indices.push(Number(match[2]));
    group.partCount++;
    group.bytes += item.size;
    if (item.modified < group.startedAt) group.startedAt = item.modified;
    groups.set(match[1], group);
  }
  return [...groups.values()]
    .map(({ indices, ...group }) => ({
      ...group,
      contiguous: indices.sort((a, b) => a - b).every((n, i) => n === i),
    }))
    .sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId),
    );
}

// Routes supply the existing session-cookie, consent, approval and read gates.
export async function uploadRecordingSegment(req: Request, res: Response) {
  const parsed = fields.safeParse(req.body);
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!parsed.success || !file?.size) {
    res.status(400).json({ error: "Invalid recording segment" });
    return;
  }
  const mime = file.mimetype.split(";")[0];
  if (!["video/webm", "audio/webm", "video/mp4", "audio/mp4"].includes(mime)) {
    res.status(400).json({ error: "Unsupported recording segment type" });
    return;
  }
  const { attemptId, index } = parsed.data;
  const key = `${prefix(String(req.params.interviewId))}${attemptId}/part_${String(index).padStart(4, "0")}.${mime.includes("mp4") ? "mp4" : "webm"}`;
  const sha = createHash("sha256").update(file.buffer).digest("hex");
  try {
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: storage.getBucket(),
          Key: key,
          Body: file.buffer,
          ContentType: mime,
          Metadata: { sha256: sha },
          IfNoneMatch: "*",
          ServerSideEncryption: "AES256",
        }),
      );
    } catch (error: any) {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
      const existing = await s3Client.send(
        new HeadObjectCommand({ Bucket: storage.getBucket(), Key: key }),
      );
      if (existing.Metadata?.sha256 !== sha) {
        res.status(409).json({ error: "Recording segment already exists with different content" });
        return;
      }
    }
    res.json({ saved: true, attemptId, index });
  } catch (error) {
    req.log.error({ err: error }, "Recording checkpoint upload failed");
    res.status(503).json({ error: "Recording checkpoint could not be saved" });
  }
}

export async function listRecordingSegments(req: Request, res: Response) {
  try {
    res.json({ recordings: groupRecordingSegments(await objects(String(req.params.interviewId))) });
  } catch (error) {
    req.log.error({ err: error }, "Recording checkpoint listing failed");
    res.status(503).json({ error: "Saved recordings are temporarily unavailable" });
  }
}

export async function downloadRecordingSegment(req: Request, res: Response) {
  const attempt = uuid.safeParse(req.params.attemptId);
  if (!attempt.success) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  try {
    const items = (await objects(String(req.params.interviewId)))
      .filter((item) =>
        item.key.startsWith(`${prefix(String(req.params.interviewId))}${attempt.data}/`),
      )
      .sort((a, b) => a.key.localeCompare(b.key));
    const [group] = groupRecordingSegments(items);
    if (!group) {
      res.status(404).json({ error: "Recording not found" });
      return;
    }
    if (!group.contiguous) {
      res
        .status(409)
        .json({ error: "This recording has missing chunks; use the final recording if available" });
      return;
    }
    res.setHeader("Content-Length", group.bytes);
    res.setHeader("Cache-Control", "private, no-store");
    for (const item of items) {
      if (res.destroyed) return;
      const part = await s3Client.send(
        new GetObjectCommand({ Bucket: storage.getBucket(), Key: item.key }),
      );
      if (!res.headersSent) res.setHeader("Content-Type", part.ContentType ?? "video/webm");
      const stream = part.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
      for await (const chunk of stream) {
        if (res.destroyed) {
          stream.destroy?.();
          return;
        }
        if (!res.write(chunk)) await once(res, "drain");
      }
    }
    res.end();
  } catch (error) {
    req.log.error({ err: error }, "Recording checkpoint playback failed");
    if (res.headersSent) res.destroy();
    else res.status(503).json({ error: "Recording playback is unavailable" });
  }
}
