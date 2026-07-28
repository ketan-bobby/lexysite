/**
 * lib/share-analytics.ts — Viral Share Event Tracker
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Lightweight, zero-dependency analytics tracker for the Viral Share Engine.
 * Every share-related user action (button click, download, copy, social link)
 * is recorded via trackShareEvent() and stored in localStorage under the
 * key "lexy_share_events". The history can be retrieved with getShareEventLog()
 * for display or future backend sync.
 *
 * ─── Tracked events ──────────────────────────────────────────────────────────
 *   share_clicked       — the "Share" button was pressed
 *   image_downloaded    — user downloaded the PNG card
 *   caption_copied      — user copied one of the AI captions
 *   linkedin_share      — user clicked the LinkedIn share link
 *   x_share             — user clicked the X (Twitter) share link
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/share/ShareModal.tsx  — fires events on each action
 */

export type ShareEvent =
  | "share_clicked"
  | "image_downloaded"
  | "caption_copied"
  | "linkedin_share"
  | "x_share";

export interface ShareEventPayload {
  event: ShareEvent;
  candidateId?: string;
  caption_type?: "linkedin" | "x" | "reflective";
  timestamp: string;
}

const STORAGE_KEY = "lexy_share_events";

function getStored(): ShareEventPayload[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function trackShareEvent(
  event: ShareEvent,
  meta?: Omit<ShareEventPayload, "event" | "timestamp">,
) {
  const payload: ShareEventPayload = {
    event,
    timestamp: new Date().toISOString(),
    ...meta,
  };

  // Persist locally
  try {
    const existing = getStored();
    existing.push(payload);
    // Keep last 200 events
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing.slice(-200)));
  } catch {
    // localStorage unavailable — silently ignore
  }

  // Emit a custom DOM event so anything can listen
  try {
    window.dispatchEvent(new CustomEvent("lexy:share", { detail: payload }));
  } catch {
    // no-op
  }
}

export function getShareEventLog(): ShareEventPayload[] {
  return getStored();
}
