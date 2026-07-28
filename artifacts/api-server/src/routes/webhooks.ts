/**
 * routes/webhooks.ts — Inbound Email Webhook & Candidate Reply Parser
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Receives inbound email webhooks from SendGrid / AWS SES Inbound and routes
 * replies from candidates to the correct outreach thread. This is the entry
 * point for the "reply handling" half of the outreach loop.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /webhooks/email/inbound       Main inbound email handler.
 *                                      Accepts multipart/form-data (SendGrid
 *                                      Inbound Parse format) OR raw MIME via
 *                                      application/octet-stream.
 *   POST /webhooks/email/inbound-sns   AWS SNS wrapper: unwraps the SNS
 *                                      envelope and forwards the inner MIME
 *                                      message to the same parser.
 *
 * ─── Processing pipeline ─────────────────────────────────────────────────────
 *   1. Parse raw MIME with mailparser (handles quoted text, inline images,
 *      HTML → plain text extraction)
 *   2. Strip quoted text ("On <date> John wrote:…") so only the new reply body
 *      reaches the AI classifier
 *   3. Identify the thread: match From email → outreach_messages (sent from
 *      this tenant's SES domain) or outreach_enrollments
 *   4. Store the reply in recruiter_inbox (raw body + inline images as
 *      base64 data URLs — capped at 200 KB per image, 5 images max)
 *   5. Call classifyReply() (outreach-engine.ts) → GPT-4o decides:
 *      interested / not_interested / needs_more_info / dnc
 *   6. Apply the classification (DNC flag, enrollment cancel, interview invite,
 *      conversation draft creation via outreach-conversation.ts)
 *
 * ─── InboxAttachment ─────────────────────────────────────────────────────────
 * Inline images (CID references in HTML) are stored as base64 data URLs inside
 * the recruiter_inbox row. This avoids exposing public S3 URLs for untrusted
 * email content and eliminates the extra storage round-trip on inbox render.
 *
 * ─── Prompt-injection guard ──────────────────────────────────────────────────
 * The raw email body is untrusted. It is passed to AI classification wrapped
 * in explicit DATA delimiters with instructions to treat it as data only.
 * ASCII control characters are stripped before the AI call.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { simpleParser, type ParsedMail, type Attachment as ParsedAttachment } from "mailparser";
import { db } from "@workspace/db";
import {
  candidatesTable, sourcedCandidatesTable,
  outreachEnrollmentsTable, outreachMessagesTable,
} from "@workspace/db";
import { eq, desc, and, or, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { classifyReply } from "../lib/outreach-engine";
import { recordAudit } from "../lib/audit";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import nodeCryptoForSns from "node:crypto";

/**
 * Inline-image attachment surfaced to the recruiter inbox.
 *
 * `url` is a `data:image/...;base64,...` URL — we keep inline-image bytes
 * inside the row so:
 *   • the inbox dialog renders without an extra storage round-trip; and
 *   • we don't have to expose a public S3 path for unauthenticated email
 *     content (SSRF / hot-linking surface).
 *
 * Caps below keep DB rows small. Anything larger is dropped (the body still
 * shows the raw `[cid:xxx]` token, which the frontend renders as a chip).
 */
export interface InboxAttachment {
  cid: string;
  filename: string;
  contentType: string;
  url: string;
}
const MAX_INLINE_IMAGES = 10;
// 1 MB per image. Real candidate signature banners (Outlook/Gmail marketing
// templates with photo + logos) routinely run 300–800 KB; 200 KB caused real
// inbound replies to silently drop their signature images. Worst-case row
// payload is bounded by MAX_RFC822_BYTES (5 MB) so this stays DoS-safe.
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
/**
 * Hard cap on the raw RFC822 size we hand to mailparser. mailparser parses
 * the entire message into memory before our per-attachment caps can kick in,
 * so without this an attacker could DoS the worker by POSTing a multi-MB
 * SES "Received" payload. 5 MB comfortably fits real candidate replies
 * (signature logos, screenshots) while bounding peak parser memory.
 */
const MAX_RFC822_BYTES = 5 * 1024 * 1024;

const router: IRouter = Router();

// SendGrid Inbound Parse posts as multipart/form-data (with attachments).
// Use memory storage with bounded limits — emails routinely include
// signature images and small screenshots, but we don't want a large upload
// to chew through the worker's heap before mailparser even sees it.
// Limits here align with MAX_RFC822_BYTES so the SES JSON path and the
// SendGrid multipart path have comparable ceilings.
// Multer limits intentionally mirror the inline-image caps below so an
// unauthenticated multipart request cannot pin much more memory than a single
// valid SendGrid Inbound Parse delivery would. (Auth is also enforced before
// multer runs — see `requireInboundSecret` mounted ahead of this middleware.)
const inboundUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024,        // 1 MB per attachment (matches MAX_INLINE_IMAGE_BYTES below)
    files: 10,                    // matches MAX_INLINE_IMAGES below
    fieldSize: 2 * 1024 * 1024,   // up to 2 MB per text field (HTML body can be large)
    fields: 30,                   // SendGrid sends ~16 fields; cap to a sane upper bound
    parts: 50,                    // total fields + files
  },
});

const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET || "";

/** Constant-time string equality. Hashing both sides first equalizes lengths
 * (crypto.timingSafeEqual throws on length mismatch) and ensures the
 * comparison time never depends on how many leading characters match, so an
 * attacker can't recover INBOUND_EMAIL_SECRET via a timing side-channel. */
function secretEquals(provided: string, secret: string): boolean {
  if (!provided || !secret) return false;
  const a = nodeCryptoForSns.createHash("sha256").update(provided).digest();
  const b = nodeCryptoForSns.createHash("sha256").update(secret).digest();
  return nodeCryptoForSns.timingSafeEqual(a, b);
}

/** Reject unless caller supplies the shared secret via header or ?secret=. */
function authorize(req: any): boolean {
  if (!INBOUND_SECRET) return false;  // fail-closed when secret not configured
  const header = (req.header("x-webhook-secret") || "").trim();
  const query = ((req.query?.secret as string) || "").trim();
  return secretEquals(header, INBOUND_SECRET) || secretEquals(query, INBOUND_SECRET);
}

/**
 * Express middleware that enforces the inbound shared-secret BEFORE multer
 * parses any multipart body. Without this, an unauthenticated caller could
 * send a multi-megabyte multipart payload and force the server to materialize
 * every part into memory before being rejected — a cheap DoS lever.
 */
function requireInboundSecret(req: any, res: any, next: any): void {
  if (authorize(req)) { next(); return; }
  logger.warn({ ip: req.ip, ua: req.header("user-agent") }, "[inbound-email] Unauthorized request rejected");
  res.status(401).json({ error: "Unauthorized — set INBOUND_EMAIL_SECRET and pass it via 'X-Webhook-Secret' header or '?secret=' query param" });
}

/** Allow only AWS SNS confirm URLs to be fetched (prevents SSRF). */
function isSafeSnsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(u.hostname);
  } catch { return false; }
}

/* ── SNS message signature verification ─────────────────────────────────────
   AWS SNS signs every Notification / SubscriptionConfirmation. Without
   verifying the signature anyone with our INBOUND_EMAIL_SECRET (which we
   accept via header *or* query string for proxy convenience) could forge
   payloads and mass-flip do_not_contact. Verification reproduces the AWS
   canonical-string format and validates SHA1/SHA256 over the SigningCertURL's
   public key. We additionally enforce a TopicArn allowlist.

   We cache fetched signing certs for 6h. */
