/**
 * password-policy.ts — Strength rules for NEW passwords
 *
 * Applied wherever a user CHOOSES a new password (registration, staff-invite
 * accept, password reset, admin user-create, trial signup). Deliberately NOT
 * applied at login time — pre-policy accounts with shorter/simpler passwords
 * must still be able to authenticate; the next reset / rotation upgrades them.
 *
 * Policy (B2B-appropriate, NIST 800-63B aligned):
 *   - Minimum length 12 (NIST recommends ≥8, but B2B credential-stuffing
 *     targets justify the higher floor)
 *   - At least one uppercase letter
 *   - At least one lowercase letter
 *   - At least one digit
 *   - At least one non-alphanumeric character
 *   - Reject a small built-in blocklist of the most-common breached
 *     passwords (case-insensitive). This is intentionally short — a real
 *     deployment should swap this for the HIBP-pwned-passwords API or a
 *     large dictionary lookup. The list here just stops the laziest stuffing.
 *
 * Returns a structured result so callers can render a specific error message
 * AND a stable error code that clients can localise.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128; // bcrypt truncates >72; cap UX-side to avoid surprise

/** Short blocklist of the absolute-worst passwords. Lowercased on input. */
const COMMON_PASSWORDS = new Set<string>([
  "password",     "password1",    "password123",  "password1!",
  "qwerty",       "qwerty123",    "qwertyuiop",
  "12345678",     "123456789",    "1234567890",   "111111111",
  "letmein",      "letmein123",
  "welcome",      "welcome1",     "welcome123",
  "admin",        "admin123",     "administrator",
  "iloveyou",     "monkey",       "dragon",
  "sunshine",     "princess",     "football",
  "abc12345",     "passw0rd",     "p@ssw0rd",     "p@ssword",
  "trustno1",     "changeme",     "changeme1",
]);

export type PasswordPolicyError =
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "PASSWORD_MISSING_UPPERCASE"
  | "PASSWORD_MISSING_LOWERCASE"
  | "PASSWORD_MISSING_DIGIT"
  | "PASSWORD_MISSING_SYMBOL"
  | "PASSWORD_TOO_COMMON";

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; code: PasswordPolicyError; message: string };

export function validatePasswordStrength(pw: unknown): PasswordPolicyResult {
  if (typeof pw !== "string") {
    return { ok: false, code: "PASSWORD_TOO_SHORT", message: "Password is required." };
  }
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "PASSWORD_TOO_SHORT",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "PASSWORD_TOO_LONG",
      message: `Password must be no more than ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  if (!/[A-Z]/.test(pw)) {
    return { ok: false, code: "PASSWORD_MISSING_UPPERCASE", message: "Password must include an uppercase letter." };
  }
  if (!/[a-z]/.test(pw)) {
    return { ok: false, code: "PASSWORD_MISSING_LOWERCASE", message: "Password must include a lowercase letter." };
  }
  if (!/[0-9]/.test(pw)) {
    return { ok: false, code: "PASSWORD_MISSING_DIGIT", message: "Password must include a digit." };
  }
  if (!/[^A-Za-z0-9]/.test(pw)) {
    return { ok: false, code: "PASSWORD_MISSING_SYMBOL", message: "Password must include a symbol (e.g. ! @ # $ %)." };
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    return { ok: false, code: "PASSWORD_TOO_COMMON", message: "This password is too common. Please choose something less guessable." };
  }
  return { ok: true };
}
