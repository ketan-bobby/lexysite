/**
 * external-sourcing.ts — External Candidate Search Adapters
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides four search adapters used by the Sourcing Agent (orchestrator.ts)
 * to discover candidates from external sources, plus an AI-powered scorer.
 *
 * ─── Adapters ────────────────────────────────────────────────────────────────
 *   searchGitHub(ctx)
 *     ONLY runs for software/engineering domains. For non-engineering roles
 *     (medical, finance, legal, sales, etc.) GitHub is skipped because it
 *     produces only noise. Builds a real GitHub search query from
 *     programming-language skills + location.
 *
 *   searchPDL(ctx)
 *     People Data Labs Elasticsearch query. Uses jobTitle + alternateTitles +
 *     skills + location. Requires PDL_API_KEY.
 *
 *   searchSerp(ctx)
 *     SerpAPI Google query for LinkedIn profiles. Uses the ICP-generated
 *     boolean string when available, otherwise builds (alt-titles) AND
 *     (skills | certs | tools) AND (location) NOT (negatives). Parses real
 *     skills from the snippet rather than echoing back the requested skills.
 *
 *   searchEnrichLayer(ctx)
 *     Two-phase: (1) discovers LinkedIn profile URLs via SerpAPI using the
 *     same boolean query, then (2) enriches each URL via Enrich Layer's
 *     /api/v2/profile endpoint to get REAL titles, companies, skills, and
 *     experience. This is the only adapter that returns real candidate
 *     signals for non-engineering roles. Requires ENRICH_LAYER_API_KEY +
 *     SERP_API_KEY.
 *
 * ─── scoreExternalCandidates() ───────────────────────────────────────────────
 * Sends candidates to GPT-4o in one batch and asks it to score each 0–100
 * against the full ICP (including domain, certs, tools, compliance, must-haves,
 * disqualifiers). Merges scores back onto the candidate objects.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/sourcing.ts
 *   lib/agents/orchestrator.ts — _runSourcing() Sourcing Agent handler
 */
import { generateJSON } from "./ai.js";
import { FAIRNESS_DIRECTIVE } from "./fairness.js";
import { logger } from "./logger.js";

/* ── Types ─────────────────────────────────────────────────────────────── */

export interface ExternalCandidate {
  id: string;
  firstName: string;
  lastName: string;
  currentTitle: string;
  currentCompany: string;
  location: string;
  email: string | null;
  githubProfile?: string | null;
  githubLogin?: string;
  linkedinUrl?: string | null;
  publicRepos?: number;
  followers?: number;
  source: "github" | "pdl" | "serp" | "enrichlayer";
  skills: string[];
  rawData?: any;
  matchScore?: number;
  matchReason?: string;
  // Location-relaxation provenance (PDL tiered search). Present when a candidate
  // was surfaced from a widened tier so the UI can be honest ("country-level
  // match"). Absent = exact/unconstrained (no relaxation claim to make).
  locationTier?: "remote" | "city" | "region" | "country" | "global";
  locationTierLabel?: string;
}

/**
 * Unified context passed to every adapter. Built from the job + ICP by
 * routes/sourcing.ts so adapters never have to re-read the ICP.
 */
export interface SearchContext {
  jobTitle: string;
  alternateTitles: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  requiredCertifications: string[];
  toolsAndSystems: string[];
  compliance: string[];
  negativeKeywords: string[];
  domain: string | null;             // "Healthcare", "Software", etc.
  roleFamily: string | null;         // e.g. "Clinical Informatics"
  seniority: string | null;
  location: string;
  // Work arrangement from the JOB record (jobs.work_type enum). Remote roles must
  // NOT be pinned to a physical location during sourcing — that is correctness,
  // not relaxation. null = unknown (treat as located, tiered relaxation applies).
  workType: "remote" | "hybrid" | "onsite" | null;
  booleanSearchString: string | null;
  maxResults: number;
}