const SNS_TOPIC_ALLOWLIST = (process.env.SES_SNS_TOPIC_ARNS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const _snsCertCache = new Map<string, { pem: string; ts: number }>();

function isSafeSnsCertUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:"
      && /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(u.hostname)
      && /\.pem$/i.test(u.pathname);
  } catch { return false; }
}

async function fetchSnsCert(url: string): Promise<string | null> {
  if (!isSafeSnsCertUrl(url)) return null;
  const cached = _snsCertCache.get(url);
  if (cached && Date.now() - cached.ts < 6 * 3600_000) return cached.pem;
  try {
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) return null;
    const pem = await r.text();
    _snsCertCache.set(url, { pem, ts: Date.now() });
    return pem;
  } catch { return null; }
}

function buildSnsCanonicalString(payload: any): string | null {
  const t = payload?.Type;
  if (t === "Notification") {
    const fields: [string, any][] = [
      ["Message", payload.Message],
      ["MessageId", payload.MessageId],
    ];
    if (payload.Subject !== undefined && payload.Subject !== null) fields.push(["Subject", payload.Subject]);
    fields.push(["Timestamp", payload.Timestamp], ["TopicArn", payload.TopicArn], ["Type", payload.Type]);
    return fields.map(([k, v]) => `${k}\n${v}\n`).join("");
  }
  if (t === "SubscriptionConfirmation" || t === "UnsubscribeConfirmation") {
    return [
      ["Message", payload.Message],
      ["MessageId", payload.MessageId],
      ["SubscribeURL", payload.SubscribeURL],
      ["Timestamp", payload.Timestamp],
      ["Token", payload.Token],
      ["TopicArn", payload.TopicArn],
      ["Type", payload.Type],
    ].map(([k, v]) => `${k}\n${v}\n`).join("");
  }
  return null;
}

async function verifySnsMessage(payload: any): Promise<boolean> {
  if (!payload || typeof payload !== "object") return false;
  /* In production the TopicArn allowlist is mandatory — without it any
     validly-signed SNS message from any AWS topic could mass-flip DNC if
     the shared secret leaked. We fail closed. */
  if (process.env.NODE_ENV === "production" && SNS_TOPIC_ALLOWLIST.length === 0) {
    logger.error("[ses-events] SES_SNS_TOPIC_ARNS not configured in production — refusing all events");
    return false;
  }
  if (SNS_TOPIC_ALLOWLIST.length > 0
      && !SNS_TOPIC_ALLOWLIST.includes(String(payload.TopicArn || ""))) {
    return false;
  }
  const canonical = buildSnsCanonicalString(payload);
  if (!canonical) return false;
  const sig = String(payload.Signature || "");
  const certUrl = String(payload.SigningCertURL || "");
  if (!sig || !certUrl) return false;
  const pem = await fetchSnsCert(certUrl);
  if (!pem) return false;
  const algo = payload.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  try {
    const verifier = nodeCryptoForSns.createVerify(algo);
    verifier.update(canonical, "utf8");
    return verifier.verify(pem, sig, "base64");
  } catch { return false; }
}

type ParsedReply = {
  fromEmail: string;
  subject?: string;
  body: string;
  attachments?: InboxAttachment[];
};

function extractFromEmail(rawFrom: string): string {
  const m = rawFrom.match(/<([^>]+)>/);
  const email = (m ? m[1] : rawFrom).trim().toLowerCase();
  return email;
}

