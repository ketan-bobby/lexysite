/**
 * interview-invite-copy.ts — the standard "what to expect + tips" script that
 * goes into EVERY candidate email carrying an interview link.
 *
 * Recruiter-approved copy (Aug 2026). One source of truth so the static
 * generate-link email and the AI-drafted outreach/reminder invites can't
 * drift apart. Plain text; rendered to HTML via plainToHtml at the senders.
 */

import { plainToHtml } from "./email";

/** Public URL of the "You're all done!" confirmation screenshot shown at the
 *  end of every interview. Uploaded to the public object bucket at
 *  email/interview-done.png; served unauthenticated via /public-objects. */
export function interviewDoneImageUrl(): string {
  const base = (process.env.APP_BASE_URL || "https://app.l3xy.ai").replace(/\/$/, "");
  return `${base}/api/storage/public-objects/email/interview-done.png`;
}

/** HTML renderer for invite emails: plainToHtml + the completion-screen
 *  screenshot appended, so candidates know what "done" looks like. */
export function inviteEmailHtml(body: string): string {
  const html = plainToHtml(body);
  const imgBlock =
    `<p style="margin-top:24px;">When your interview is complete, you'll see this confirmation screen — that's how you know your responses were submitted:</p>` +
    `<img src="${interviewDoneImageUrl()}" alt="You're all done! Your interview has been submitted to the hiring team." style="max-width:100%;border-radius:8px;border:1px solid #2a3644;" />`;
  return html.replace("</body>", `${imgBlock}</body>`);
}

/** The expectations + tips block. Pass the plan's estimated duration when
 *  known; falls back to the standard "30–40 minutes" range. */
export function interviewInviteTips(durationMinutes?: number | null): string {
  const duration =
    durationMinutes && durationMinutes > 0
      ? `approximately ${durationMinutes} minutes`
      : "approximately 30–40 minutes";
  return `Here’s what to expect during the interview:
💠 Duration: ${duration}
💠 Format: Answer questions naturally, no buttons to click. Just speak as if you're talking to a friend — your responses will be recorded.

A few tips to help you succeed:
💠 Find a quiet, distraction-free environment
💠 Ensure your camera and microphone are working properly, allow access if prompted
💠 Keep your camera on throughout the interview
💠 Look directly at the camera to project confidence
💠 Speak naturally and clearly, there’s no need to read from a script
💠 Stay focused and avoid switching tabs or seeking help during the session
💠 Don’t close the browser until your responses have finished uploading

Good luck, you’ve got this!`;
}

/** Insert the tips block into an email body, keeping any "— Lexy…" signature
 *  as the last line. Used to deterministically enrich AI-drafted invites —
 *  never trust the model to echo the full block. */
export function withInviteTips(body: string, durationMinutes?: number | null): string {
  const tips = interviewInviteTips(durationMinutes);
  if (body.includes("💠")) return body; // already present (idempotent)
  const sigIdx = body.lastIndexOf("— Lexy");
  if (sigIdx > 0) {
    return `${body.slice(0, sigIdx).trimEnd()}\n\n${tips}\n\n${body.slice(sigIdx)}`;
  }
  return `${body.trimEnd()}\n\n${tips}`;
}
