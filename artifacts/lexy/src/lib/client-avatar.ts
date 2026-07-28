/*
 * client-avatar.ts — deterministic avatar treatment for client/tenant chips.
 *
 * Two different clients (e.g. "TAF" and "Tag") used to collapse to the same
 * initials + neutral fill and looked identical. This module derives a stable
 * colour and initials from the client name so the same client always renders
 * the same way everywhere (sidebar, group headers, cards), and resolves the
 * rare case where two clients collide on BOTH initials and colour.
 */

/* Six backgrounds pulled from the existing token ramp only — three opacity
 * steps of the accent (primary) plus three muted/neutral tones. No new colours. */
const AVATAR_COLORS = [
  "bg-primary/30 text-primary",
  "bg-primary/20 text-primary",
  "bg-primary/15 text-primary",
  "bg-muted text-foreground",
  "bg-muted/60 text-muted-foreground",
  "bg-secondary text-secondary-foreground",
] as const;

/* Stable string hash (case/whitespace-insensitive) so a client's colour never
 * changes between renders or surfaces. */
function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function clientColorClass(name: string): string {
  return AVATAR_COLORS[hashString((name || "").trim().toLowerCase()) % AVATAR_COLORS.length];
}

/* Initials for a client name. When there are at least `letters` words, use the
 * first letter of the first `letters` words. Otherwise fall back to the leading
 * alphanumeric characters of the name, so asking for MORE letters always yields
 * MORE characters (this is what makes the collision tiebreak below effective —
 * bumping a two-word name from 2→3 letters must actually change the output). */
export function clientInitials(name: string, letters = 2): string {
  const clean = (name || "").trim();
  if (!clean) return "?";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= letters) {
    return words.slice(0, letters).map((w) => w[0]).join("").toUpperCase();
  }
  const alnum = clean.replace(/[^a-zA-Z0-9]/g, "");
  return (alnum.length > 0 ? alnum : clean).slice(0, letters).toUpperCase();
}

export interface ClientAvatar {
  initials: string;
  colorClass: string;
}

export function clientAvatar(name: string): ClientAvatar {
  return { initials: clientInitials(name), colorClass: clientColorClass(name) };
}

/*
 * Resolve avatars for a set of client names. When distinct names collide on BOTH
 * initials and colour, disambiguate them: the group is ordered deterministically
 * (alphabetically, so the outcome does not depend on input order) and each later
 * member is given one extra initials letter (2, 3, 4, …). The first keeps its
 * 2-letter form, so within a colliding pair the two never share the same
 * treatment. Callers should build this map from a single canonical client list
 * (the same one everywhere) and look names up, falling back to clientAvatar for
 * any name not present in the set.
 */
export function resolveClientAvatars(names: Array<string | null | undefined>): Map<string, ClientAvatar> {
  const result = new Map<string, ClientAvatar>();
  const groups = new Map<string, string[]>();
  for (const raw of names) {
    if (raw == null) continue;
    const name = raw;
    if (result.has(name)) continue;
    const avatar = clientAvatar(name);
    result.set(name, avatar);
    const key = `${avatar.initials}|${avatar.colorClass}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(name);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const ordered = [...group].sort((a, b) => a.localeCompare(b));
    ordered.forEach((name, i) => {
      if (i === 0) return; // first keeps the base 2-letter form
      result.set(name, { initials: clientInitials(name, 2 + i), colorClass: clientColorClass(name) });
    });
  }
  return result;
}
