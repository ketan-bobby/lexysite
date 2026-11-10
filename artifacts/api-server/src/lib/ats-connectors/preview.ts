import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Preview cursors are short-lived, encrypted server capabilities, not OAuth
// credentials. Restarting the process invalidates them; users reload page one.
const key = randomBytes(32);
const positiveId = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid ATS record");
  return String(value);
};
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ATS record");
  return value as Record<string, unknown>;
};
const text = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid ATS record");
  return value;
};

export function previewJob(records: unknown, expectedId: string) {
  if (!Array.isArray(records) || records.length !== 1) throw new Error("ATS job unavailable");
  const item = row(records[0]);
  if (positiveId(item.id) !== expectedId || item.confidential !== false)
    throw new Error("ATS job unavailable");
  if (!["open", "draft", "closed"].includes(String(item.status)))
    throw new Error("Invalid ATS job");
  return { id: expectedId, name: text(item.name, 1000), status: String(item.status) };
}

export function previewApplications(records: unknown, expectedJobId: string) {
  if (!Array.isArray(records) || records.length > 25) throw new Error("Invalid ATS page");
  const seen = new Set<string>();
  return records.map((value) => {
    const item = row(value);
    const id = positiveId(item.id);
    if (
      seen.has(id) ||
      positiveId(item.job_id) !== expectedJobId ||
      item.prospect !== false ||
      !["in_process", "rejected", "hired", "converted"].includes(String(item.status))
    )
      throw new Error("Invalid ATS application");
    seen.add(id);
    return {
      id,
      candidateId: positiveId(item.candidate_id),
      status: String(item.status),
      stageName: item.stage_name === null ? null : text(item.stage_name, 500),
    };
  });
}

export function sealPreviewCursor(cursor: string, scope: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope));
  const payload = Buffer.from(JSON.stringify({ cursor, expires: Date.now() + 600_000 }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openPreviewCursor(token: string, scope: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 16000)
    throw new Error("Invalid preview cursor");
  const bytes = Buffer.from(token, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const payload = JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
  ) as { cursor: unknown; expires: unknown };
  if (
    typeof payload.cursor !== "string" ||
    !payload.cursor ||
    payload.cursor.length > 8000 ||
    typeof payload.expires !== "number" ||
    payload.expires <= Date.now()
  )
    throw new Error("Expired preview cursor");
  return payload.cursor;
}
