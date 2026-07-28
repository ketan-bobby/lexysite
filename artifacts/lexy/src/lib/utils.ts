/**
 * utils.ts — Shared frontend utility helpers.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Exports two lightweight helpers used throughout the Lexy frontend:
 *
 *  cn(…classes)        Merges Tailwind class strings via clsx + tailwind-merge,
 *                      ensuring conflicting utilities (e.g. p-2 / p-4) are
 *                      resolved correctly without duplicate classes.
 *
 *  formatDate(str)     Parses an ISO-8601 date string and formats it using a
 *                      date-fns format pattern (default: "MMM d, yyyy").
 *                      Returns "N/A" for null / undefined / unparseable input.
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  Virtually every component — import as: import { cn } from "@/lib/utils"
 */

import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { format, parseISO } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(dateStr: string | null | undefined, formatStr: string = "MMM d, yyyy") {
  if (!dateStr) return "N/A"
  try {
    return format(parseISO(dateStr), formatStr)
  } catch (e) {
    return dateStr
  }
}

/**
 * pluralize — format a count with its noun, handling singular vs. plural.
 *
 *   pluralize(1, "application")            -> "1 application"
 *   pluralize(2, "application")            -> "2 applications"
 *   pluralize(0, "application")            -> "0 applications"
 *   pluralize(1, "company", "companies")   -> "1 company"
 *   pluralize(3, "company", "companies")   -> "3 companies"
 *
 * The plural form defaults to `${singular}s`. Pass an explicit `plural` for
 * irregular words (reply/replies, company/companies) or phrases that inflect
 * the verb ("company has" / "companies have").
 */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}