/** Strip surrounding "<...>" from a Content-ID and lowercase for matching. */
function normalizeCid(cid: string | undefined | null): string {
  if (!cid) return "";
  return cid.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

/**
 * Convert mailparser Attachments → InboxAttachment[]:
 *   • image/* only (signatures, screenshots);
 *   • must have a Content-ID (so we can match `[cid:xxx]` tokens in the body);
 *   • cap MAX_INLINE_IMAGES total, MAX_INLINE_IMAGE_BYTES each.
 *
 * Anything that fails the gate is skipped silently — the body still has the
 * raw token, and the frontend renders a "📎 inline image" chip as a fallback.
 */
function attachmentsFromParsed(parsed: ParsedMail): InboxAttachment[] {
  const out: InboxAttachment[] = [];
  const skipped: Array<{ reason: string; contentType?: string; cid?: string; size?: number; filename?: string }> = [];
  for (const a of parsed.attachments || []) {
    if (out.length >= MAX_INLINE_IMAGES) {
      skipped.push({ reason: "max-images-reached", contentType: a.contentType, cid: a.cid, filename: a.filename });
      continue;
    }
    const ct = (a.contentType || "").toLowerCase();
    const cid = normalizeCid(a.cid);
    const buf = a.content as Buffer | undefined;
    const size = Buffer.isBuffer(buf) ? buf.length : 0;
    if (!ct.startsWith("image/")) {
      skipped.push({ reason: "not-image", contentType: ct, cid, size, filename: a.filename });
      continue;
    }
    if (!cid) {
      skipped.push({ reason: "no-cid", contentType: ct, size, filename: a.filename });
      continue;
    }
    if (!buf || !Buffer.isBuffer(buf)) {
      skipped.push({ reason: "no-buffer", contentType: ct, cid, filename: a.filename });
      continue;
    }
    if (size === 0) {
      skipped.push({ reason: "empty", contentType: ct, cid, filename: a.filename });
      continue;
    }
    if (size > MAX_INLINE_IMAGE_BYTES) {
      skipped.push({ reason: "too-large", contentType: ct, cid, size, filename: a.filename });
      continue;
    }
    out.push({
      cid,
      filename: a.filename || `${cid}.${ct.split("/")[1] || "bin"}`,
      contentType: ct,
      url: `data:${ct};base64,${buf.toString("base64")}`,
    });
  }
  if (skipped.length > 0) {
    logger.warn(
      { skipped, kept: out.length, max: MAX_INLINE_IMAGES, maxBytes: MAX_INLINE_IMAGE_BYTES },
      "[inbound-email] dropped one or more attachments",
    );
  }
  return out;
}

/**
 * Strip a quoted reply chain ("On <date>, X wrote:" / leading ">" lines) so
 * the recruiter sees only the candidate's actual reply, not the whole prior
 * conversation. Mirrors the heuristic the old regex extractor used.
 */
function trimQuotedReply(body: string): string {
  const quoteIdx = body.search(/(?:^|\n)\s*(?:>+\s*|On .+? wrote:)/);
  if (quoteIdx > 30) return body.slice(0, quoteIdx).trim();
  return body.trim();
}

/**
 * Convert HTML to a recruiter-friendly plain string while *preserving*
 * `[cid:xxx]` tokens for inline images so the inbox dialog can substitute
 * them with `<img src="data:...">`. CID tokens are normalised here to match
 * `normalizeCid()` (strip `<>`, lowercase) so the renderer's lookup map
 * always hits — this matters for senders that emit bracketed/uppercase
 * Content-IDs like `<ABCD@example.com>`.
 */
function htmlToBodyWithCidTokens(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Replace <img src="cid:xxx"> with the [cid:xxx] token the inbox
    // renderer recognises. Lowercase + strip <> on the captured CID so
    // it matches the normalised value stored on each attachment.
    .replace(/<img[^>]*\bsrc=["']cid:([^"']+)["'][^>]*>/gi, (_, raw: string) => {
      return `[cid:${normalizeCid(raw)}]`;
    })
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Parse a raw RFC822 message with mailparser and return the candidate-visible
 * body plus any inline image attachments small enough to inline.
 *
 * Body selection rule: real candidate emails are usually
 * multipart/alternative + multipart/related where the text/plain part
 * *omits* inline-image references that only exist in the HTML part. So if
 * we have *any* inline attachment AND we have an HTML body, we derive the
 * body from HTML so the `[cid:xxx]` tokens survive. Otherwise we fall back
 * to the cleaner text/plain part. Without this, attachments would be stored
 * but the renderer would have nothing to substitute and the image would
 * silently disappear.
 */
async function parseRfc822WithAttachments(
  raw: string | Buffer,
): Promise<{ body: string; attachments: InboxAttachment[] }> {
  const parsed = await simpleParser(raw, { skipImageLinks: true });

  // DEBUG: structural details of every parsed attachment so we can diagnose
  // why mailparser sometimes returns zero attachments for emails whose HTML
  // clearly contained <img src="cid:..."> references. Deliberately PII-free:
  // no filenames (often contain candidate names) and no raw MIME headers —
  // only content-free structure (type / cid presence / size / disposition).
  const allAttachmentsDebug = (parsed.attachments || []).map((a: ParsedAttachment) => ({
    contentType: a.contentType,
    hasCid: !!a.cid,
    size: Buffer.isBuffer(a.content) ? a.content.length : null,
    contentDisposition: a.contentDisposition,
  }));
  const htmlLen = typeof parsed.html === "string" ? parsed.html.length : 0;
  const textLen = typeof parsed.text === "string" ? parsed.text.length : 0;
  const cidTokensInHtml = typeof parsed.html === "string"
    ? (parsed.html.match(/src=["']cid:[^"']+["']/gi) || []).length
    : 0;
  logger.info(
    {
      rawBytes: Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw)),
      attachmentCount: (parsed.attachments || []).length,
      attachments: allAttachmentsDebug,
      htmlLen,
      textLen,
      cidTokensInHtml,
    },
    "[inbound-email][debug] mailparser result",
  );
  // Attachment-parse failure diagnostics: mailparser returned zero attachments
  // but the HTML clearly references CIDs. We deliberately do NOT persist the
  // raw email anywhere (it contains candidate PII / possibly resumes — a GDPR
  // erasure blind spot and unbounded /tmp growth). Instead, log content-free
  // forensics: sizes, counts, sender DOMAIN only, and a SHA-256 of the raw
  // bytes so a copy supplied later by the provider can be positively matched.
  if ((parsed.attachments || []).length === 0 && cidTokensInHtml > 0) {
    const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const senderAddress = parsed.from?.value?.[0]?.address ?? "";
    const senderDomain = senderAddress.includes("@") ? senderAddress.split("@").pop() : null;
    logger.warn(
      {
        cidTokensInHtml,
        rawBytes: rawBuf.length,
        rawSha256: nodeCryptoForSns.createHash("sha256").update(rawBuf).digest("hex"),
        senderDomain,
        htmlLen,
        textLen,
      },
      "[inbound-email][debug] CID-referenced attachments missing from parse (raw email intentionally not persisted)",
    );
  }

  const attachments = attachmentsFromParsed(parsed);
  const hasInlineImages = attachments.length > 0;

  let body = "";
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = parsed.text && parsed.text.trim().length > 0 ? parsed.text : "";

  if (hasInlineImages && html) {
    body = htmlToBodyWithCidTokens(html);
  } else if (text) {
    body = text;
  } else if (html) {
    body = htmlToBodyWithCidTokens(html);
  }

  return {
    body: trimQuotedReply(body),
    attachments,
  };
}

function decodeRfc822Content(s: string): Buffer {
  // SES "Received" notifications base64-encode the raw RFC822 message in
  // payload.content. Some test harnesses pass the raw message directly.
  // Probe the first few bytes after base64-decode: a valid email starts with
  // a header line, so a successful decode that yields ASCII text is good.
  try {
    const buf = Buffer.from(s, "base64");
    const head = buf.slice(0, 64).toString("utf8");
    if (/^[\x20-\x7E\r\n]+$/.test(head) && /:/.test(head)) return buf;
  } catch { /* fall through */ }
  return Buffer.from(s, "utf8");
}