/** Returned by adapters so the UI can show what was actually queried. */
export interface AdapterResult {
  candidates: ExternalCandidate[];
  query: string;                  // human-readable query string for UI
  skipped?: string;               // reason this source was skipped, if any
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Run a SerpAPI Google search and return organic_results, or [] on failure. */
async function runSerp(query: string, apiKey: string, num: number): Promise<any[]> {
  try {
    const res = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${num}&api_key=${apiKey}`);
    const text = await res.text();
    if (!res.ok) {
      logger.warn({ status: res.status, body: text.slice(0, 300), query }, "[serp] non-OK response");
      return [];
    }
    let json: any = {};
    try { json = JSON.parse(text); } catch { logger.warn({ body: text.slice(0, 300) }, "[serp] non-JSON response"); return []; }
    if (json.error) { logger.warn({ error: json.error, query }, "[serp] API returned error"); return []; }
    const organic = Array.isArray(json?.organic_results) ? json.organic_results : [];
    if (organic.length === 0) {
      logger.info({ query, search_information: json.search_information }, "[serp] zero organic_results");
    }
    return organic;
  } catch (err: any) {
    logger.warn({ err: err.message, query }, "[serp] fetch threw");
    return [];
  }
}

const PROGRAMMING_LANGUAGES = /^(java|python|typescript|javascript|node|go|golang|rust|ruby|kotlin|swift|scala|php|c\+\+|c#|elixir|erlang|haskell|clojure|dart|r|perl|lua|ocaml|f#|julia|crystal|nim|zig)$/i;

const ENGINEERING_FAMILIES = /software|engineer|developer|backend|frontend|fullstack|devops|sre|platform|infrastructure|data engineer|machine learning|ml|ai engineer|mobile|ios|android|qa|test|security engineer|cloud engineer/i;

function isEngineeringRole(ctx: SearchContext): boolean {
  const haystack = [
    ctx.domain ?? "",
    ctx.roleFamily ?? "",
    ctx.jobTitle,
    ...ctx.alternateTitles,
  ].join(" ").toLowerCase();
  if (/\b(software|engineering|developer|programmer|backend|frontend|devops|sre|infrastructure|data engineer|ml|machine learning|cloud engineer|mobile|ios engineer|android engineer)\b/.test(haystack)) {
    return true;
  }
  // If any required skill is a programming language, treat as engineering.
  if (ctx.requiredSkills.some(s => PROGRAMMING_LANGUAGES.test(s.trim()))) return true;
  return ENGINEERING_FAMILIES.test(ctx.roleFamily ?? "");
}

/** Build a recruiter-style boolean search query from ICP fields. */
export function buildBooleanQuery(ctx: SearchContext): string {
  if (ctx.booleanSearchString && ctx.booleanSearchString.trim().length > 10) {
    return ctx.booleanSearchString.trim();
  }
  const titles = [ctx.jobTitle, ...ctx.alternateTitles].filter(Boolean).slice(0, 5);
  const titleClause = titles.length ? `(${titles.map(t => `"${t}"`).join(" OR ")})` : "";

  const signal = [
    ...ctx.requiredCertifications.slice(0, 4),
    ...ctx.toolsAndSystems.slice(0, 4),
    ...ctx.requiredSkills.slice(0, 4),
  ].filter(Boolean);
  const signalClause = signal.length ? `(${signal.map(s => `"${s}"`).join(" OR ")})` : "";

  const negClause = ctx.negativeKeywords.length
    ? `NOT (${ctx.negativeKeywords.slice(0, 6).map(n => `"${n}"`).join(" OR ")})`
    : "";

  return [titleClause, signalClause, negClause].filter(Boolean).join(" AND ");
}

/* ── GitHub adapter (engineering only) ──────────────────────────────────── */

export async function searchGitHub(ctx: SearchContext): Promise<AdapterResult> {
  if (!isEngineeringRole(ctx)) {
    return { candidates: [], query: "", skipped: "GitHub disabled for non-engineering roles" };
  }

  const langs = ctx.requiredSkills
    .filter(s => PROGRAMMING_LANGUAGES.test(s.trim()))
    .slice(0, 2)
    .map(s => `language:${s.toLowerCase().replace(/\+/g, "%2B")}`)
    .join("+");
  const locQuery = ctx.location ? `+location:${encodeURIComponent(ctx.location.split(",")[0].trim())}` : "";
  const q = `${langs || "type:user"}${locQuery}`;
  const queryStr = `GitHub: ${q}&sort=followers`;

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Lexy-AI-Hiring",
      "Accept": "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

    const searchRes = await fetch(`https://api.github.com/search/users?q=${q}&per_page=${ctx.maxResults}&sort=followers`, { headers });
    if (!searchRes.ok) return { candidates: [], query: queryStr, skipped: `GitHub HTTP ${searchRes.status}` };
    const { items } = await searchRes.json() as any;

    const users = (items || []).slice(0, 8);
    const profiles: any[] = [];
    for (const u of users) {
      await new Promise(r => setTimeout(r, 150));
      try {
        const pr = await fetch(`https://api.github.com/users/${u.login}`, { headers });
        if (pr.ok) profiles.push(await pr.json());
      } catch { /* skip */ }
    }
    const candidates = profiles.map(p => ({
      id: `gh_${p.id}`,
      firstName: p.name?.split(" ")[0] || p.login,
      lastName: p.name?.split(" ").slice(1).join(" ") || "",
      currentTitle: p.bio?.slice(0, 80) || "Software Developer",
      currentCompany: p.company?.replace(/^@/, "") || "",
      // Use the candidate's REAL profile location only. Never fall back to the
      // requested location — faking it here masks out-of-area candidates and
      // defeats the geo flag (classifyLocationMatch) applied downstream.
      location: p.location || "",
      email: p.email || null,
      githubProfile: p.html_url,
      githubLogin: p.login,
      publicRepos: p.public_repos,
      followers: p.followers,
      source: "github" as const,
      skills: ctx.requiredSkills.filter(s => PROGRAMMING_LANGUAGES.test(s)),
      rawData: { login: p.login, avatar_url: p.avatar_url, bio: p.bio, public_repos: p.public_repos, followers: p.followers },
    }));
    return { candidates, query: queryStr };
  } catch (err: any) {
    return { candidates: [], query: queryStr, skipped: `GitHub error: ${err.message}` };
  }
}

/* ── PDL adapter — tiered location relaxation ─────────────────────────────────
 * PDL's person/search lets you pin a candidate's structured location fields.
 * Pinning the CITY as a hard `must` was the single biggest source of zero-result
 * PDL runs:
 *   • Remote roles have no meaningful city at all — pinning one is simply WRONG
 *     (this alone accounts for much of the zero-results, hence "correctness").
 *   • Located roles routinely have strong candidates one town / one state over
 *     that a recruiter absolutely wants to see. "Strong match, one state over"
 *     beats an empty column.
 * So instead of a binary location-on/off, we relax in TIERS: strict city →
 * region/state → country → unconstrained, keeping the TITLE constraints fixed at
 * every tier. Location stops being a hard filter at the wider tiers and becomes a
 * ranking signal — the downstream LLM scorer already scores candidates against
 * the ICP (location included), so it penalises distance rather than letting the
 * query pre-emptively return nobody. Each returned candidate is LABELLED with the
 * tier it matched at (grounded-labels rule) so the match display can be honest.
 *
 * SPEND: each widening step is a SEPARATE PDL person/search call and widens the
 * pool (→ more rows → more downstream enrichment credits per run). Cost control:
 *   1. We STOP at the first tier that clears PDL_MIN_TIER_RESULTS, so a narrow
 *      role never pays for wider queries it didn't need. Worst case (a located
 *      role that keeps coming up short) is 4 search calls: city+region+country+
 *      global — i.e. up to ~4× today's single-call cost for that one run, each
 *      capped at ctx.maxResults rows. Typical case stays at 1 call (tier clears).
 *   2. Every tier is capped at ctx.maxResults rows (same cap as today).
 * KNOWN GAP: there is no per-provider spend-meter row in the schema yet. When it
 * lands, record (tier, resultCount, estimatedCredits) at the return site below.
 */
type PdlTier = "remote" | "city" | "region" | "country" | "global";

const PDL_MIN_TIER_RESULTS = Number(process.env.PDL_MIN_TIER_RESULTS) > 0
  ? Number(process.env.PDL_MIN_TIER_RESULTS)
  : 3;

type PdlLoc = { city?: string; region?: string; country?: string };

/** Split free-text location ("Hyderabad, Telangana, India") into PDL fields. */
function parsePdlLocation(location: string): PdlLoc {
  const parts = (location || "").split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { city: parts[0].toLowerCase() };
  if (parts.length === 2) {
    // "Telangana, India" — first token doubles as city+region guess, last = country.
    return { city: parts[0].toLowerCase(), region: parts[0].toLowerCase(), country: parts[1].toLowerCase() };
  }
  return {
    city: parts[0].toLowerCase(),
    region: parts[parts.length - 2].toLowerCase(),
    country: parts[parts.length - 1].toLowerCase(),
  };
}

function pdlTierLabel(tier: PdlTier, loc: PdlLoc): string {
  switch (tier) {
    case "remote":  return "remote — no location constraint";
    case "city":    return loc.city ? `exact location (${loc.city})` : "exact location";
    case "region":  return loc.region ? `region-level match (${loc.region})` : "region-level match";
    case "country": return loc.country ? `country-level match (${loc.country})` : "country-level match";
    case "global":  return "global — location not constrained";
  }
}

/** Ordered strict→wide tiers for a search context. Remote skips location entirely. */
function buildPdlTiers(ctx: SearchContext): Array<{ tier: PdlTier; loc: PdlLoc; locationMust: any[] }> {
  // Remote is correctness, not relaxation: never pin a physical location.
  if (ctx.workType === "remote") {
    return [{ tier: "remote", loc: {}, locationMust: [] }];
  }
  const loc = parsePdlLocation(ctx.location || "");
  const tiers: Array<{ tier: PdlTier; loc: PdlLoc; locationMust: any[] }> = [];
  if (loc.city)    tiers.push({ tier: "city",    loc, locationMust: [{ match: { "location_locality": loc.city } }] });
  if (loc.region)  tiers.push({ tier: "region",  loc, locationMust: [{ match: { "location_region":  loc.region } }] });
  if (loc.country) tiers.push({ tier: "country", loc, locationMust: [{ term:  { "location_country": loc.country } }] });
  // Always end unconstrained so a located role never returns nobody purely because
  // its location text was unparseable / too specific — scoring penalises distance.
  tiers.push({ tier: "global", loc, locationMust: [] });
  return tiers;
}

export async function searchPDL(ctx: SearchContext): Promise<AdapterResult> {
  const PDL_KEY = process.env.PDL_API_KEY;
  if (!PDL_KEY) return { candidates: [], query: "", skipped: "PDL_API_KEY not set" };

  const titles = [ctx.jobTitle, ...ctx.alternateTitles].filter(Boolean).slice(0, 5);
  // PDL field reference notes:
  //   • `job_title`        — flat string, use `terms` for OR-of-titles
  //   • `skills`           — flat array of strings, use `terms`
  //                          (NOT `skills.name` — that is invalid and 400s)
  //   • `location_locality`— city name (use `match`)
  //   • `location_region`  — state/region name (use `match`)
  //   • `location_country` — country name (use `term`)
  // We use `should` for skills so missing skill matches don't kill the query.
  const titleMust: any[] = [];
  if (titles.length) titleMust.push({ terms: { "job_title": titles.map(t => t.toLowerCase()) } });

  const should: any[] = [];
  if (ctx.requiredSkills.length) {
    // Tokenize skills into individual words/phrases — PDL skills are short
    // canonical strings ("ecmo", "critical care") not long phrases ("ECMO management").
    const tokens = Array.from(new Set(
      ctx.requiredSkills
        .flatMap(s => s.toLowerCase().split(/[\s/,]+/))
        .filter(s => s.length >= 3),
    )).slice(0, 10);
    if (tokens.length) should.push({ terms: { "skills": tokens } });
  }

  const must_not: any[] = [];
  if (ctx.negativeKeywords.length) {
    must_not.push({ terms: { "job_title": ctx.negativeKeywords.slice(0, 6).map(n => n.toLowerCase()) } });
  }

  const tiers = buildPdlTiers(ctx);
  const attempts: Array<{ tier: PdlTier; count: number }> = [];
  let lastQueryStr = "";

  for (let i = 0; i < tiers.length; i++) {
    const { tier, loc, locationMust } = tiers[i];
    const isLast = i === tiers.length - 1;
    const label = pdlTierLabel(tier, loc);

    const bool: any = { must: [...titleMust, ...locationMust], must_not };
    if (should.length) bool.should = should;
    const body = { query: { bool }, size: ctx.maxResults };
    const locStr = tier === "remote" || tier === "global"
      ? "(none)"
      : (tier === "country" ? loc.country : tier === "region" ? loc.region : loc.city) || ctx.location;
    const queryStr = `PDL[${tier}]: titles=[${titles.join(", ")}] skills=[${ctx.requiredSkills.slice(0, 5).join(", ")}] loc=${locStr}`;
    lastQueryStr = queryStr;

    try {
      const res = await fetch("https://api.peopledatalabs.com/v5/person/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": PDL_KEY },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        logger.warn({ status: res.status, tier, body: errText.slice(0, 300), query: queryStr }, "[pdl] non-OK response");
        attempts.push({ tier, count: 0 });
        if (isLast) return { candidates: [], query: queryStr, skipped: `PDL HTTP ${res.status}: ${errText.slice(0, 120)}` };
        continue; // widen to the next tier
      }
      const { data } = await res.json() as any;
      const rows: any[] = Array.isArray(data) ? data : [];
      attempts.push({ tier, count: rows.length });

      // Return as soon as a tier clears the threshold — or on the final tier,
      // return whatever it produced (even if short) so we never throw away rows.
      if (rows.length >= PDL_MIN_TIER_RESULTS || isLast) {
        const candidates: ExternalCandidate[] = rows.map((p: any) => ({
          id: `pdl_${p.id}`,
          firstName: p.first_name || p.full_name?.split(" ")[0] || "Unknown",
          lastName: p.last_name || p.full_name?.split(" ").slice(1).join(" ") || "",
          currentTitle: p.job_title || "",
          currentCompany: p.job_company_name || "",
          location: p.location_name || "",
          email: p.work_email || p.personal_emails?.[0] || null,
          linkedinUrl: p.linkedin_url ? (p.linkedin_url.startsWith("http") ? p.linkedin_url : `https://${p.linkedin_url}`) : null,
          githubProfile: p.github_url || null,
          source: "pdl" as const,
          // PDL skills field is a flat array of strings.
          skills: Array.isArray(p.skills)
            ? p.skills.map((s: any) => typeof s === "string" ? s : s?.name).filter(Boolean)
            : [],
          // Grounded tier label — surfaced in the UI so a recruiter knows a
          // candidate came from a relaxed (e.g. country-level) match.
          locationTier: tier,
          locationTierLabel: label,
          rawData: { ...p, locationTier: tier, locationTierLabel: label },
        }));
        // SPEND NOTE (known gap: no meter row yet): log the full tier walk so the
        // credit cost of relaxation is observable until a real meter exists.
        logger.info(
          { tier, count: candidates.length, tiersTried: attempts, minTier: PDL_MIN_TIER_RESULTS, query: queryStr },
          "[pdl] search returned (tiered)",
        );
        return { candidates, query: `${queryStr} · ${label}` };
      }

      logger.info({ tier, count: rows.length, minTier: PDL_MIN_TIER_RESULTS }, "[pdl] tier below threshold — widening");
    } catch (err: any) {
      logger.warn({ err: err.message, tier, query: queryStr }, "[pdl] fetch threw");
      attempts.push({ tier, count: 0 });
      if (isLast) return { candidates: [], query: queryStr, skipped: `PDL error: ${err.message}` };
      // fall through to the next tier
    }
  }

