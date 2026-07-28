/**
 * outreach-reply-tokens.ts — HMAC-Signed One-Click Reply Tokens
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Generates and verifies signed tokens embedded in outreach email buttons.
 * When a candidate clicks "I'm interested" / "Not for this role" / "Stop
 * emailing me" in an outreach email, their browser hits a public URL that
 * contains one of these tokens. The server verifies the signature and applies
 * the action without requiring the candidate to log in.
 *
 * ─── Two token namespaces ────────────────────────────────────────────────────
 *   Enrollment tokens   — tied to outreach_enrollments rows (campaign sequences)
 *     signReplyToken()   / verifyReplyToken()
 *     URL: GET /api/outreach/reply/:token
 *
 *   Message tokens      — tied to outreach_messages rows (one-off orchestrator emails)
 *     signMessageReplyToken() / verifyMessageReplyToken()
 *     URL: GET /api/outreach/reply-msg/:token
 *
 * Both use the same HMAC-SHA256 scheme with an `m.` prefix on message tokens
 * so the two URL handlers can never confuse each other's payloads.
 *
 * ─── Token format ────────────────────────────────────────────────────────────
 *   Enrollment:  base64url("${enrollmentId}.${action}.${expMs}.${sig}")
 *   Message:     base64url("m.${messageId}.${action}.${expMs}.${sig}")
 *   sig = HMAC-SHA256(payload_without_sig, INBOUND_EMAIL_SECRET)
 *   TTL = 60 days
 *
 * ─── Security ────────────────────────────────────────────────────────────────
 * Signature comparison uses crypto.timingSafeEqual() to defeat timing attacks.
 * Without INBOUND_EMAIL_SECRET configured, sign functions throw and
 * buildQuickReplyBlocks() returns empty strings (graceful degradation in dev).
 *
 * ─── UI helpers ──────────────────────────────────────────────────────────────
 * buildQuickReplyBlocks()        — 3-button block for campaign enrollment emails
 * buildMessageQuickReplyBlocks() — 3-button block for orchestrator one-off emails
 * Both render "bulletproof" table-based HTML buttons that work in Gmail, Outlook,
 * Apple Mail, and Yahoo without being clipped by the "trim quoted text" heuristic.
 */
import crypto from "node:crypto";

/**
 * Quick-reply tokens are signed payloads embedded in outreach email
 * buttons. Clicking a button hits GET /api/outreach/reply/:token, which
 * verifies the HMAC and applies the action.
 *
 * Format: base64url(`${enrollmentId}.${action}.${expMs}.${sig}`)
 *   sig = HMAC-SHA256( `${enrollmentId}.${action}.${expMs}`, INBOUND_EMAIL_SECRET )
 *
 * Tokens expire after 60 days so old emails can't be re-clicked
 * indefinitely after a candidate is re-engaged on a new job.
 */
const SECRET = process.env.INBOUND_EMAIL_SECRET || "";
const TTL_MS = 60 * 24 * 60 * 60 * 1000;

export type ReplyAction = "interested" | "not_interested_job" | "dnc";

export function signReplyToken(enrollmentId: string, action: ReplyAction): string {
  if (!SECRET) throw new Error("INBOUND_EMAIL_SECRET not configured");
  const exp = Date.now() + TTL_MS;
  const payload = `${enrollmentId}.${action}.${exp}`;
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export function verifyReplyToken(token: string):
  | { ok: true; enrollmentId: string; action: ReplyAction }
  | { ok: false; error: string }
{
  if (!SECRET) return { ok: false, error: "secret_not_configured" };
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return { ok: false, error: "malformed_token" };
  }
  const parts = decoded.split(".");
  if (parts.length !== 4) return { ok: false, error: "malformed_token" };
  const [enrollmentId, action, expStr, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET)
    .update(`${enrollmentId}.${action}.${expStr}`)
    .digest("hex");
  // Timing-safe comparison to defeat trivial signature-leak attacks.
  if (sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return { ok: false, error: "bad_signature" };
  }
  if (Number(expStr) < Date.now()) return { ok: false, error: "expired" };
  if (!["interested", "not_interested_job", "dnc"].includes(action)) {
    return { ok: false, error: "bad_action" };
  }
  return { ok: true, enrollmentId, action: action as ReplyAction };
}

/**
 * Message-scoped reply tokens. Used by the screening / orchestrator path
 * which sends one-off candidate emails via `outreach_messages` (no
 * enrollment row). Same HMAC scheme as enrollment tokens but namespaced
 * with an `m` prefix so the two URL handlers can never confuse each
 * other's payloads even if a token is pasted into the wrong route.
 *
 * Format: base64url(`m.${messageId}.${action}.${expMs}.${sig}`)
 *   sig = HMAC-SHA256(`m.${messageId}.${action}.${expMs}`, INBOUND_EMAIL_SECRET)
 */