async function parseInboundPayload(
  payload: any,
  files?: Express.Multer.File[],
): Promise<ParsedReply | null> {
  // Shape 0 — SendGrid Inbound Parse (multipart/form-data).
  //
  // SendGrid pre-parses the email and posts each part as a multipart field:
  //   • `from`, `to`, `subject`, `html`, `text`              — string fields
  //   • `attachments`                                         — count (string)
  //   • `attachment-info`  — JSON: { attachment1: { type, filename, content-id } }
  //   • `content-ids`      — JSON: { <cid>: <fieldname> }
  //   • `attachment1`, `attachment2`, …                       — actual file bytes
  //
  // The image bytes live in `req.files`, NOT in the JSON payload, so without
  // this branch our parser sees `attachments: "1"` (a string!) and silently
  // drops the inline signature image — even though every CID reference is
  // intact in the HTML body.
  if (
    payload?.from &&
    typeof payload?.html === "string" &&
    (typeof payload?.["content-ids"] === "string" ||
      typeof payload?.["attachment-info"] === "string")
  ) {
    const fromHeader = String(payload.from);
    const subject = payload.subject ? String(payload.subject) : undefined;
    const html = String(payload.html || "");
    const text = typeof payload.text === "string" ? payload.text : "";

    let cidMap: Record<string, string> = {};
    try { cidMap = JSON.parse(String(payload["content-ids"] || "{}")); } catch { /* ignore */ }
    let infoMap: Record<string, { filename?: string; name?: string; type?: string; "content-id"?: string }> = {};
    try { infoMap = JSON.parse(String(payload["attachment-info"] || "{}")); } catch { /* ignore */ }

    const filesByField = new Map<string, Express.Multer.File>();
    for (const f of files || []) filesByField.set(f.fieldname, f);

    // Build the (cid → fieldname) iteration set. SendGrid usually sends
    // `content-ids` for inline images, but some tenants disable that field.
    // Fall back to the per-attachment `attachment-info[*]["content-id"]`
    // entries so inline images don't silently disappear in those payloads.
    const cidEntries: Array<[string, string]> = [];
    if (Object.keys(cidMap).length > 0) {
      for (const [cid, fieldname] of Object.entries(cidMap)) {
        cidEntries.push([String(cid), String(fieldname)]);
      }
    } else {
      for (const [fieldname, info] of Object.entries(infoMap)) {
        const cid = info?.["content-id"];
        if (cid) cidEntries.push([String(cid), fieldname]);
      }
    }

    const attachments: InboxAttachment[] = [];
    const skipped: Array<{ reason: string; fieldname?: string; cid?: string; size?: number; type?: string }> = [];
    for (const [cidRaw, fieldname] of cidEntries) {
      if (attachments.length >= MAX_INLINE_IMAGES) {
        skipped.push({ reason: "max-images-reached", fieldname, cid: cidRaw });
        continue;
      }
      const file = filesByField.get(fieldname);
      if (!file) {
        skipped.push({ reason: "no-file", fieldname, cid: cidRaw });
        continue;
      }
      const ct = (file.mimetype || infoMap[fieldname]?.type || "").toLowerCase();
      if (!ct.startsWith("image/")) {
        skipped.push({ reason: "not-image", fieldname, cid: cidRaw, type: ct });
        continue;
      }
      const cid = normalizeCid(cidRaw);
      if (!cid) {
        skipped.push({ reason: "no-cid", fieldname, type: ct });
        continue;
      }
      const buf = file.buffer;
      const size = Buffer.isBuffer(buf) ? buf.length : 0;
      if (!buf || size === 0) {
        skipped.push({ reason: "empty", fieldname, cid, type: ct });
        continue;
      }
      if (size > MAX_INLINE_IMAGE_BYTES) {
        skipped.push({ reason: "too-large", fieldname, cid, size, type: ct });
        continue;
      }
      attachments.push({
        cid,
        filename: file.originalname || infoMap[fieldname]?.filename || `${cid}.${ct.split("/")[1] || "bin"}`,
        contentType: ct,
        url: `data:${ct};base64,${buf.toString("base64")}`,
      });
    }
    if (skipped.length > 0) {
      logger.warn(
        { skipped, kept: attachments.length, max: MAX_INLINE_IMAGES, maxBytes: MAX_INLINE_IMAGE_BYTES },
        "[inbound-email][sendgrid] dropped one or more attachments",
      );
    }
    logger.info(
      {
        cidCount: Object.keys(cidMap).length,
        fileCount: (files || []).length,
        kept: attachments.length,
      },
      "[inbound-email][sendgrid] parsed",
    );

    let body = "";
    if (attachments.length > 0 && html) body = htmlToBodyWithCidTokens(html);
    else if (text && text.trim().length > 0) body = text;
    else if (html) body = htmlToBodyWithCidTokens(html);

    return {
      fromEmail: extractFromEmail(fromHeader),
      subject,
      body: trimQuotedReply(body),
      attachments,
    };
  }

  // Shape 1 — generic JSON: { from, subject, body|text }
  if (payload?.from && (payload?.body || payload?.text)) {
    return {
      fromEmail: extractFromEmail(String(payload.from)),
      subject: payload.subject ? String(payload.subject) : undefined,
      body: String(payload.body || payload.text || ""),
    };
  }
  // Shape 2 — SES "Received" notification (delivered via SNS)
  if (payload?.notificationType === "Received" || payload?.mail) {
    const mail = payload.mail || {};
    const ch = mail.commonHeaders || {};
    const fromArr: string[] = ch.from || [];
    const fromHeader = fromArr[0] || mail.source || "";
    if (!fromHeader) return null;
    const subject = ch.subject as string | undefined;
    let body = "";
    let attachments: InboxAttachment[] = [];
    if (payload.content) {
      try {
        const buf = decodeRfc822Content(String(payload.content));
        // Hard guard before mailparser — it parses everything into memory
        // before our per-attachment caps can kick in. Reject early on
        // oversized payloads so a single inbound email cannot OOM the
        // worker. We still 200-OK the webhook (no body) so SES/SNS will
        // not retry forever; the recruiter just sees the empty preview.
        if (buf.length > MAX_RFC822_BYTES) {
          logger.warn(
            { rfc822Bytes: buf.length, max: MAX_RFC822_BYTES },
            "[inbound-email] RFC822 content exceeds max size — skipping MIME parse",
          );
          body = "";
        } else {
          const out = await parseRfc822WithAttachments(buf);
          body = out.body;
          attachments = out.attachments;
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, "[inbound-email] RFC822 parse failed — falling back to raw content");
        body = String(payload.content);
      }
    }
    return { fromEmail: extractFromEmail(fromHeader), subject, body, attachments };
  }
  return null;
}

/**
 * Inbound email webhook.
 *
 * Accepts:
 *   • SNS subscription confirmation — auto-confirms by GETting SubscribeURL.
 *   • SNS notification              — unwraps and routes the inner Message.
 *   • SES "Received" notification   — parses raw RFC822 content.
 *   • Generic JSON {from, subject, body|text} — for Postmark/Mailgun/SendGrid
 *     Inbound Parse, or simple curl tests.
 *
 * Pipeline:
 *   1. Identify candidate by sender email (sourced_candidates → candidates).
 *   2. Find the most recent active outreach enrollment for that candidate.
 *   3. Run AI classifyReply → advance stage / DNC / inbox entry.
 */
/**
 * SES Bounce / Complaint webhook (delivered via SNS).
 *
 * When SES detects a hard bounce or a recipient marks our mail as spam, AWS
 * SNS posts a JSON notification here. We flip `do_not_contact` on the matching
 * candidate row so no future scheduler / autopilot ever re-mails them. We
 * keep the row (auditable) but tag the reason so support can investigate.
 *
 * Path is shared-secret protected (same INBOUND_EMAIL_SECRET) and SNS
 * SubscriptionConfirmation is auto-confirmed via the SSRF-guarded helper.
 *
 * Payload shapes handled:
 *   • notificationType="Bounce"     → bounce.bouncedRecipients[].emailAddress
 *   • notificationType="Complaint"  → complaint.complainedRecipients[].emailAddress
 */
/* No zod schema on this route by design. The payload is an AWS SNS
 * envelope whose shape is owned by AWS and varies per notification type
 * (Bounce / Complaint / SubscriptionConfirmation). The authenticity
 * guard is the SNS signature verification below (defense-in-depth on top
 * of `requireInboundSecret`), not a body-shape allowlist. Adding a strict
 * schema here would only block legitimate AWS payloads when AWS evolves
 * the envelope. The body is parsed defensively before use. */
