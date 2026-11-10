/**
 * Opt-in live provider audit. Uses synthetic speech only: no sessions, candidates,
 * emails or OTPs. Short generation + TTS + STT checks for every offered locale.
 * Run: pnpm exec tsx scripts/audit-interview-languages.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { SUPPORTED_LANGUAGES, chatCompletionWithAI } from "../src/lib/ai";
import { transcribeAudio } from "../src/lib/transcribe";
import { logger } from "../src/lib/logger";

const out = process.env.LANGUAGE_AUDIT_OUTPUT || "/tmp/lexy-language-audit";
mkdirSync(out, { recursive: true });
const rows: Array<Record<string, unknown>> = [];
const languages = Object.entries(SUPPORTED_LANGUAGES).filter(
  ([code, meta]) =>
    !meta.hidden &&
    (!process.env.LANGUAGE_AUDIT_CODES ||
      process.env.LANGUAGE_AUDIT_CODES.split(",").includes(code)),
);
const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;

async function audit(code: string, label: string) {
  const row: Record<string, unknown> = { code, label };
  try {
    const text = await chatCompletionWithAI(
      [
        {
          role: "system",
          content: `Translate the sentence into ${label}, using the native writing system and local dialect. Output only the translation, no explanation or quotation marks.`,
        },
        {
          role: "user",
          content:
            "I have five years of experience in software development and I enjoy working with a team.",
        },
      ],
      code,
      { maxTokens: 160, temperature: 0 },
    );
    row.text = text.trim();
    row.llm = text.trim() ? "responded" : "empty";
    const response = await fetch(`${base}/api/interviews/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: code }),
      signal: AbortSignal.timeout(40000),
    });
    row.ttsStatus = response.status;
    row.contentType = response.headers.get("content-type");
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    row.audioBytes = audio.length;
    if (!audio.length || !response.headers.get("content-type")?.startsWith("audio/"))
      throw new Error("TTS did not return audio");
    writeFileSync(`${out}/${code}.mp3`, audio);
    const stt = await transcribeAudio({
      buf: audio,
      contentType: "audio/mpeg",
      rawLang: code,
    });
    row.sttProvider = stt.provider;
    row.transcript = stt.transcript;
    row.stt = stt.transcript.trim() ? "responded" : "empty";
    row.status = stt.transcript.trim() ? "transport_pass" : "needs_review";
    // Transport checks are NOT an accent, human comprehension, or quality certification.
  } catch (err) {
    row.status = "failed";
    row.error = err instanceof Error ? err.message.slice(0, 180) : "Provider failed";
  }
  rows.push(row);
  writeFileSync(`${out}/results.json`, JSON.stringify(rows, null, 2));
  logger.info(
    { code, status: row.status, stt: row.sttProvider, tts: row.ttsStatus },
    "Language audit",
  );
}

async function main() {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (cursor < languages.length) {
        const [code, meta] = languages[cursor++];
        await audit(code, meta.label);
      }
    }),
  );
  logger.info(
    { tested: rows.length, failed: rows.filter((r) => r.status !== "transport_pass").length, out },
    "Language audit complete",
  );
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
