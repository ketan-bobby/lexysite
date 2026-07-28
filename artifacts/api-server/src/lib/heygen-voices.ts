/**
 * lib/heygen-voices.ts — Resolve a HeyGen voice_id for a language + gender
 *
 * Resolution order:
 *   1. explicit override (recruiter-picked voice_id)
 *   2. curated map (optional hand-picked ids per language)
 *   3. live HeyGen /v2/voices, matched by language + gender (cached 1h)
 *   4. null → let HeyGen pick its default for the script's language
 *
 * The curated map is intentionally empty by default: HeyGen voice ids are not
 * stable to hardcode blindly, so we prefer the live catalogue. Populate it only
 * with ids verified against a live account.
 */
import type { HeyGenClient, HeyGenVoice } from "./heygen";

export const CURATED_VOICE_IDS: Record<string, { female?: string; male?: string }> = {};

/**
 * HeyGen reports a voice's language as an English name (e.g. "Spanish"), not a
 * BCP-47 code. Map the candidate's language base code to the name keywords we
 * expect to find so we can match either form.
 */
const LANGUAGE_NAME_KEYWORDS: Record<string, string[]> = {
  en: ["english"],
  es: ["spanish", "español", "espanol"],
  fr: ["french", "français", "francais"],
  de: ["german", "deutsch"],
  pt: ["portuguese", "português", "portugues"],
  it: ["italian", "italiano"],
  nl: ["dutch", "nederlands"],
  pl: ["polish", "polski"],
  ru: ["russian"],
  ar: ["arabic"],
  hi: ["hindi"],
  ja: ["japanese", "日本"],
  ko: ["korean", "한국"],
  zh: ["chinese", "mandarin", "中文"],
  tr: ["turkish"],
  vi: ["vietnamese"],
  id: ["indonesian"],
  th: ["thai"],
  uk: ["ukrainian"],
  sv: ["swedish"],
  no: ["norwegian"],
  da: ["danish"],
  fi: ["finnish"],
  cs: ["czech"],
  ro: ["romanian"],
  el: ["greek"],
  he: ["hebrew"],
};

let voiceCache: { at: number; voices: HeyGenVoice[] } | null = null;
const VOICE_TTL_MS = 60 * 60 * 1000;

/** Test-only: clear the in-process voice cache. */
export function __resetVoiceCache(): void {
  voiceCache = null;
}

export async function resolveVoiceId(
  client: HeyGenClient,
  opts: { language: string; gender?: string | null; override?: string | null },
): Promise<string | null> {
  if (opts.override) return opts.override;

  const lang = opts.language;
  const base = lang.split("-")[0].toLowerCase();
  const gender = (opts.gender ?? "female").toLowerCase();

  const curated = CURATED_VOICE_IDS[lang] ?? CURATED_VOICE_IDS[base];
  if (curated) {
    const pick = gender === "male" ? curated.male : curated.female;
    if (pick) return pick;
    if (curated.female || curated.male) return (curated.female ?? curated.male)!;
  }

  let voices: HeyGenVoice[];
  try {
    if (voiceCache && Date.now() - voiceCache.at < VOICE_TTL_MS) {
      voices = voiceCache.voices;
    } else {
      voices = await client.listVoices();
      voiceCache = { at: Date.now(), voices };
    }
  } catch {
    return null;
  }

  const keywords = LANGUAGE_NAME_KEYWORDS[base] ?? [base];
  const matchesLang = (v: HeyGenVoice) => {
    const vl = (v.language ?? "").toLowerCase();
    if (!vl) return false;
    if (vl.includes(lang.toLowerCase()) || vl.startsWith(base) || vl === base) return true;
    return keywords.some((kw) => vl.includes(kw));
  };
  const byGender = voices.filter((v) => matchesLang(v) && (v.gender ?? "").toLowerCase() === gender);
  const anyLang = voices.filter(matchesLang);
  const chosen = byGender[0] ?? anyLang[0];
  return chosen ? chosen.voiceId : null;
}