router.post("/webhooks/ses-events", requireInboundSecret, async (req, res) => {
  try {
    const envelope: any = req.body || {};

    /* Hard requirement: every SNS-wrapped payload must carry a valid AWS
       signature. This blocks payload-spoofing even when the shared secret
       leaks (defense in depth). Non-SNS payloads are rejected by DEFAULT
       (fail-safe) — a server that forgets to set NODE_ENV=production must
       NOT silently inherit an unauthenticated bypass. Local curl testing
       with raw JSON requires the explicit opt-in ALLOW_UNSIGNED_SES_EVENTS=true
       (never set this on a real server). */
    if (envelope?.Type === "SubscriptionConfirmation"
        || envelope?.Type === "Notification"
        || envelope?.Type === "UnsubscribeConfirmation") {
      const ok = await verifySnsMessage(envelope);
      if (!ok) {
        logger.warn({ topic: envelope.TopicArn, msgId: envelope.MessageId }, "[ses-events] SNS signature verification failed");
        res.status(403).json({ error: "sns_signature_invalid" }); return;
      }
    } else if (process.env.ALLOW_UNSIGNED_SES_EVENTS !== "true") {
      /* Anything that isn't a real SNS envelope is refused unless the
         dev-only escape hatch is explicitly enabled. */
      res.status(400).json({ error: "expected_sns_envelope" }); return;
    }

    let payload: any = envelope;

    /* SNS handshake. */
    if (payload?.Type === "SubscriptionConfirmation" && payload?.SubscribeURL) {
      if (!isSafeSnsUrl(payload.SubscribeURL)) {
        res.status(400).json({ error: "Invalid SubscribeURL host" }); return;
      }
      try { await fetch(payload.SubscribeURL, { method: "GET" }); } catch (err: any) {
        logger.error({ err: err.message }, "[ses-events] SNS confirm failed");
      }
      res.status(200).json({ ok: true, confirmed: true }); return;
    }
    if (payload?.Type === "Notification" && typeof payload?.Message === "string") {
      try { payload = JSON.parse(payload.Message); } catch { /* keep raw */ }
    }

    const kind: "Bounce" | "Complaint" | null =
      payload?.notificationType === "Bounce" ? "Bounce" :
      payload?.notificationType === "Complaint" ? "Complaint" : null;
    if (!kind) {
      res.status(400).json({ error: "Expected notificationType=Bounce|Complaint" }); return;
    }

    /* Hard-bounces only — soft bounces (e.g. "MailboxFull") will retry.
       Also dedupe + cap recipients per request (defense-in-depth blast-radius
       limit even if a valid SNS event ever names thousands of recipients). */
    const MAX_RECIPIENTS_PER_EVENT = 100;
    const rawRecipients: { emailAddress?: string }[] =
      kind === "Bounce"
        ? (payload.bounce?.bounceType === "Permanent" ? (payload.bounce?.bouncedRecipients ?? []) : [])
        : (payload.complaint?.complainedRecipients ?? []);
    const seen = new Set<string>();
    const recipients = rawRecipients.filter(r => {
      const e = (r.emailAddress || "").trim().toLowerCase();
      if (!e || seen.has(e)) return false;
      seen.add(e); return true;
    }).slice(0, MAX_RECIPIENTS_PER_EVENT);

    const reason = kind === "Bounce"
      ? `bounce:${payload.bounce?.bounceSubType ?? "Permanent"}`
      : `complaint:${payload.complaint?.complaintFeedbackType ?? "abuse"}`;

    let updated = 0;
    for (const r of recipients) {
      const email = (r.emailAddress || "").trim().toLowerCase();
      if (!email) continue;
      const result = await db.update(candidatesTable)
        .set({
          doNotContact: true,
          dncAt: new Date(),
          dncReason: reason,
          dncSetBy: "ses_webhook",
          updatedAt: new Date(),
        } as any)
        .where(and(
          sql`lower(${candidatesTable.email}) = ${email}`,
          eq(candidatesTable.doNotContact, false),
        ))
        .returning({ id: candidatesTable.id });
      updated += result.length;

      /* Audit logging must never fail the SES processing path — SNS will
         retry forever on any non-2xx response, so we swallow audit errors. */
      void recordAudit({
        actorType: "system",
        actorId: "ses-webhook",
        actorLabel: "SES Webhook",
        subjectType: "candidate",
        subjectId: result[0]?.id ?? email,
        subjectLabel: email,
        channel: "email",
        direction: "inbound",
        action: kind === "Bounce" ? "email.bounced" : "email.complaint",
        status: "ok",
        metadata: { reason, recipient: email },
      } as any).catch(() => {});
    }

    logger.info({ kind, recipients: recipients.length, updated }, "[ses-events] processed");
    res.status(200).json({ ok: true, kind, recipients: recipients.length, updated });
  } catch (err: any) {
    logger.error({ err: err.message }, "[ses-events] handler failed");
    res.status(500).json({ error: err.message });
  }
});

/* No zod schema: this endpoint accepts the full SendGrid Inbound Parse
 * multipart envelope OR a raw MIME body, whichever the upstream provider
 * sent. Field names are provider-specific (`from`, `to`, `headers`,
 * `attachments[]`, etc.). Authenticity is enforced by
 * `requireInboundSecret`; the parser tolerates missing fields. */
