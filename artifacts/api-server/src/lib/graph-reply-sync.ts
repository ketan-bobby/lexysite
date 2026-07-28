/**
 * graph-reply-sync.ts — Pull candidate replies from recruiters' Outlook into Lexy
 *
 * ─── Why ─────────────────────────────────────────────────────────────────────
 * When a recruiter connects their Microsoft 365 / Outlook mailbox, Lexy sends
 * their manual 1:1 emails and the first/approved outreach step "as them" via
 * Microsoft Graph. Candidate replies therefore land in the RECRUITER's Outlook
 * inbox, not in our SES inbound stream — so without this poller those replies
 * would never reach the Lexy recruiter inbox / analytics.
 *
 * ─── How ─────────────────────────────────────────────────────────────────────
 * A background scheduler walks every connected mailbox on an interval and uses
 * the Graph **delta query** on the inbox folder:
 *   • First sync establishes a baseline by paging (id-only) THROUGH the current
 *     inbox to the final `@odata.deltaLink` WITHOUT forwarding anything, so we
 *     DON'T ingest the recruiter's entire mail history — only replies that
 *     arrive afterwards. (Graph's message delta does NOT honor a
 *     `?$deltatoken=latest` shortcut; only the last page carries the deltaLink.)
 *   • Each subsequent poll follows the stored deltaLink, which returns only the
 *     messages that changed since last time, plus a fresh deltaLink we persist.
 *
 * Each new inbound message is forwarded to the SAME inbound-email webhook the
 * SES path uses (`POST /api/webhooks/email/inbound`, shared-secret protected),
 * so candidate identification, AI reply classification, stage advancement,
 * recruiter-inbox notification and engagement analytics all reuse the existing,
 * battle-tested pipeline — no duplicate logic.
 *
 * Requires INBOUND_EMAIL_SECRET (the same secret the SES inbound webhook uses).
 * If it isn't configured, reply-sync no-ops with a single warning, exactly like
 * the SES inbound path would be inert without it.
 */
import { logger } from "./logger.js";
import { getAccessTokenForUser } from "./graph-auth.js";
import {
  getConnectedMailAccounts,
  updateMailAccountDelta,
  markMailAccountError,
  type MailAccount,
} from "./recruiter-mail.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const POLL_MINUTES = Math.max(1, Number(process.env.GRAPH_POLL_MINUTES) || 3);
const SELECT = "id,subject,from,sender,bodyPreview,body,isDraft,receivedDateTime";

let started = false;
let ticking = false;

function inboundSecret(): string {
  return (process.env.INBOUND_EMAIL_SECRET || "").trim();
}

/** Self-call the existing inbound-email webhook on the local server. */
function inboundUrl(): string {
  const port = Number(process.env.PORT) || 0;
  return `http://127.0.0.1:${port}/api/webhooks/inbound-email`;
}

/**
 * Strip the quoted history off a plain-text reply so the inbox preview and the
 * AI classifier see only the new message. Mirrors the SES path's intent (that
 * one trims inside the webhook; the generic-JSON shape we POST does not, so we
 * trim here). Conservative: only cuts at well-known reply boundaries.
 */
function trimQuoted(body: string): string {
  if (!body) return "";
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const markers = [
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,
    /^\s*From:\s.+/i,
    /^\s*On .+ wrote:\s*$/i,
    /^\s*_{5,}\s*$/,
    /^\s*Sent from my /i,
  ];
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((m) => m.test(lines[i]))) {
      const kept = lines.slice(0, i).join("\n").trim();
      // Don't let an over-eager match nuke the whole message.
      if (kept.length > 0) return kept;
    }
  }
  return body.trim();
}

async function graphGet(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Ask Graph for plain-text bodies so we don't ship raw HTML to the webhook,
      // and a large page size so the one-time baseline walk finishes in few pages.
      Prefer: 'outlook.body-content-type="text", odata.maxpagesize=200',
    },
  });
}

/**
 * Forward one inbound Outlook message to the shared inbound-email webhook.
 * Returns true only when the webhook accepted it (2xx) OR the message is not a
 * candidate reply we need to forward (self-mail / no sender — safe to skip).
 * Returns false on a webhook error so the caller can retry without advancing
 * the delta cursor past an undelivered reply.
 */
async function forwardToInbound(account: MailAccount, msg: any): Promise<boolean> {
  const from = String(msg?.from?.emailAddress?.address || msg?.sender?.emailAddress?.address || "")
    .trim()
    .toLowerCase();
  if (!from) return true; // nothing to forward — treat as done
  // Never treat the recruiter's own mail (e.g. a self-CC) as a candidate reply.
  if (account.email && from === account.email.toLowerCase()) return true;

  const rawBody = typeof msg?.body?.content === "string" ? msg.body.content : (msg?.bodyPreview || "");
  const text = trimQuoted(rawBody);
  const subject = typeof msg?.subject === "string" ? msg.subject : undefined;

  const res = await fetch(inboundUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": inboundSecret() },
    body: JSON.stringify({ from, subject, text }),
  });
  if (res.ok) return true;
  const errText = await res.text().catch(() => "");
  logger.warn(
    { userId: account.userId, status: res.status, errText: errText.slice(0, 200) },
    "[graph-reply-sync] inbound webhook rejected a forwarded message",
  );
  return false;
}

/**
 * Sync one mailbox. On first run (no stored deltaLink) we only record a baseline
 * deltaLink and ingest nothing historical; thereafter we walk the delta pages,
 * forward new inbound messages, and persist the next deltaLink.
 */