  return { candidates: [], query: lastQueryStr, skipped: "PDL returned no candidates across all location tiers" };
}

/* ── SERP adapter ────────────────────────────────────────────────────────── */

/**
 * Parse plausible skills/keywords out of a search result snippet — used so
 * SERP candidates carry SOMETHING real instead of echoing back the requested
 * skills (which made every SERP result look like a perfect match).
 */
function extractSkillsFromSnippet(snippet: string, knownPool: string[]): string[] {
  if (!snippet) return [];
  const lower = snippet.toLowerCase();
  return knownPool.filter(k => k && lower.includes(k.toLowerCase())).slice(0, 8);
}

export async function searchSerp(ctx: SearchContext): Promise<AdapterResult> {
  const SERP_KEY = process.env.SERP_API_KEY || process.env.SERPAPI_KEY;
  const boolean = buildBooleanQuery(ctx);
  const locClause = ctx.location ? ` "${ctx.location.split(",")[0].trim()}"` : "";
  const fullQuery = `site:linkedin.com/in ${boolean}${locClause}`;
  const queryStr = `SERP: ${fullQuery}`;

  if (!SERP_KEY) {
    // No SERP key — produce simulated profiles, but tag clearly as simulated.
    try {
      const result = await generateJSON<any>(
        `Simulate web search results for these candidates. Return ${ctx.maxResults} REALISTIC LinkedIn-style profiles for:
Domain: ${ctx.domain || "Unknown"}
Job Title: ${ctx.jobTitle}
Alternate titles: ${ctx.alternateTitles.join(", ")}
Required skills: ${ctx.requiredSkills.join(", ")}
Required certifications: ${ctx.requiredCertifications.join(", ")}
Tools & systems: ${ctx.toolsAndSystems.join(", ")}
Location: ${ctx.location}
Negative keywords (exclude): ${ctx.negativeKeywords.join(", ")}

Return JSON: { "candidates": [{ "firstName": string, "lastName": string, "currentTitle": string, "currentCompany": string, "location": string, "skills": string[], "linkedinUrl": string, "summary": string }] }`,
        "Generate domain-appropriate candidate profiles. NEVER return software developers for medical, finance, or legal roles. Match the requested domain. JSON only.",
      );
      const candidates = (result?.candidates || []).map((c: any, i: number) => ({
        ...c,
        id: `serp_sim_${Date.now()}_${i}`,
        source: "serp" as const,
        email: null,
        skills: Array.isArray(c.skills) ? c.skills : [],
        rawData: { simulated: true, summary: c.summary },
      }));
      return { candidates, query: `${queryStr} (SIMULATED — no SERP_API_KEY)` };
    } catch (err: any) {
      return { candidates: [], query: queryStr, skipped: `SERP simulation error: ${err.message}` };
    }
  }

  try {
    // Phase 1: try the rich boolean query first.
    let organic = await runSerp(fullQuery, SERP_KEY, ctx.maxResults);

    // Phase 2 fallback: if the rich query is too narrow (often happens when the
    // job title is an obscure abbreviation like "OCS Specialist" with no
    // alternateTitles), retry with a much broader query — title-only plus
    // location, no signal/negative clauses.
    if (organic.length === 0) {
      const broadTitles = [ctx.jobTitle, ...ctx.alternateTitles].filter(Boolean).slice(0, 5);
      const titleClause = broadTitles.length
        ? `(${broadTitles.map(t => `"${t}"`).join(" OR ")})`
        : `"${ctx.jobTitle}"`;
      const broadQuery = `site:linkedin.com/in ${titleClause}${locClause}`;
      logger.info({ jobId: ctx.jobTitle, fallbackQuery: broadQuery }, "[serp] strict query returned 0, retrying broader");
      organic = await runSerp(broadQuery, SERP_KEY, ctx.maxResults);
    }

    const skillPool = [
      ...ctx.requiredSkills,
      ...ctx.preferredSkills,
      ...ctx.requiredCertifications,
      ...ctx.toolsAndSystems,
    ];

    const candidates = (organic || []).map((r: any, i: number) => {
      const title = r.title || "";
      const snippet = r.snippet || "";
      // LinkedIn result titles look like: "Jane Doe - Senior Clinical Informaticist - Mass General | LinkedIn"
      const cleaned = title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
      const parts = cleaned.split(/\s+-\s+/);
      const nameParts = (parts[0] || "").split(" ");
      const realSkills = extractSkillsFromSnippet(`${title} ${snippet}`, skillPool);
      return {
        id: `serp_${i}_${Date.now()}`,
        firstName: nameParts[0] || "Unknown",
        lastName: nameParts.slice(1).join(" ") || "",
        currentTitle: parts[1] || ctx.jobTitle,
        currentCompany: parts[2] || "",
        // A Google/LinkedIn search snippet does not reliably expose the real
        // profile location, so leave it BLANK rather than stamping the requested
        // location (which previously made every SERP result falsely appear
        // in-region). Enrichment fills the real location when available.
        location: "",
        email: null,
        linkedinUrl: r.link,
        source: "serp" as const,
        skills: realSkills,           // real signal extracted from snippet, not the requested skills
        rawData: { snippet, position: r.position, displayed_link: r.displayed_link },
      };
    });
    return { candidates, query: queryStr };
  } catch (err: any) {
    return { candidates: [], query: queryStr, skipped: `SERP error: ${err.message}` };
  }
}

