/**
 * azure-pool.ts — Azure Speech account pool + per-account circuit breaker
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Lets STT (transcribe.ts) and TTS (/interviews/tts) draw on MORE THAN ONE
 * Azure Speech / TTS account so a single account's per-region concurrency quota
 * stops being the ceiling under load. Requests round-robin across the configured
 * accounts; a per-account circuit breaker isolates an account that starts
 * throttling (429s) or timing out, shifting traffic to the healthy ones and —
 * once every account is tripped — letting the caller fall through to its
 * existing fallback (Whisper for STT, OpenAI TTS for TTS).
 *
 * ─── Backward compatibility (critical) ──────────────────────────────────────
 * With a single account configured (today's setup) this behaves EXACTLY like
 * the previous single-key path: one account, round-robin is a no-op, and the
 * breaker keys collapse to that one account so the per-format STT breaker
 * semantics are unchanged.
 *
 * ─── Configuration ──────────────────────────────────────────────────────────
 *   STT accounts:
 *     AZURE_SPEECH_KEY + AZURE_SPEECH_REGION        primary (as today)
 *     AZURE_SPEECH_KEYS = "key:region,key:region"   optional extra accounts
 *   TTS accounts:
 *     AZURE_TTS_KEY + AZURE_TTS_REGION              dedicated TTS primary
 *     AZURE_TTS_KEYS = "key:region,key:region"      optional extra accounts
 *     (falls back to the STT creds when no dedicated TTS account is set)
 *
 * Breaker tuning reuses the existing env names so prior tuning still applies:
 *   AZURE_BREAKER_THRESHOLD   (default 3 consecutive hard failures)
 *   AZURE_BREAKER_COOLDOWN_MS (default 30000)
 */
import { logger } from "./logger";

export interface AzureAccount {
  /** Stable, log-safe id (region + position) — never contains the secret key. */
  id: string;
  key: string;
  region: string;
}

const BREAKER_THRESHOLD = Number(process.env.AZURE_BREAKER_THRESHOLD) || 3;
const BREAKER_COOLDOWN_MS = Number(process.env.AZURE_BREAKER_COOLDOWN_MS) || 30_000;

/* Breaker state keyed by an arbitrary string so callers can namespace it
   however they need (STT keys by account+format; TTS keys by account). A single
   Node thread makes module-level mutable state safe. */
const breaker = new Map<string, { consecFailures: number; openUntil: number }>();
function breakerState(key: string) {
  let s = breaker.get(key);
  if (!s) {
    s = { consecFailures: 0, openUntil: 0 };
    breaker.set(key, s);
  }
  return s;
}
export function breakerOpen(key: string): boolean {
  return Date.now() < breakerState(key).openUntil;
}
export function noteSuccess(key: string): void {
  const s = breakerState(key);
  s.consecFailures = 0;
  s.openUntil = 0;
}
export function noteFailure(key: string, label?: string): void {
  const s = breakerState(key);
  s.consecFailures += 1;
  if (s.consecFailures >= BREAKER_THRESHOLD) {
    s.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    s.consecFailures = 0;
    logger.warn({ account: label ?? key, cooldownMs: BREAKER_COOLDOWN_MS }, "[azure-pool] circuit breaker OPEN — isolating this account until cooldown");
  }
}

/* Parse a "key:region,key:region" list. The key half never contains a colon
   (Azure keys are hex), so split on the FIRST colon; the remainder is the
   region. Malformed entries are skipped rather than throwing. */
function parsePairs(raw: string | undefined): Array<{ key: string; region: string }> {
  if (!raw) return [];
  const out: Array<{ key: string; region: string }> = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const region = trimmed.slice(idx + 1).trim();
    if (key && region) out.push({ key, region });
  }
  return out;
}

/* Dedupe identical key+region pairs and assign stable, log-safe ids. The id is
   region + positional index so it is stable across calls (parse order is
   deterministic) and never leaks the secret key into logs. */
function toAccounts(pairs: Array<{ key: string; region: string }>): AzureAccount[] {
  const seen = new Set<string>();
  const accounts: AzureAccount[] = [];
  for (const p of pairs) {
    const dedupeKey = `${p.key}|${p.region}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    accounts.push({ id: `${p.region}#${accounts.length}`, key: p.key, region: p.region });
  }
  return accounts;
}

export function getSttAccounts(env: NodeJS.ProcessEnv = process.env): AzureAccount[] {
  const pairs: Array<{ key: string; region: string }> = [];
  if (env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION) {
    pairs.push({ key: env.AZURE_SPEECH_KEY, region: env.AZURE_SPEECH_REGION });
  }
  pairs.push(...parsePairs(env.AZURE_SPEECH_KEYS));
  return toAccounts(pairs);
}

export function getTtsAccounts(env: NodeJS.ProcessEnv = process.env): AzureAccount[] {
  const pairs: Array<{ key: string; region: string }> = [];
  if (env.AZURE_TTS_KEY && env.AZURE_TTS_REGION) {
    pairs.push({ key: env.AZURE_TTS_KEY, region: env.AZURE_TTS_REGION });
  }
  pairs.push(...parsePairs(env.AZURE_TTS_KEYS));
  /* No dedicated TTS account → fall back to the shared STT creds so nothing
     breaks until a dedicated TTS key is configured (today's behavior). */
  if (pairs.length === 0 && env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION) {
    pairs.push({ key: env.AZURE_SPEECH_KEY, region: env.AZURE_SPEECH_REGION });
  }
  return toAccounts(pairs);
}

/* Round-robin cursor per namespace (e.g. "stt", "tts"). Module-level is safe on
   Node's single thread. */
const cursor = new Map<string, number>();

export interface PickedAccount {
  /** The selected account. */
  account: AzureAccount;
  /** Breaker key to pass to noteSuccess/noteFailure for THIS attempt. */
  breakerKey: string;
}

/**
 * Round-robin pick the next account whose breaker is closed, skipping tripped
 * accounts. Returns null when there are NO accounts configured OR when every
 * account's breaker is open — in both cases the caller should fall through to
 * its non-Azure fallback (Whisper for STT, OpenAI for TTS). This null-on-empty
 * contract is what keeps the legacy "no Azure creds → straight to fallback"
 * behavior intact: callers must NOT enter the Azure branch on a null pick.
 *
 * @param namespace  separates round-robin + breaker state per service ("stt"/"tts")
 * @param accounts   accounts from getSttAccounts()/getTtsAccounts()
 * @param formatKey  optional extra breaker dimension (STT keys by audio format)
 */
export function pickAccount(namespace: string, accounts: AzureAccount[], formatKey?: string): PickedAccount | null {
  if (accounts.length === 0) return null;
  const suffix = formatKey ? `::${formatKey}` : "";

  const start = cursor.get(namespace) ?? 0;
  for (let i = 0; i < accounts.length; i++) {
    const idx = (start + i) % accounts.length;
    const account = accounts[idx];
    const breakerKey = `${namespace}:${account.id}${suffix}`;
    if (!breakerOpen(breakerKey)) {
      cursor.set(namespace, (idx + 1) % accounts.length);
      return { account, breakerKey };
    }
  }
  return null; /* every account tripped */
}
