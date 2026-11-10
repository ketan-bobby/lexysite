import { z } from "zod";

const Cursor = z
  .object({
    v: z.literal(1),
    userId: z.string().min(1).max(128),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      .refine(
        (at) =>
          !at.startsWith("0000-") &&
          Number.isFinite(Date.parse(at)) &&
          new Date(at).toISOString().slice(0, 19) === at.slice(0, 19),
      ),
  })
  .strict();

export function notificationCursor(userId: string, id: string, at: string): string {
  return Buffer.from(JSON.stringify(Cursor.parse({ v: 1, userId, id, at }))).toString("base64url");
}

export function readNotificationCursor(value: string, userId: string) {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
  const cursor = Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  if (cursor.userId !== userId) throw new Error("Cursor belongs to a different user");
  return cursor;
}