/* ── EnrichLayer adapter ─────────────────────────────────────────────────── */

interface EnrichLayerProfile {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  headline?: string;
  occupation?: string;
  city?: string;
  country?: string;
  experiences?: Array<{
    title?: string;
    company?: string;
    location?: string;
    description?: string;
  }>;
  skills?: Array<string | { name?: string }>;
  certifications?: Array<{ name?: string; authority?: string }>;
}

async function enrichOneProfile(linkedinUrl: string, apiKey: string): Promise<EnrichLayerProfile | null> {
  const url = `https://enrichlayer.com/api/v2/profile?url=${encodeURIComponent(linkedinUrl)}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200), linkedinUrl }, "[enrichlayer] profile enrich non-OK");
      return null;
    }
    return await res.json() as EnrichLayerProfile;
  } catch (err: any) {
    logger.warn({ err: err?.message, linkedinUrl }, "[enrichlayer] profile enrich threw");
    return null;
  } finally {
    clearTimeout(tid);
  }
}

/**
 * EnrichLayer-as-enricher.
 *
 * Background: EnrichLayer's `/api/v2/search/person` endpoint is capped to
 * 10 credits per call on trial accounts AND rejects ANY filter param (e.g.
 * `current_role_title`) with HTTP 403, making the native search effectively
 * unusable until the account is upgraded. So instead of doing our own
 * filtered search, we accept a list of LinkedIn URLs from upstream sources
 * (e.g. PDL, SerpAPI) and just call the enrichment endpoint, which is not
 * trial-capped.
 *
 * If `seedUrls` is empty/omitted, the adapter is a no-op (skipped).
 */
export async function searchEnrichLayer(ctx: SearchContext, seedUrls: string[] = []): Promise<AdapterResult> {
  const apiKey = process.env.ENRICH_LAYER_API_KEY;
  const queryStr = `EnrichLayer enrich: ${seedUrls.length} URL(s) from upstream sources`;

  if (!apiKey) return { candidates: [], query: queryStr, skipped: "ENRICH_LAYER_API_KEY not set" };

  // Dedupe seeds, but DON'T cap input — failures (stale/bad URLs) are common
  // so we want to keep walking the seed list until either output cap is hit
  // or we run out of seeds.
  const ENRICH_CAP = Math.min(ctx.maxResults, 6);
  const seen = new Set<string>();
  const linkedinUrls: string[] = [];
  for (const u of seedUrls) {
    if (!u) continue;
    const normalized = u.startsWith("http") ? u : `https://${u}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    linkedinUrls.push(normalized);
  }

  try {
    if (linkedinUrls.length === 0) {
      return { candidates: [], query: queryStr, skipped: "EnrichLayer skipped — no upstream LinkedIn URLs to enrich" };
    }

    const enriched: ExternalCandidate[] = [];
    for (const url of linkedinUrls) {
      if (enriched.length >= ENRICH_CAP) break;
      const p = await enrichOneProfile(url, apiKey);
      if (!p) continue;
      const latest = p.experiences?.[0];
      const skills = (p.skills || [])
        .map((s: any) => typeof s === "string" ? s : s?.name)
        .filter((x: any): x is string => !!x);
      const certs = (p.certifications || []).map(c => c.name).filter(Boolean) as string[];
      enriched.push({
        id: `el_${Buffer.from(url).toString("base64").slice(0, 24)}`,
        firstName: p.first_name || p.full_name?.split(" ")[0] || "Unknown",
        lastName: p.last_name || p.full_name?.split(" ").slice(1).join(" ") || "",
        currentTitle: latest?.title || p.occupation || p.headline || "",
        currentCompany: latest?.company || "",
        location: [p.city, p.country].filter(Boolean).join(", ") || "",
        email: null,
        linkedinUrl: url,
        source: "enrichlayer" as const,
        skills: [...skills, ...certs].slice(0, 20),
        rawData: { headline: p.headline, occupation: p.occupation, experiences: p.experiences?.slice(0, 3), certifications: certs },
      });
    }

    return { candidates: enriched, query: queryStr };
  } catch (err: any) {
    return { candidates: [], query: queryStr, skipped: `EnrichLayer error: ${err.message}` };
  }
}

