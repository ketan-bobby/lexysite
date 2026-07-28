/**
 * ai-consent.ts — Illinois AIVI / EU AI Act consent helpers
 *
 * Single source of truth for:
 *   • the current consent version string
 *   • the disclosure snapshot we show the candidate
 *   • the "do we have active consent?" check the interview /begin gate uses
 *
 * Bump CURRENT_AI_CONSENT_VERSION whenever the disclosure content changes.
 * Existing consent rows remain valid for the version they were captured
 * under, but the /begin gate will require fresh consent under the new
 * version before any new interview can start.
 */
import { db, candidateAiConsentTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

export const CURRENT_AI_CONSENT_VERSION = "ai-interview-2026-06";

export const EVALUATED_TRAITS = [
  "Role-relevant skills and experience as expressed in your resume",
  "Role-relevant skills and experience as expressed during the interview",
  "Clarity and structure of your spoken answers",
  "Demonstrated reasoning on the questions asked",
];

export const NOT_EVALUATED = [
  "Race, ethnicity, or national origin (beyond work authorisation, which you self-report)",
  "Age, religion, sexual orientation",
  "Disability, family or marital status",
  "Gender identity",
  "Accent, pitch, or speech characteristics as a proxy for ability",
  "Facial expressions or any video-based personality inference",
];

export interface DisclosureSnapshot {
  version: string;
  generatedAt: string;
  intendedUse: string;
  modelProviders: string[];
  evaluatedTraits: string[];
  notEvaluated: string[];
  decisionMaker: "human-in-the-loop";
  candidateRights: string[];
  retention: string;
  biometric: {
    identifiersCollected: string[];
    purpose: string;
    retentionSchedule: string;
    notSoldOrShared: string;
  };
}

export function getCurrentDisclosure(): DisclosureSnapshot {
  return {
    version: CURRENT_AI_CONSENT_VERSION,
    generatedAt: new Date().toISOString(),
    intendedUse:
      "Lexy will conduct a structured video / voice interview with you and produce a summary of your answers for the recruiting team. The recruiter, not Lexy, decides whether to advance you in the process.",
    modelProviders: ["OpenAI (GPT-4o family)", "Anthropic (Claude 3.5 Sonnet)"],
    evaluatedTraits: EVALUATED_TRAITS,
    notEvaluated: NOT_EVALUATED,
    decisionMaker: "human-in-the-loop",
    candidateRights: [
      "You may withdraw consent at any time from your candidate portal.",
      "You may request deletion of your interview recording and transcript within 30 days under the Illinois AIVI Act, or at any time under GDPR Article 17 / CCPA.",
      "You may request a copy of your data.",
    ],
    retention:
      "Interview recordings are retained for the duration of the active hiring process plus 12 months for audit purposes, then deleted. Deletion requests are honored within statutory windows.",
    biometric: {
      identifiersCollected: [
        "A scan of your facial geometry and gaze / attention signals captured from your webcam during the proctored interview",
        "A recording of your voice and a video recording of the interview session",
      ],
      purpose:
        "These biometric identifiers and biometric information are collected only to (a) confirm that it is you taking the interview, (b) maintain interview integrity (proctoring), and (c) create a record of your interview for the recruiting team to review. They are NEVER used to infer personality, emotion, demographics, or any protected characteristic.",
      retentionSchedule:
        "Your biometric identifiers and biometric information are permanently destroyed when the initial purpose for collecting them has been satisfied — i.e. when the hiring process concludes — or within 1 year of your last interaction with Lexy, whichever occurs first, in accordance with the Illinois Biometric Information Privacy Act (740 ILCS 14). You may request earlier deletion at any time.",
      notSoldOrShared:
        "Lexy does not sell, lease, trade, or otherwise profit from your biometric data, and does not disclose it to any third party without your consent or as required by law.",
    },
  };
}

/**
 * Returns true if the candidate has an un-revoked consent row for the
 * current consent version. Used by /interviews/:id/begin to gate session
 * minting.
 *
 * Sentinel-ID handling — important for fail-closed semantics:
 *   • `null`/`undefined` candidateId  → false (no candidate to consent).
 *   • `"demo"` sentinel  → exempt ONLY in non-production. This is the
 *     marketing-site demo interview flow; production must never see it.
 *   • `"default"` sentinel  → NEVER exempt. /interviews/start currently
 *     defaults to this string when callers omit candidateId; treating it
 *     as exempt would let any uninitialised real flow bypass consent.
 *     We fail closed and require an explicit candidate row + consent.
 */
export async function hasActiveAiConsent(candidateId: string | null | undefined): Promise<boolean> {
  if (!candidateId) return false;
  if (candidateId === "demo" && process.env.NODE_ENV !== "production") return true;
  const [row] = await db
    .select({ id: candidateAiConsentTable.id })
    .from(candidateAiConsentTable)
    .where(
      and(
        eq(candidateAiConsentTable.candidateId, candidateId),
        eq(candidateAiConsentTable.consentVersion, CURRENT_AI_CONSENT_VERSION),
        isNull(candidateAiConsentTable.revokedAt),
      ),
    )
    .orderBy(desc(candidateAiConsentTable.consentedAt))
    .limit(1);
  return !!row;
}