async function pollMailbox(account: MailAccount): Promise<void> {
  const token = await getAccessTokenForUser(account.userId);
  if (!token) {
    // getAccessTokenForUser already marked the row error/revoked on hard failures.
    return;
  }

  // ── Baseline: walk to the current deltaLink WITHOUT ingesting old mail. ──
  //
  // Graph's message delta does NOT honor `?$deltatoken=latest`: the initial call
  // returns a page of EXISTING inbox mail plus an `@odata.nextLink`, and only the
  // FINAL page carries the `@odata.deltaLink` that represents "now". So we page
  // through to the end (id-only, large pages) forwarding NOTHING, then persist
  // that deltaLink. Subsequent incremental polls then return only NEW replies.
  if (!account.graphDeltaLink) {
    let url: string | null = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=id`;
    let pages = 0;
    while (url) {
      const resp: Response = await graphGet(url, token);
      if (resp.status === 401) {
        await markMailAccountError(account.userId, "graph_401_delta_baseline", true);
        return;
      }
      if (!resp.ok) {
        logger.warn({ userId: account.userId, status: resp.status }, "[graph-reply-sync] baseline delta failed");
        return;
      }
      const json: any = await resp.json().catch(() => ({}));
      const deltaLink = json["@odata.deltaLink"];
      const nextLink = json["@odata.nextLink"];
      if (typeof deltaLink === "string") {
        await updateMailAccountDelta(account.userId, deltaLink);
        logger.info({ userId: account.userId, pages: pages + 1 }, "[graph-reply-sync] baseline established");
        return;
      }
      // Defend against an unbounded history walk (very large mailbox).
      if (typeof nextLink === "string" && ++pages < 1000) {
        url = nextLink;
        continue;
      }
      logger.warn(
        { userId: account.userId, pages },
        "[graph-reply-sync] baseline did not reach a deltaLink — will retry next tick",
      );
      return;
    }
    return;
  }

  // ── Incremental: follow the stored deltaLink, paging through nextLinks. ──
  //
  // Delta windows between polls are naturally small (only what changed since the
  // last cursor), so we drain the whole window. Progress is checkpointed PER PAGE:
  // after every page whose messages all forward successfully we persist that page's
  // next cursor (nextLink mid-walk, or the final deltaLink). If a forward fails we
  // stop WITHOUT advancing, so the next tick retries from the same cursor — replies
  // are never silently dropped (at-least-once; a transient failure may re-forward a
  // page's earlier messages, which is acceptable vs. losing a candidate reply).
  let cursor: string | null = account.graphDeltaLink;
  let processed = 0;

  while (cursor) {
    const resp: Response = await graphGet(cursor, token);
    if (resp.status === 401) {
      await markMailAccountError(account.userId, "graph_401_delta", true);
      return;
    }
    if (resp.status === 410) {
      // deltaLink expired — reset so the next tick re-baselines (no history flood).
      await updateMailAccountDelta(account.userId, null);
      logger.warn({ userId: account.userId }, "[graph-reply-sync] deltaLink expired (410) — re-baselining");
      return;
    }
    if (!resp.ok) {
      logger.warn({ userId: account.userId, status: resp.status }, "[graph-reply-sync] delta poll failed");
      return;
    }
    const json: any = await resp.json().catch(() => ({}));
    const messages: any[] = Array.isArray(json.value) ? json.value : [];
    for (const msg of messages) {
      if (msg?.isDraft) continue;
      // delta returns deletions/changes too; only forward items that have a sender.
      if (!msg?.from && !msg?.sender) continue;
      let ok = false;
      try {
        ok = await forwardToInbound(account, msg);
      } catch (err: any) {
        logger.warn({ userId: account.userId, err: err?.message }, "[graph-reply-sync] forward threw");
        ok = false;
      }
      if (!ok) {
        // Stop without advancing the cursor — retry this page on the next tick.
        if (processed > 0) {
          logger.info({ userId: account.userId, processed }, "[graph-reply-sync] forwarded replies (partial — will retry)");
        }
        return;
      }
      processed++;
    }

    // Page fully forwarded — checkpoint progress before moving on.
    const nextLink = json["@odata.nextLink"];
    const deltaLink = json["@odata.deltaLink"];
    if (typeof nextLink === "string") {
      await updateMailAccountDelta(account.userId, nextLink);
      cursor = nextLink;
    } else {
      if (typeof deltaLink === "string") await updateMailAccountDelta(account.userId, deltaLink);
      cursor = null;
    }
  }

  if (processed > 0) {
    logger.info({ userId: account.userId, processed }, "[graph-reply-sync] forwarded replies");
  }
}

/** One scheduler tick: poll every connected mailbox, isolating failures. */
export async function pollAllMailboxes(): Promise<void> {
  if (ticking) return; // never overlap ticks
  ticking = true;
  try {
    if (!inboundSecret()) {
      logger.warn("[graph-reply-sync] INBOUND_EMAIL_SECRET not set — reply sync disabled");
      return;
    }
    const accounts = await getConnectedMailAccounts();
    for (const account of accounts) {
      try {
        await pollMailbox(account);
      } catch (err: any) {
        logger.warn({ userId: account.userId, err: err?.message }, "[graph-reply-sync] mailbox poll threw");
      }
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "[graph-reply-sync] tick failed");
  } finally {
    ticking = false;
  }
}

/** Start the reply-sync scheduler (call once, on the scheduler leader). */
export function startGraphReplyPollScheduler(): void {
  if (started) return;
  started = true;
  const intervalMs = POLL_MINUTES * 60_000;
  logger.info({ pollMinutes: POLL_MINUTES }, "[graph-reply-sync] Started");
  // Kick a first tick shortly after boot, then on the interval.
  setTimeout(() => void pollAllMailboxes(), 20_000);
  setInterval(() => void pollAllMailboxes(), intervalMs);
}
