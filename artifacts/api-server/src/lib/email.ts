/**
 * email.ts — Transactional Email Service (Amazon SES v2)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Single entry point for all outbound email in the platform. Every email that
 * Lexy sends — outreach, interview invites, rejection letters, digests,
 * re-engagement nudges — routes through sendEmail() here.
 *
 * ─── SES client ──────────────────────────────────────────────────────────────
 * The client is lazy-initialised on the first call (singleton). If
 * AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY are present, they are used;
 * otherwise the SDK picks up an IAM instance profile automatically (production
 * ECS / EC2 deployment).
 *
 * ─── Simulated send (dev / CI) ───────────────────────────────────────────────
 * When SES_FROM_EMAIL or the AWS credentials are absent, sendEmail() logs the
 * intent and returns { ok: true, simulated: true } without calling SES.
 * This means all downstream code (outreach engine, schedulers, etc.) works
 * correctly in local dev without any real credentials.
 *
 * ─── Audit trail ─────────────────────────────────────────────────────────────
 * Every send (real or simulated) writes a row to audit_logs via recordAudit().
 * The caller can pass an `audit` object to customise actor/subject/action
 * labels; defaults are sensible for direct calls without context.
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *   SES_FROM_EMAIL              Sender address (required for real sends)
 *   SES_REPLY_TO                Default Reply-To address
 *   SES_CONFIGURATION_SET       SES configuration set name (optional)
 *   SES_REGION / AWS_REGION     Region (default "us-east-1")
 *   AWS_ACCESS_KEY_ID           IAM key (optional — use IAM role on EC2/ECS)
 *   AWS_SECRET_ACCESS_KEY       IAM secret
 *   AWS_SESSION_TOKEN           Session token (optional, for STS creds)
 *
 * ─── Exports ─────────────────────────────────────────────────────────────────
 *   sendEmail()         Send a transactional email (real or simulated)
 *   isEmailConfigured() Check if SES credentials are present
 *   plainToHtml()       Wrap a plain-text body in a minimal HTML template
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { logger } from "./logger.js";
import { recordAudit } from "./audit.js";
import { isDemoEmail } from "./demo-email.js";

const REGION = process.env.SES_REGION || process.env.AWS_REGION || "us-east-1";
const FROM_ADDR = process.env.SES_FROM_EMAIL || "";
const REPLY_TO = process.env.SES_REPLY_TO || "";
const CONFIG_SET = process.env.SES_CONFIGURATION_SET || "";

let _client: SESv2Client | null = null;
function getClient(): SESv2Client {
  if (_client) return _client;
  const cfg: ConstructorParameters<typeof SESv2Client>[0] = { region: REGION };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  _client = new SESv2Client(cfg);
  return _client;
}

export function isEmailConfigured(): boolean {
  return Boolean(
    FROM_ADDR &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY,
  );
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  /** When set together with `useRecruiterMailbox`, this recruiter's connected
   *  Microsoft 365 / Outlook mailbox is used to send the message via Graph
   *  ("as the recruiter") instead of the shared SES sender. Any failure (no
   *  mailbox, revoked token, Graph error) transparently falls back to SES. */
  senderUserId?: string;
  useRecruiterMailbox?: boolean;
  /** Optional one-click unsubscribe URL. When set, RFC 8058 List-Unsubscribe
   *  and List-Unsubscribe-Post headers are added so Gmail/Outlook bulk-sender
   *  policies are satisfied. Must be an HTTPS URL the recipient can hit
   *  unauthenticated to opt out. */
  unsubscribeUrl?: string;
  /** Optional file attachments. When present, the email is sent as a raw MIME
   *  message (SES v2 Content.Raw) built with nodemailer's MailComposer, since the
   *  Simple content API cannot carry attachments. `content` is base64-encoded. */
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
  /** Audit context: who/what triggered this send, so audit_logs has a clean trail. */
  audit?: {
    tenantId?: string | null;
    actorLabel?: string | null;     // e.g. "Outreach Engine", "Interview Reply Agent"
    subjectType?: "user" | "candidate" | "external" | null;
    subjectId?: string | null;      // candidateId / userId
    subjectLabel?: string | null;   // candidate/user display name
    action?: string | null;         // e.g. "outreach.send", "interview.invite"
    metadata?: Record<string, any> | null;
  };
}

