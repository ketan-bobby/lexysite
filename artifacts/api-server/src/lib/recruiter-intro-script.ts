/**
 * lib/recruiter-intro-script.ts — Auto-generated recruiter intro scripts
 *
 * Generates a short (20-30s) recruiter welcome written DIRECTLY in the
 * candidate's language via the existing AI layer (no separate translation step),
 * always ending with a handoff to Lexy. If the LLM is unavailable or returns
 * nothing usable, falls back to the deterministic English template so a render
 * is never blocked.
 */
import { generateWithAI, resolveLangMeta } from "./ai";
import { logger } from "./logger";
import {
  buildIntroScriptTemplate,
  hashScriptContext,
  type GeneratedIntroScript,
  type IntroScriptContext,
} from "./recruiter-intro-core";

export type { GeneratedIntroScript, IntroScriptContext };

interface ScriptDeps {
  generate?: typeof generateWithAI;
}

export async function generateIntroScript(
  ctx: IntroScriptContext,
  profileId: string,
  jobId: string | null,
  deps: ScriptDeps = {},
): Promise<GeneratedIntroScript> {
  const scriptHash = hashScriptContext(ctx, profileId, jobId);
  const fallback = buildIntroScriptTemplate(ctx);
  const gen = deps.generate ?? generateWithAI;
  let scriptText = fallback;

  try {
    const meta = resolveLangMeta(ctx.language);
    const system =
      `You write a short spoken intro for a recruiter greeting a candidate just before an AI-led interview. ` +
      `Constraints: 20-30 seconds when spoken aloud (about 55-75 words); ${ctx.tone ?? "warm_professional"}, ` +
      `candidate-friendly and reassuring; first person as the recruiter; no bullet points or stage directions; ` +
      `warmly THANK the candidate for connecting with you and for taking the time to speak with the team, ` +
      `and also thank them for spending this time speaking with "Lexy"; ` +
      `write ENTIRELY in ${meta.label} (${meta.nativeName}); you MUST end by handing off to "Lexy", who will run ` +
      `the interview. Output only the spoken words.`;
    const prompt =
      `Recruiter: ${ctx.recruiterName}${ctx.recruiterTitle ? `, ${ctx.recruiterTitle}` : ""}\n` +
      `Company: ${ctx.companyName}\n` +
      `Role: ${ctx.roleTitle ?? "(unspecified)"}\n` +
      `Write the intro now.`;
    const out = (await gen(prompt, system, ctx.language, { maxTokens: 300 }))?.trim();
    if (out && out.length > 10) scriptText = out;
  } catch (err) {
    logger.warn({ err }, "[recruiter-intro] LLM script generation failed — using template fallback");
  }

  return { scriptText, scriptHash, language: ctx.language, sourceLanguage: "en-US" };
}