/* ── AI Scoring ──────────────────────────────────────────────────────────── */

/* ── Location matching ───────────────────────────────────────────────────────
 *
 * Geo classifier used to KEEP-but-FLAG out-of-area candidates.
 * Policy (per recruiter decision): a candidate is a location match if they are
 * in the target region OR within ~100 miles of it. Being remote / open to
 * relocation no longer auto-qualifies. Only candidates with a real location
 * beyond the radius are flagged; candidates with no known location are kept
 * unflagged ("unknown") rather than guessed.
 */
export type LocationMatch = "region" | "near" | "out_of_area" | "unknown";
export const OUT_OF_AREA_FLAG = "Outside target location";
// A candidate counts as a match if their location is within this radius of the
// ICP's target location. Being "remote"/"open to relocation" does NOT qualify —
// only actual geographic proximity does (per recruiter decision).
export const LOCATION_RADIUS_MILES = 100;

// Generic geo words that must not drive a false region match on their own.
const GEO_STOPWORDS = new Set([
  "city", "town", "of", "the", "area", "greater", "region", "metro",
  "metropolitan", "district", "and", "county", "province", "state",
]);

function locTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[,/|;·•\-–—()]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !GEO_STOPWORDS.has(t));
}

/**
 * Classify a batch of candidates' locations against the ICP's target location.
 * Policy (per recruiter decision):
 *  - "region"      — candidate location overlaps the target (same city/metro/etc.)
 *  - "near"        — candidate is within ~LOCATION_RADIUS_MILES of the target
 *  - "out_of_area" — candidate has a real location beyond that radius → FLAGGED
 *  - "unknown"     — no target set, or candidate has no usable location signal
 * Being explicitly remote / open to relocation no longer auto-qualifies.
 *
 * Exact-region overlap is decided deterministically (token match). Everything
 * with a real, non-overlapping location is checked for ~100-mile proximity via
 * the model in ONE batched call (no geocoding service is configured). If that
 * call fails we DO NOT flag — we keep the candidate visible & unflagged rather
 * than risk a wrong "outside target" badge.
 */