export function signMessageReplyToken(messageId: string, action: ReplyAction): string {
  if (!SECRET) throw new Error("INBOUND_EMAIL_SECRET not configured");
  const exp = Date.now() + TTL_MS;
  const payload = `m.${messageId}.${action}.${exp}`;
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export function verifyMessageReplyToken(token: string):
  | { ok: true; messageId: string; action: ReplyAction }
  | { ok: false; error: string }
{
  if (!SECRET) return { ok: false, error: "secret_not_configured" };
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return { ok: false, error: "malformed_token" };
  }
  const parts = decoded.split(".");
  if (parts.length !== 5 || parts[0] !== "m") return { ok: false, error: "malformed_token" };
  const [, messageId, action, expStr, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET)
    .update(`m.${messageId}.${action}.${expStr}`)
    .digest("hex");
  if (sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return { ok: false, error: "bad_signature" };
  }
  if (Number(expStr) < Date.now()) return { ok: false, error: "expired" };
  if (!["interested", "not_interested_job", "dnc"].includes(action)) {
    return { ok: false, error: "bad_action" };
  }
  return { ok: true, messageId, action: action as ReplyAction };
}

/**
 * Build the HTML and plain-text quick-reply blocks for an outgoing
 * outreach email. Returns an empty string for both when the secret is
 * not configured (allows local dev without crashing the send path).
 */
export function buildQuickReplyBlocks(enrollmentId: string, baseUrl: string):
  { html: string; text: string }
{
  if (!SECRET) return { html: "", text: "" };

  const url = (action: ReplyAction) =>
    `${baseUrl.replace(/\/$/, "")}/api/outreach/reply/${signReplyToken(enrollmentId, action)}`;

  // Email-safe "bulletproof" button using a <table>. Inline <a>+CSS-padding
  // buttons get stripped or visually flattened by Outlook and tucked behind
  // Gmail's "trim quoted text" heuristic when they sit under a grey divider.
  // A table-cell button with solid background renders correctly in every
  // major email client (Gmail web/iOS/Android, Apple Mail, Outlook, Yahoo).
  const tableBtn = (href: string, label: string, bg: string, fg: string) => `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display:inline-block;margin:0 8px 8px 0;">
      <tr><td align="center" style="background:${bg};border-radius:6px;">
        <a href="${href}" target="_blank" style="display:inline-block;padding:14px 22px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1;text-decoration:none;color:${fg};">${label}</a>
      </td></tr>
    </table>`;

  const html = `
<div style="margin:32px 0 8px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
  <div style="margin-bottom:14px;font-size:15px;font-weight:600;color:#111827;">Reply with one click:</div>
  ${tableBtn(url("interested"), "Yes, I'm interested", "#16a34a", "#ffffff")}
  ${tableBtn(url("not_interested_job"), "Not for this role", "#f59e0b", "#ffffff")}
  ${tableBtn(url("dnc"), "Don't contact me", "#dc2626", "#ffffff")}
</div>`.trim();

  const text = [
    "",
    "—",
    "Quick reply (one click):",
    `  Yes, I'm interested:    ${url("interested")}`,
    `  Not for this role:      ${url("not_interested_job")}`,
    `  Stop emailing me (DNC): ${url("dnc")}`,
  ].join("\n");

  return { html, text };
}

/**
 * Same visual buttons as `buildQuickReplyBlocks`, but signs message-scoped
 * tokens for emails sent through the screening / orchestrator path that
 * have no campaign enrollment (only an `outreach_messages` row).
 */
export function buildMessageQuickReplyBlocks(messageId: string, baseUrl: string):
  { html: string; text: string }
{
  if (!SECRET) return { html: "", text: "" };

  const url = (action: ReplyAction) =>
    `${baseUrl.replace(/\/$/, "")}/api/outreach/reply-msg/${signMessageReplyToken(messageId, action)}`;

  const tableBtn = (href: string, label: string, bg: string, fg: string) => `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display:inline-block;margin:0 8px 8px 0;">
      <tr><td align="center" style="background:${bg};border-radius:6px;">
        <a href="${href}" target="_blank" style="display:inline-block;padding:14px 22px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1;text-decoration:none;color:${fg};">${label}</a>
      </td></tr>
    </table>`;

  const html = `
<div style="margin:32px 0 8px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
  <div style="margin-bottom:14px;font-size:15px;font-weight:600;color:#111827;">Reply with one click:</div>
  ${tableBtn(url("interested"), "Yes, I'm interested", "#16a34a", "#ffffff")}
  ${tableBtn(url("not_interested_job"), "Not for this role", "#f59e0b", "#ffffff")}
  ${tableBtn(url("dnc"), "Don't contact me", "#dc2626", "#ffffff")}
</div>`.trim();

  const text = [
    "",
    "—",
    "Quick reply (one click):",
    `  Yes, I'm interested:    ${url("interested")}`,
    `  Not for this role:      ${url("not_interested_job")}`,
    `  Stop emailing me (DNC): ${url("dnc")}`,
  ].join("\n");

  return { html, text };
}