router.post("/webhooks/inbound-email", requireInboundSecret, inboundUpload.any(), async (req, res) => {
  try {
    let payload: any = req.body || {};

    // SNS subscription confirmation — confirm by hitting SubscribeURL.
    // Validate the URL points at an actual AWS SNS endpoint to avoid SSRF.
    if (payload?.Type === "SubscriptionConfirmation" && payload?.SubscribeURL) {
      if (!isSafeSnsUrl(payload.SubscribeURL)) {
        logger.warn({ url: payload.SubscribeURL }, "[inbound-email] Rejected SubscribeURL — not an AWS SNS host");
        res.status(400).json({ error: "SubscribeURL must be an https://sns.<region>.amazonaws.com host" });
        return;
      }
      logger.info({ topicArn: payload.TopicArn }, "[inbound-email] Confirming SNS subscription");
      try {
        const r = await fetch(payload.SubscribeURL, { method: "GET" });
        logger.info({ status: r.status }, "[inbound-email] SNS subscription confirmed");
      } catch (err: any) {
        logger.error({ err: err.message }, "[inbound-email] SNS confirm failed");
      }
      res.status(200).json({ ok: true, confirmed: true });
      return;
    }

    // SNS Notification wrapper — unwrap Message
    if (payload?.Type === "Notification" && typeof payload?.Message === "string") {
      try { payload = JSON.parse(payload.Message); } catch { /* keep raw */ }
    }

    const reqFiles = Array.isArray((req as any).files) ? ((req as any).files as Express.Multer.File[]) : [];
    const parsed = await parseInboundPayload(payload, reqFiles);
    if (!parsed) {
      logger.warn({ payloadShape: Object.keys(payload || {}) }, "[inbound-email] Unrecognised payload shape");
      res.status(400).json({ error: "Unrecognised payload — expected {from, body} or SES/SNS notification" });
      return;
    }

    const { fromEmail, subject, body } = parsed;
    const attachments = parsed.attachments ?? [];
    if (!body || body.length < 2) {
      res.status(400).json({ error: "Empty reply body" });
      return;
    }

    logger.info(
      { fromEmail, subject, bodyLen: body.length, inlineImageCount: attachments.length },
      "[inbound-email] Reply received",
    );

    // Find candidate by email — check both candidates and sourced_candidates
    const [normalized] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.email, fromEmail)).limit(1);
    // sourced_candidates.email lives inside raw_data JSON — match case-insensitively
    const sourcedRows = await db.select().from(sourcedCandidatesTable)
      .where(sql`lower(${sourcedCandidatesTable.rawData}->>'email') = ${fromEmail}`)
      .orderBy(desc(sourcedCandidatesTable.createdAt));

    if (!normalized && sourcedRows.length === 0) {
      logger.warn({ fromEmail }, "[inbound-email] No matching candidate");
      res.status(202).json({ ok: false, reason: "no_candidate_match", fromEmail });
      return;
    }

    // Build the set of candidate IDs to look up enrollments for
    const candidateIds: string[] = [];
    if (normalized) candidateIds.push(normalized.id);
    for (const sc of sourcedRows) {
      candidateIds.push(sc.id);
      if (sc.normalizedCandidateId) candidateIds.push(sc.normalizedCandidateId);
    }

    // ── Path A: campaign-driven outreach (has enrollment) — full classifier ────
    // "replied" is intentionally included so that follow-up emails from the
    // same candidate (second/third replies) still route through the full
    // campaign classifier and appear in the recruiter inbox.
    const [enrollment] = await db.select().from(outreachEnrollmentsTable)
      .where(and(
        inArray(outreachEnrollmentsTable.candidateId, candidateIds),
        or(
          eq(outreachEnrollmentsTable.status, "active"),
          eq(outreachEnrollmentsTable.status, "pending"),
          eq(outreachEnrollmentsTable.status, "completed"),
          eq(outreachEnrollmentsTable.status, "replied"),
        ),
      ))
      .orderBy(desc(outreachEnrollmentsTable.id))
      .limit(1);

    if (enrollment) {
      const [latestMsg] = await db.select().from(outreachMessagesTable)
        .where(and(
          inArray(outreachMessagesTable.candidateId, candidateIds),
          eq(outreachMessagesTable.status, "sent"),
        ))
        .orderBy(desc(outreachMessagesTable.sentAt))
        .limit(1);

      const result = await classifyReply({
        campaignId: enrollment.campaignId,
        enrollmentId: enrollment.id,
        messageId: latestMsg?.id,
        replyBody: body,
        replyAttachments: attachments,
      });

      logger.info({
        fromEmail, path: "campaign", enrollmentId: enrollment.id,
        classification: result.classification, sentiment: result.sentiment,
      }, "[inbound-email] Reply classified");

      // ── Connection Engine: record replied_to_message signal ───────────────
      if (normalized?.id) {
        try {
          const { recordCandidateConnectionEvent, recalculateCandidateInsights } =
            await import("../lib/candidateConnectionEngine.js");
          await recordCandidateConnectionEvent({
            candidateId: normalized.id,
            eventType: "replied_to_message",
            jobId: enrollment.jobId ?? null,
          });
          await recalculateCandidateInsights(normalized.id, enrollment.jobId ?? null);
        } catch (err: any) {
          logger.error({ err: err?.message }, "[inbound-email] Connection Engine update failed (Path A)");
        }
        try {
          const { recordConnectionEvent, recalculateConnectionScore } =
            await import("../lib/connectionEngine.js");
          await recordConnectionEvent({
            candidateId: normalized.id,
            eventType: "replied_to_outreach",
            jobId: enrollment.jobId ?? null,
            employerId: enrollment.tenantId ?? null,
          });
          // +10 if candidate replied within 24 h of last outreach send
          if (latestMsg?.sentAt) {
            const hoursElapsed = (Date.now() - new Date(latestMsg.sentAt).getTime()) / 36e5;
            if (hoursElapsed <= 24) {
              await recordConnectionEvent({
                candidateId: normalized.id,
                eventType: "response_within_24h",
                jobId: enrollment.jobId ?? null,
                employerId: enrollment.tenantId ?? null,
              });
            }
          }
          // +15 if candidate expressed interest (accepted the intro)
          if (result.classification === "interested") {
            await recordConnectionEvent({
              candidateId: normalized.id,
              eventType: "accepted_intro",
              jobId: enrollment.jobId ?? null,
              employerId: enrollment.tenantId ?? null,
            });
          }
          await recalculateConnectionScore(normalized.id, enrollment.jobId ?? null, enrollment.tenantId ?? null);
        } catch (err: any) {
          logger.error({ err: err?.message }, "[inbound-email] Employer Connection Engine update failed (Path A)");
        }
      }

      res.status(200).json({
        ok: true, path: "campaign", fromEmail, enrollmentId: enrollment.id,
        classification: result.classification, sentiment: result.sentiment,
      });
      return;
    }

    // ── Path B: card-action outreach (no enrollment) — fall back to log_reply ──
    // This covers the "Send Outreach" card-action flow which writes directly to
    // outreach_messages without creating a campaign enrollment.
    const msgs = await db.select().from(outreachMessagesTable)
      .where(inArray(outreachMessagesTable.candidateId, candidateIds))
      .orderBy(desc(outreachMessagesTable.createdAt))
      .limit(1);

    if (msgs.length === 0) {
      logger.warn({ fromEmail, candidateIds }, "[inbound-email] No outreach history for candidate");
      res.status(202).json({ ok: false, reason: "no_outreach_history", fromEmail });
      return;
    }

    // Quick AI classification (without enrollment) — call OpenAI directly
    const { generateJSON } = await import("../lib/ai.js");
    const ALLOWED_CLS = ["interested","not_interested","referral","question","reengagement","out_of_office","unsubscribe"] as const;
    const ALLOWED_SENT = ["positive","negative","neutral","out_of_office"] as const;
    type Cls = { classification: typeof ALLOWED_CLS[number]; sentiment: typeof ALLOWED_SENT[number] };
    const ai = await generateJSON<Cls>(
      body.slice(0, 4000),
      `Classify this email reply from a job candidate.
You MUST pick exactly one classification from this list — do NOT invent new categories:
- "interested" — wants to learn more about THIS specific role, agreeing, acknowledging positively (e.g. "Yes", "Sure", "Acknowledged", "Sounds good", "Tell me more", "I'm in")
- "not_interested" — politely or firmly declining
- "referral" — suggesting someone else
- "question" — asking a specific question about THIS role that needs an answer before they can decide
- "reengagement" — replying to an old outreach saying they are now actively job-hunting and asking what roles you have for them generally (e.g. "I'm looking for a new job, do you have anything that suits me?", "I'm now open to opportunities — what are you working on?", "Do you have anything else available?", "What roles do you have open right now?"). Use this when the candidate is asking us to find them a job rather than responding to the original role.
- "out_of_office" — auto-reply / vacation responder
- "unsubscribe" — asking to stop all emails / opt out
Short positive acknowledgements like "Acknowledged", "Got it", "Sounds good", "Yes please" are ALWAYS "interested".
Return JSON: { "classification": "<one of the seven above>", "sentiment": "positive|negative|neutral|out_of_office" }`,
    );

    // ── Validate the LLM output against the enums. The LLM can hallucinate
    // categories ("acknowledged", "thanks", etc.) which silently break the
    // sentiment-map → no advance, no invite, no recruiter notification.
    let classification: typeof ALLOWED_CLS[number] = (ALLOWED_CLS as readonly string[]).includes(ai?.classification as string)
      ? (ai!.classification as typeof ALLOWED_CLS[number])
      : "question"; // safest neutral fallback
    let sentiment: typeof ALLOWED_SENT[number] = (ALLOWED_SENT as readonly string[]).includes(ai?.sentiment as string)
      ? (ai!.sentiment as typeof ALLOWED_SENT[number])
      : "neutral";

    // ── Heuristic safety net: short bodies that read as a clear positive
    // acknowledgement should be treated as "interested" even if the LLM
    // returned an out-of-spec category like "acknowledged".
    const bodyTrim = body.trim().toLowerCase().replace(/[.!?,]+$/g, "");
    const firstLine = bodyTrim.split(/\r?\n/)[0]?.trim() ?? "";
    const POSITIVE_ACK = new Set([
      "acknowledged", "acknowledge", "ack",
      "yes", "yes please", "yes!", "sure", "sure thing", "sounds good",
      "ok", "okay", "ok!", "okay!", "k",
      "got it", "got it!", "noted", "thanks", "thank you",
      "interested", "i'm interested", "im interested", "i am interested",
      "tell me more", "let's talk", "lets talk", "let's chat", "lets chat",
      "happy to chat", "happy to talk", "i'm in", "im in", "count me in",
    ]);
    const aiClassRaw = (ai?.classification ?? "").toString().toLowerCase();
    if (
      classification === "question" && // i.e. fallback or LLM was uncertain
      (POSITIVE_ACK.has(firstLine) || POSITIVE_ACK.has(bodyTrim) || aiClassRaw === "acknowledged" || aiClassRaw === "ack")
    ) {
      classification = "interested";
      sentiment = "positive";
      logger.info({ fromEmail, firstLine, aiClassRaw }, "[inbound-email] Short positive ack → reclassified as interested");
    }

    // ── Heuristic safety net: re-engagement intent. Catches cases where
    // the LLM mis-labels "do you have anything else for me" as "question"
    // (which would scope the answer to the original — possibly filled —
    // role) instead of "reengagement" (which searches all open jobs).
    const REENGAGE_PATTERNS = [
      /\b(looking|hunting|searching) (for|to find) (a |an |some |another |new )?(new )?(job|role|opportunit|position|gig)/i,
      /\b(open|available) (to|for) (new )?(opportunit|role|job|position|gig)/i,
      /\bdo you (have|got) (anything|any (other|more) )(else|opportunit|role|job|position)/i,
      /\bwhat (roles|jobs|positions|opportunities) (do you|are) (have|open|hiring|available)/i,
      /\b(any|other) (open|available) (roles|jobs|positions)/i,
      /\b(currently|now|just) (looking|exploring|on the market|job[- ]hunting)/i,
      /\bany (suitable )?(roles|jobs|positions) (that )?(suit|fit|match) /i,
      /\bsuit me\b|\bfit me\b|\bsomething (for|that suits) me\b/i,
      /\bback on the (job )?market\b/i,
    ];
    if (
      classification !== "unsubscribe" &&
      classification !== "not_interested" &&
      classification !== "out_of_office" &&
      REENGAGE_PATTERNS.some(re => re.test(body))
    ) {
      if (classification !== "reengagement") {
        logger.info({ fromEmail, was: classification }, "[inbound-email] Re-engagement intent detected → reclassified");
      }
      classification = "reengagement";
      sentiment = "positive";
    }

    // Mirrors Path A (campaign classifier): only "interested" advances toward
    // interview. Questions / OOO / reengagement leave the candidate at their
    // current stage so the right agent (or a human) can respond — never
    // auto-schedule on a non-commit reply.
    const sentimentMap: Record<string, "positive"|"negative"|"do_not_contact"|"hold"> = {
      interested: "positive",
      not_interested: "negative",
      unsubscribe: "do_not_contact",
      referral: "negative",
      question: "hold",
      reengagement: "hold",
      out_of_office: "hold",
    };
    const mapped = sentimentMap[classification];

    // Record the reply on the latest outreach message (always — even on "hold")
    await db.update(outreachMessagesTable).set({
      status: "replied",
      repliedAt: new Date(),
      replySentiment: (mapped === "hold" ? "neutral" : mapped) as any,
      replyBody: body,
    } as any).where(eq(outreachMessagesTable.id, msgs[0].id));

    // Find the sourced row to update stage + jobId for invite flow.
    // Primary: match by sourced_candidates.id in the candidateIds set.
    // Fallback: match by normalizedCandidateId = normalized.id so that candidates
    //   who were added via "Add Candidate" (not sourced) still get their stage updated.
    //   Scope to the outreach jobId when available so multi-job candidates don't collide.
    let [sc] = await db.select().from(sourcedCandidatesTable)
      .where(inArray(sourcedCandidatesTable.id, candidateIds.filter(Boolean)))
      .limit(1);

    if (!sc && normalized?.id) {
      const jobId4sc = (msgs[0] as any).jobId as string | undefined;
      const fbRows = await db.select().from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.normalizedCandidateId, normalized.id))
        .orderBy(desc(sourcedCandidatesTable.createdAt));
      // Prefer the row whose rawData.jobId matches the outreach message's jobId
      sc = (jobId4sc
        ? fbRows.find(r => (r.rawData as any)?.jobId === jobId4sc)
        : undefined) ?? fbRows[0];
    }
    const jobId = (msgs[0] as any).jobId as string | undefined;

    let inviteResult: any = null;
    let nextStage: string | undefined;
    let stageBefore: string | undefined;
    if (sc && jobId) {
      const raw = (sc.rawData as any) || {};
      stageBefore = raw?.stage;
      // "hold" keeps the candidate at their current stage so a human can respond.
      const stageMap: Record<string, string | undefined> = {
        positive: "interview_scheduled",
        negative: "rejected",
        do_not_contact: "rejected",
        hold: undefined,
      };
      nextStage = stageMap[mapped] ?? raw?.stage;

      if (mapped === "positive") {
        try {
          const { sendInterviewInviteFromReply } = await import("../lib/agents/interview-reply");
          inviteResult = await sendInterviewInviteFromReply({ jobId, sourcedId: sc.id, replyBody: body });
        } catch (err: any) {
          inviteResult = { ok: false, error: err?.message || String(err) };
        }
      }

      // ── Conversation Agent: when the candidate is asking a question, draft
      // a reply (and auto-send if the tenant has opted in AND the topic is
      // safe). This closes the silent-recruiter gap where "Tell me more"
      // used to sit unread until a human noticed.
      //
      // Re-engagement Agent: when the candidate is asking us to find them a
      // job ("got anything for me?"), search the tenant's currently active
      // jobs and propose 1-3 matches. Same auto-send/needs_review gate.
      let conversationDraftId: string | null = null;
      if (mapped === "hold" && (classification === "question" || classification === "reengagement")) {
        try {
          // Resolve the recruiter assigned to this job so the reply can be
          // signed in their voice.
          const { jobsTable, usersTable } = await import("@workspace/db");
          const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
          let recruiterName: string | undefined;
          let recruiterEmail: string | undefined;
          if (job?.assignedRecruiterId) {
            const [rec] = await db.select().from(usersTable)
              .where(eq(usersTable.id, job.assignedRecruiterId)).limit(1);
            recruiterName = rec?.name?.split(" ")[0];
            recruiterEmail = rec?.email;
          }
          const candName = normalized
            ? `${normalized.firstName ?? ""} ${normalized.lastName ?? ""}`.trim()
            : (sc as any)?.rawData?.name ?? null;

          if (classification === "reengagement") {
            const { draftReengagementReply } = await import("../lib/agents/outreach-conversation");
            const out = await draftReengagementReply({
              tenantId: (sc as any).tenantId,
              jobId,
              sourcedId: sc.id,
              candidateId: normalized?.id ?? null,
              candidateEmail: fromEmail,
              candidateName: candName,
              inboundBody: body,
              inboundReceivedAt: new Date(),
              recruiterName,
              recruiterEmail,
            });
            conversationDraftId = out.draftId;
            logger.info(
              { sourcedId: sc.id, draftId: out.draftId, verdict: out.verdict, autoSent: out.sent, matched: out.matchedJobIds },
              "[inbound-email] Re-engagement Agent drafted reply",
            );
          } else {
            const { draftReplyToCandidateQuestion } = await import("../lib/agents/outreach-conversation");
            const out = await draftReplyToCandidateQuestion({
              tenantId: (sc as any).tenantId,
              jobId,
              sourcedId: sc.id,
              candidateId: normalized?.id ?? null,
              candidateEmail: fromEmail,
              candidateName: candName,
              inboundBody: body,
              inboundReceivedAt: new Date(),
              recruiterName,
              recruiterEmail,
            });
            conversationDraftId = out.draftId;
            logger.info(
              { sourcedId: sc.id, draftId: out.draftId, verdict: out.verdict, autoSent: out.sent },
              "[inbound-email] Conversation Agent drafted reply",
            );
          }
        } catch (err: any) {
          logger.error({ err: err?.message, sourcedId: sc.id, classification }, "[inbound-email] Reply agent failed");
        }
      }

      const replyRawPatch: Record<string, unknown> = {
        replyStatus: mapped === "hold" ? "neutral" : mapped,
        replyClassification: classification,
        replyLoggedAt: new Date().toISOString(),
        replyBody: body,
        ...(inviteResult?.sessionId
          ? {
              interviewSessionId: inviteResult.sessionId,
              interviewInviteSentAt: new Date().toISOString(),
              interviewInviteEmailOk: !!inviteResult.emailOk,
            }
          : {}),
      };
      const replyCandidateId = sc.normalizedCandidateId ?? normalized?.id ?? null;
      if (replyCandidateId && nextStage) {
        // Inbound reply is a candidate-driven, AI-classified event → system actor.
        // A "hold" that doesn't change the stage folds into the no-op branch of the
        // choke-point (patch applied, no transition trail).
        await changeCandidateStage({
          tenantId: (sc as any).tenantId ?? "",
          candidateId: replyCandidateId,
          jobId,
          to: nextStage,
          from: stageBefore,
          actor: { type: "system", role: null, id: null },
          source: "inbound_email_reply",
          sourcedId: sc.id,
          sourcedRawDataPatch: replyRawPatch,
          metadata: { classification, mapped },
        });
      } else {
        // stage-write-exempt: no canonical candidateId to key the event, or "hold"
        // reply with no prior stage to fold into — persist reply bookkeeping only.
        await db.update(sourcedCandidatesTable).set({
          rawData: { ...raw, stage: nextStage, ...replyRawPatch },
        }).where(eq(sourcedCandidatesTable.id, sc.id));
      }
    }

    if (mapped === "do_not_contact" && normalized) {
      await db.update(candidatesTable).set({
        doNotContact: true, dncAt: new Date(), dncReason: "ai_unsubscribe", updatedAt: new Date(),
      } as any).where(eq(candidatesTable.id, normalized.id)).catch(() => {});
    }

    // Notify the assigned recruiter (inbox + email/digest) for ALL classifications
    // including not_interested/unsubscribe — the old card-action path silently
    // moved declines to "rejected" with no recruiter signal.
    if (sc && jobId) {
      try {
        const candName = normalized
          ? `${normalized.firstName ?? ""} ${normalized.lastName ?? ""}`.trim()
          : ((sc as any)?.rawData?.name ?? null);
        const { notifyRecruiterOfReply } = await import("../lib/recruiter-reply-notify.js");
        await notifyRecruiterOfReply({
          tenantId: (sc as any).tenantId,
          jobId,
          candidateId: sc.id,
          candidateName: candName,
          candidateEmail: fromEmail,
          classification,
          body,
          attachments,
        });
      } catch (err: any) {
        logger.error({ err: err?.message, sourcedId: sc.id }, "[inbound-email] recruiter notify failed");
      }
    }

    // ── Connection Engine: record replied_to_message signal ─────────────────
    if (normalized?.id && jobId) {
      try {
        const { recordCandidateConnectionEvent, recalculateCandidateInsights } =
          await import("../lib/candidateConnectionEngine.js");
        await recordCandidateConnectionEvent({
          candidateId: normalized.id,
          eventType: "replied_to_message",
          jobId: jobId ?? null,
        });
        await recalculateCandidateInsights(normalized.id, jobId ?? null);
      } catch (err: any) {
        logger.error({ err: err?.message }, "[inbound-email] Connection Engine update failed (Path B)");
      }
      try {
        const { recordConnectionEvent, recalculateConnectionScore } =
          await import("../lib/connectionEngine.js");
        const empId = (sc as any)?.tenantId ?? null;
        await recordConnectionEvent({
          candidateId: normalized.id,
          eventType: "replied_to_outreach",
          jobId: jobId ?? null,
          employerId: empId,
        });
        // +10 if candidate replied within 24 h of the last outreach send
        const [lastSent] = await db.select({ sentAt: outreachMessagesTable.sentAt })
          .from(outreachMessagesTable)
          .where(and(
            eq(outreachMessagesTable.candidateId, normalized.id),
            eq(outreachMessagesTable.status, "sent"),
          ))
          .orderBy(desc(outreachMessagesTable.sentAt))
          .limit(1);
        if (lastSent?.sentAt) {
          const hoursElapsed = (Date.now() - new Date(lastSent.sentAt).getTime()) / 36e5;
          if (hoursElapsed <= 24) {
            await recordConnectionEvent({
              candidateId: normalized.id,
              eventType: "response_within_24h",
              jobId: jobId ?? null,
              employerId: empId,
            });
          }
        }
        // +15 if candidate expressed interest (accepted the intro)
        if (classification === "interested") {
          await recordConnectionEvent({
            candidateId: normalized.id,
            eventType: "accepted_intro",
            jobId: jobId ?? null,
            employerId: empId,
          });
        }
        await recalculateConnectionScore(normalized.id, jobId ?? null, empId);
      } catch (err: any) {
        logger.error({ err: err?.message }, "[inbound-email] Employer Connection Engine update failed (Path B)");
      }
    }

    logger.info({
      fromEmail, path: "card-action", sourcedId: sc?.id, jobId,
      classification, sentiment, mapped, interviewInviteOk: inviteResult?.emailOk,
    }, "[inbound-email] Reply classified (no campaign)");

    // Persist the inbound message and the classification decision into the audit trail.
    try {
      const { recordAudit } = await import("../lib/audit.js");
      const tenantId = (sc as any)?.tenantId ?? null;
      const candName = normalized
        ? `${normalized.firstName ?? ""} ${normalized.lastName ?? ""}`.trim() || fromEmail
        : fromEmail;
      void recordAudit({
        tenantId,
        actorType: "candidate",
        actorId: normalized?.id ?? sc?.id ?? null,
        actorLabel: candName,
        subjectType: "system",
        channel: "email",
        direction: "inbound",
        action: "inbound.reply.received",
        title: subject || `Reply from ${fromEmail}`,
        body,
        metadata: {
          fromEmail, sourcedId: sc?.id, jobId,
          classification, sentiment, mapped,
          stageBefore: stageBefore ?? null,
          stageAfter: nextStage ?? null,
          interviewSessionId: inviteResult?.sessionId ?? null,
        },
      });
    } catch { /* never let audit break the webhook */ }

    res.status(200).json({
      ok: true, path: "card-action", fromEmail,
      sourcedId: sc?.id, jobId,
      classification, sentiment, mappedSentiment: mapped,
      interviewInvite: inviteResult,
    });
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, "[inbound-email] Handler failed");
    res.status(500).json({ error: err.message || "Internal error" });
  }
});

export default router;