export interface SendEmailResult {
  ok: boolean;
  messageId?: string;
  simulated?: boolean;
  /** True when the address is on the reserved demo domain and was hard-refused
   *  at the transport (no dispatch). ok:true so callers don't mark it failed. */
  suppressed?: boolean;
  error?: string;
}

/**
 * Send a transactional email via Amazon SES (v2).
 * Falls back to a simulated send (logs only) when SES_FROM_EMAIL or AWS creds are missing
 * so local/dev environments don't crash and test data still flows through the pipeline.
 */
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const { to, subject } = input;
  const html = input.html;
  const text = input.text ?? (html ? stripHtml(html) : "");
  const from = input.from || FROM_ADDR;
  const replyTo = input.replyTo || REPLY_TO;

  if (!to || !subject) {
    return { ok: false, error: "Missing recipient or subject" };
  }

  const auditCtx = input.audit ?? {};
  const auditBase = {
    tenantId: auditCtx.tenantId ?? null,
    actorType: "system" as const,
    actorLabel: auditCtx.actorLabel ?? "Email Service",
    subjectType: (auditCtx.subjectType ?? "external") as any,
    subjectId: auditCtx.subjectId ?? null,
    subjectLabel: auditCtx.subjectLabel ?? to,
    channel: "email" as const,
    direction: "outbound" as const,
    title: subject,
    body: text || (html ? stripHtml(html) : ""),
    metadata: { to, from, ...(auditCtx.metadata ?? {}) },
  };

  /* ── Demo-domain hard refusal ──────────────────────────────────────────────
     Addresses on the reserved synthetic demo domain (seeded demo candidates)
     must NEVER be dispatched — not via a recruiter's Graph mailbox, not via SES.
     We short-circuit here BEFORE any transport so a sales demo can walk the full
     draft → approve → "send" flow with ZERO risk of an email leaving the
     building. Returned as a distinct `suppressed` outcome (ok:true, NOT a
     failure) so callers never mark the message failed; the send/reply/failure
     counters are separately kept from incrementing for suppressed sends, which
     is how the demo domain stays out of every rate denominator. */
  if (isDemoEmail(to)) {
    logger.info({ to, subject }, "[email] SUPPRESSED demo-domain send (no dispatch)");
    void recordAudit({ ...auditBase, action: "email.suppressed_demo" });
    return { ok: true, suppressed: true, messageId: `demo-${Date.now()}` };
  }

  /* ── Send-router: recruiter's own mailbox (Microsoft Graph) ────────────────
     Eligible messages (manual 1:1 + the first/approved outreach step for an
     owned candidate) set useRecruiterMailbox + senderUserId. When that recruiter
     has a healthy connected mailbox we send "as them" via Graph and return.
     ANY failure (no mailbox, revoked token, Graph error, or even a thrown
     router error) falls through to the SES path below — the user-chosen
     fallback behaviour. Placed BEFORE the SES-config check so a connected
     mailbox can deliver even when SES is not configured (e.g. dev). */
  if (input.useRecruiterMailbox && input.senderUserId) {
    try {
      const { hasHealthyMailbox } = await import("./recruiter-mail.js");
      if (await hasHealthyMailbox(input.senderUserId)) {
        const { sendViaGraph } = await import("./graph-mail.js");
        const g = await sendViaGraph(input.senderUserId, {
          to,
          subject,
          html,
          text,
          replyTo: input.replyTo || undefined,
          attachments: input.attachments,
        });
        if (g.ok) {
          logger.info(
            { to, subject, senderUserId: input.senderUserId },
            "[email] sent via Graph (recruiter mailbox)",
          );
          void recordAudit({
            ...auditBase,
            action: auditCtx.action ?? "email.sent",
            metadata: { ...auditBase.metadata, transport: "graph", senderUserId: input.senderUserId, messageId: g.messageId },
          });
          return { ok: true, messageId: g.messageId };
        }
        logger.warn(
          { to, senderUserId: input.senderUserId, error: g.error },
          "[email] Graph send failed — falling back to SES",
        );
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        "[email] recruiter-mailbox router error — falling back to SES",
      );
    }
  }

  if (!isEmailConfigured()) {
    /* HARD-FAIL in production: silently "simulating" delivery when no provider
       is configured is the most dangerous failure mode in the whole platform —
       digests, nurture, invites all "succeed" without leaving the building.
       In production we refuse to pretend. In dev we still simulate so local
       work doesn't crash, but we log loudly. */
    if (process.env.NODE_ENV === "production") {
      logger.error(
        { to, subject },
        "[email] REFUSING TO SEND in production — SES_FROM_EMAIL or AWS creds missing",
      );
      void recordAudit({
        ...auditBase,
        action: "email.failed",
        metadata: { ...auditBase.metadata, error: "EMAIL_NOT_CONFIGURED" },
      });
      return { ok: false, error: "Email provider not configured (production)" };
    }
    logger.warn(
      { to, subject, from },
      "[email] SIMULATED SEND in dev (set SES_FROM_EMAIL + AWS creds for real delivery)",
    );
    void recordAudit({ ...auditBase, action: auditCtx.action ?? "email.simulated" });
    return { ok: true, simulated: true, messageId: `sim-${Date.now()}` };
  }

  /* RFC 8058 one-click unsubscribe headers — required for Gmail/Outlook bulk
     sender policy. Only set when caller supplies an unsubscribeUrl (transactional
     1:1 messages like a single interview invite don't need them). */
  const unsubHeaders: { Name: string; Value: string }[] = [];
  if (input.unsubscribeUrl) {
    unsubHeaders.push({ Name: "List-Unsubscribe", Value: `<${input.unsubscribeUrl}>` });
    unsubHeaders.push({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
  }

  try {
    let cmd: SendEmailCommand;
    const attachments = input.attachments ?? [];
    if (attachments.length > 0) {
      /* Attachments require a raw MIME message — the SES Simple content API
         cannot carry them. Build the MIME with nodemailer's MailComposer and
         hand SES the raw bytes via Content.Raw. */
      const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
      const composer = new MailComposer({
        from,
        to,
        subject,
        text: text || subject,
        html: html || undefined,
        replyTo: replyTo || undefined,
        headers: unsubHeaders.map((h) => ({ key: h.Name, value: h.Value })),
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content, "base64"),
          contentType: a.contentType || undefined,
        })),
      });
      const raw: Buffer = await new Promise((resolve, reject) => {
        composer.compile().build((err: Error | null, msg: Buffer) =>
          err ? reject(err) : resolve(msg),
        );
      });
      cmd = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ReplyToAddresses: replyTo ? [replyTo] : undefined,
        ConfigurationSetName: CONFIG_SET || undefined,
        Content: { Raw: { Data: new Uint8Array(raw) } },
      });
    } else {
      cmd = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ReplyToAddresses: replyTo ? [replyTo] : undefined,
        ConfigurationSetName: CONFIG_SET || undefined,
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Html: html ? { Data: html, Charset: "UTF-8" } : undefined,
              Text: { Data: text || subject, Charset: "UTF-8" },
            },
            Headers: unsubHeaders.length ? unsubHeaders : undefined,
          },
        },
      });
    }
    const out = await getClient().send(cmd);
    logger.info(
      { to, subject, messageId: out.MessageId },
      "[email] sent via SES",
    );
    void recordAudit({
      ...auditBase,
      action: auditCtx.action ?? "email.sent",
      metadata: { ...auditBase.metadata, messageId: out.MessageId },
    });
    return { ok: true, messageId: out.MessageId };
  } catch (err: any) {
    logger.error(
      { to, subject, err: err?.message, code: err?.name },
      "[email] SES send failed",
    );
    void recordAudit({
      ...auditBase,
      action: "email.failed",
      metadata: { ...auditBase.metadata, error: err?.message, code: err?.name },
    });
    return { ok: false, error: err?.message || "SES send failed" };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

/** Minimal HTML wrapper used when an outbound message only has a plain-text body. */
export function plainToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("")}</body></html>`;
}