export async function classifyLocationMatches(
  items: { id: string; location?: string | null }[],
  targetLocation: string | null | undefined,
): Promise<Map<string, { match: LocationMatch; flag: string | null }>> {
  const out = new Map<string, { match: LocationMatch; flag: string | null }>();
  const target = locTokens(targetLocation);

  // No target set → no location preference; nothing is flagged.
  if (target.length === 0) {
    for (const it of items) out.set(it.id, { match: "unknown", flag: null });
    return out;
  }

  const needsRadiusCheck: { id: string; location: string }[] = [];
  for (const it of items) {
    const cand = locTokens(it.location);
    if (cand.length === 0) {
      out.set(it.id, { match: "unknown", flag: null }); // no signal → kept, unflagged
      continue;
    }
    const overlap = cand.some(c => target.some(t => c === t || c.includes(t) || t.includes(c)));
    if (overlap) out.set(it.id, { match: "region", flag: null });
    else needsRadiusCheck.push({ id: it.id, location: (it.location || "").trim() });
  }

  if (needsRadiusCheck.length === 0) return out;

  try {
    const result = await generateJSON<{ results?: { id: string; withinRadius?: boolean }[] }>(
      `Target location: "${(targetLocation || "").trim()}".
For each candidate location below, decide whether it is within about ${LOCATION_RADIUS_MILES} miles of the target location, using real-world geography (nearby cities, suburbs and the same metro area count as within radius; a different state/country far away does not).

Candidates: ${JSON.stringify(needsRadiusCheck)}

Return JSON: { "results": [ { "id": string, "withinRadius": boolean } ] }`,
      `You are a geography assistant. Judge the physical distance between places. Respond with JSON only.`,
    );
    // Only trust an EXPLICIT boolean. If the model omits an id (partial output),
    // leave that candidate unflagged ("unknown") — never guess out-of-area.
    const within = new Map(
      (result?.results || [])
        .filter(r => r && typeof r.id === "string" && typeof r.withinRadius === "boolean")
        .map(r => [r.id, r.withinRadius as boolean]),
    );
    for (const it of needsRadiusCheck) {
      if (!within.has(it.id)) {
        out.set(it.id, { match: "unknown", flag: null });
      } else {
        out.set(it.id, within.get(it.id)
          ? { match: "near", flag: null }
          : { match: "out_of_area", flag: OUT_OF_AREA_FLAG });
      }
    }
  } catch {
    // Proximity undeterminable → honest "unknown" (kept, unflagged), never a guess.
    for (const it of needsRadiusCheck) out.set(it.id, { match: "unknown", flag: null });
  }
  return out;
}

