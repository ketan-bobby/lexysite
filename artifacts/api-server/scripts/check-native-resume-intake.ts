/**
 * Explicit live native résumé upload/attachment check, not a bulk import.
 * Fresh fictional unlinked candidate only. Never retry an uncertain attachment.
 * No candidate contact, job assessment or changes to existing pilot records.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { dbAdmin, pool, candidatesTable, usersTable, applicationsTable } from "@workspace/db";
import { issueToken, SESSION_COOKIE_NAME } from "../src/lib/auth-token";
import { restrictToRealCandidates } from "../src/lib/synthetic-fixture-scope";

const pdf = process.argv.includes("--pdf");
const accessCheck = process.argv.includes("--access-check");
const taggingRecheck = process.argv.includes("--storage-tagging-recheck");
const journalPath = accessCheck
  ? `/tmp/native-resume-access-${pdf ? "pdf" : "docx"}-20261010${taggingRecheck ? "-tagging-check" : ""}.json`
  : pdf
    ? "/tmp/native-resume-intake-pdf-20261010.json"
    : "/tmp/native-resume-intake-20261010.json";
const tenantId = "evidence_ui_8f1d510f-96c9-4b0c-83dc-cd1b65c0f1c3";

async function main() {
  const [actor] = await dbAdmin
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.tenantId, tenantId),
        eq(usersTable.role, "tenant_admin"),
        eq(usersTable.status, "active"),
      ),
    );
  assert.ok(actor?.id.startsWith("evidence_ui_"), "Require the active isolated reviewer.");
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Use the development environment owning the fixture.");
  const document = await readFile(`/tmp/native-resume-intake.${pdf ? "pdf" : "docx"}`);
  assert.equal(
    document.subarray(0, pdf ? 4 : 2).toString(),
    pdf ? "%PDF" : "PK",
    "Require the prepared fictional résumé file.",
  );
  if (!process.argv.includes("--execute")) {
    console.log(
      JSON.stringify({ prerequisitesPassed: true, execute: false, contactEnabled: false }),
    );
    return;
  }
  let candidateId = `${tenantId}_resume_${randomUUID()}`;
  let journal = { candidateId, tenantId, stage: "prepared", objectPath: null as string | null };
  // Create-once prevents accidental replay of an unknown paid parser outcome.
  if (process.argv.includes("--resume-preparation")) {
    const saved = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(saved.tenantId, tenantId);
    assert.equal(saved.stage, "prepared", "Never resume an attempted upload or attachment.");
    assert.equal(saved.objectPath, null);
    assert.ok(String(saved.candidateId).startsWith(`${tenantId}_resume_`));
    const existing = await dbAdmin
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, saved.candidateId));
    assert.equal(existing.length, 0, "Only an insert that never took effect can be resumed.");
    candidateId = saved.candidateId;
    journal = saved;
  } else {
    await writeFile(journalPath, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  }
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    firstName: "Synthetic",
    lastName: "Resume Fixture",
    email: `resume-fixture-${candidateId}@example.invalid`,
    skills: ["Manual fixture skill"],
    source: "manual",
    pool: "tenant",
    verificationResult: {
      syntheticFixture: { kind: "staff_inbox", purpose: "isolated_resume_intake_check" },
    },
  });
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}/api`;
  const token = issueToken({ userId: actor.id, role: actor.role, tenantId });
  async function request(path: string, method = "GET", body?: FormData | object) {
    const multipart = body instanceof FormData;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(!multipart && body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(150_000),
    });
    assert.ok(
      response.ok,
      `Native résumé check failed (${response.status}); do not retry blindly.`,
    );
    return response.json();
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(document)], {
      type: pdf
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    `synthetic-resume.${pdf ? "pdf" : "docx"}`,
  );
  journal.stage = "upload_claimed";
  await writeFile(journalPath, JSON.stringify(journal));
  const uploaded = await request("/storage/uploads/file", "POST", form);
  assert.match(uploaded.objectPath, /^\/objects\/resumes\//);
  journal.objectPath = uploaded.objectPath;
  journal.stage = "attachment_claimed";
  await writeFile(journalPath, JSON.stringify(journal));
  const attached = await request(`/candidates/${candidateId}/resume`, "POST", {
    objectPath: uploaded.objectPath,
  });
  const reloaded = await request(`/candidates/${candidateId}`);
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, tenantId)));
  assert.ok(candidate, "Fresh fixture must still exist.");
  assert.equal(candidate.resumeUrl, uploaded.objectPath);
  assert.equal(candidate.source, "manual", "Resume enrichment must not rewrite provenance.");
  assert.ok(candidate.skills.includes("Manual fixture skill"), "Preserve manually entered skills.");
  assert.ok(
    candidate.skills.some((skill) => /postgres/i.test(skill)),
    "Persist extracted PostgreSQL.",
  );
  assert.ok(
    candidate.skills.some((skill) => /\bsql\b/i.test(skill)),
    "Persist extracted SQL.",
  );
  assert.deepEqual(
    attached.skills,
    candidate.skills,
    "Attachment response must expose merged skills.",
  );
  assert.deepEqual(reloaded.skills, candidate.skills, "A fresh read must expose saved skills.");
  assert.equal(reloaded.resumeUrl, candidate.resumeUrl);
  const linked = await dbAdmin
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(eq(applicationsTable.candidateId, candidateId));
  assert.equal(linked.length, 0, "No job linkage or automatic job assessment.");
  const real = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, candidateId), restrictToRealCandidates(candidatesTable.id)));
  assert.equal(real.length, 0, "Fictional résumé must stay excluded from real hiring statistics.");
  const downloadPath = `${base}/storage${uploaded.objectPath}`;
  const download = await fetch(downloadPath, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status, 200, "The real authenticated download must work.");
  assert.deepEqual(
    Buffer.from(await download.arrayBuffer()),
    document,
    "Download must preserve every file byte.",
  );
  assert.match(download.headers.get("cache-control") ?? "", /private/);
  assert.match(download.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await fetch(downloadPath)).status, 401, "Anonymous download must be denied.");
  const cookieDownload = await fetch(downloadPath, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(
    cookieDownload.status,
    200,
    "The UI's ordinary cookie-authenticated link must work.",
  );
  assert.deepEqual(Buffer.from(await cookieDownload.arrayBuffer()), document);
  await dbAdmin
    .update(candidatesTable)
    .set({ doNotContact: true })
    .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, tenantId)));
  assert.equal(
    (await fetch(downloadPath, { headers: { Authorization: `Bearer ${token}` } })).status,
    403,
    "Current privacy state must revoke even the uploader's bound-file access.",
  );
  journal.stage = "verified";
  await writeFile(journalPath, JSON.stringify(journal));
  console.log(
    JSON.stringify(
      {
        status: "passed",
        scope: "Native staff upload and attachment, not machine-to-machine bulk import",
        format: pdf ? "PDF" : "DOCX",
        uploadedAndPersisted: true,
        savedSkillsVisibleInResponseAndFreshRead: true,
        manualSkillsAndProvenancePreserved: true,
        fictionalProfileExcludedFromRealHiringStatistics: true,
        fixtureDoNotContact: true,
        jobLinks: 0,
        modelsOrPromptsChanged: false,
        candidateEmailsSent: 0,
        actualDollarCost: null,
        limitations: ["No bulk-import, browser download, or assessment proof is claimed."],
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
