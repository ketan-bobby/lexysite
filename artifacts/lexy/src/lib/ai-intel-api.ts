/**
 * ai-intel-api.ts — client helpers for the Brand / Workorder AI Intelligence layer.
 *
 * `aiFetch` is a thin authenticated JSON wrapper — auth rides on the httpOnly
 * `session_token` cookie (cookie-auth migration), matching the convention used
 * elsewhere in the recruiter app. `aiUpload` posts a multipart file WITHOUT a
 * JSON Content-Type so the document-distill endpoints receive the file
 * correctly.
 */
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function aiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const err = new Error(`API ${res.status}`) as Error & { code?: string; status?: number };
    err.status = res.status;
    try {
      const data = await res.json();
      if (data?.error) err.message = data.error;
      if (data?.code) err.code = data.code;
    } catch {
      /* non-JSON error body */
    }
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function aiUpload<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { ...authHeaders() },
    body: fd,
  });
  if (!res.ok) {
    let message = `Upload failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ── Shared option lists (mirror the server enums) ──────────────────────────────
export const AI_TONES = [
  { value: "formal", label: "Formal" },
  { value: "warm", label: "Warm" },
  { value: "direct", label: "Direct" },
  { value: "premium", label: "Premium" },
  { value: "technical", label: "Technical" },
  { value: "conversational", label: "Conversational" },
] as const;

export const AI_MESSAGE_TYPES = [
  { value: "outreach", label: "Cold outreach", candidateFacing: true },
  { value: "follow_up", label: "Follow-up", candidateFacing: true },
  { value: "interview_invite", label: "Interview invite", candidateFacing: true },
  { value: "rejection", label: "Rejection", candidateFacing: true },
  { value: "nurture", label: "Nurture", candidateFacing: true },
  { value: "hm_summary", label: "Hiring-manager summary", candidateFacing: false },
  { value: "submission_summary", label: "Submission summary", candidateFacing: false },
  { value: "talking_points", label: "Talking points", candidateFacing: false },
  { value: "client_update", label: "Client update", candidateFacing: false },
] as const;

export const AI_DOC_TYPES = [
  { value: "brand_guide", label: "Brand guide" },
  { value: "values_document", label: "Values document" },
  { value: "benefits_guide", label: "Benefits guide" },
  { value: "company_deck", label: "Company deck" },
  { value: "careers_page", label: "Careers page" },
  { value: "job_family", label: "Job family" },
  { value: "hiring_guidelines", label: "Hiring guidelines" },
  { value: "workorder_doc", label: "Role document" },
  { value: "other", label: "Other" },
] as const;

export function messageTypeLabel(value: string): string {
  return AI_MESSAGE_TYPES.find((t) => t.value === value)?.label ?? value;
}