export async function scoreExternalCandidates(
  candidates: ExternalCandidate[],
  icp: {
    jobTitle?: string;
    domain?: string | null;
    requiredSkills?: string[];
    requiredCertifications?: string[];
    toolsAndSystems?: string[];
    seniority?: string | null;
    mustHaves?: string[];
    disqualifiers?: string[];
    negativeKeywords?: string[];
    location?: string | null;
  },
): Promise<ExternalCandidate[]> {
  if (candidates.length === 0) return [];

  const icpSummary = {
    jobTitle: icp.jobTitle,
    domain: icp.domain,
    requiredSkills: icp.requiredSkills,
    requiredCertifications: icp.requiredCertifications,
    toolsAndSystems: icp.toolsAndSystems,
    seniority: icp.seniority,
    mustHaves: icp.mustHaves,
    disqualifiers: icp.disqualifiers,
    negativeKeywords: icp.negativeKeywords,
    location: icp.location ?? null,
  };

  const candPayload = candidates.map(c => ({
    id: c.id,
    title: c.currentTitle,
    company: c.currentCompany,
    skills: c.skills,
    location: c.location,
    bio: c.rawData?.bio || c.rawData?.headline,
    experiences: c.rawData?.experiences,
    followers: c.followers,
    repos: c.publicRepos,
    source: c.source,
  }));

  try {
    const result = await generateJSON<any>(
      `Score each candidate 0-100 against this ICP.

CRITICAL: This ICP is for the "${icp.domain ?? "Unknown"}" domain. If a candidate is from a clearly different domain (e.g. a software developer for a clinical role, or vice-versa), score 0-15. Match the candidate's TITLE and EXPERIENCE to the ICP domain first, skills second.

Penalize heavily if:
- Candidate's title contains any negative keyword
- Candidate matches any disqualifier
- Candidate is from a wrong domain

Judge the substance and relevance of experience, NOT the prestige/brand of the employer/company, follower counts, or repository counts (popularity is not competence).

LOCATION: The ICP's target location is in the "location" field. Favor candidates in that region or within ~100 miles of it, but do NOT zero out an otherwise-strong candidate solely for being outside it. Apply at most a small adjustment for location; skills and domain fit dominate.

ICP: ${JSON.stringify(icpSummary)}

Candidates: ${JSON.stringify(candPayload)}

Return JSON: { "scores": [{ "candidateId": string, "score": number, "reason": string }] }`,
      `Score candidates against the ICP. Be domain-strict — wrong-domain candidates score very low. JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
    );
    const scoreMap = new Map((result?.scores || []).map((s: any) => [s.candidateId, s]));
    return candidates.map(c => ({
      ...c,
      matchScore: (scoreMap.get(c.id) as any)?.score ?? 50,
      matchReason: (scoreMap.get(c.id) as any)?.reason ?? "",
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "[scoreExternalCandidates] AI scoring failed; defaulting to 50");
    return candidates.map(c => ({ ...c, matchScore: 50, matchReason: "AI scoring unavailable" }));
  }
}
