import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as tables from "@workspace/db";
import { createTransactionalDb } from "../test-fixtures/transactional-db";

let fixture: Awaited<ReturnType<typeof createTransactionalDb>>;
let enrich: typeof import("./enrich-candidate");
let readiness: typeof import("./workflow-profile-screening");
let output: Record<string, unknown> = {};
let extractionCalls = 0;
const tenantId = `resume_handoff_${randomUUID()}`;

before(async () => {
  fixture = await createTransactionalDb([tables.tenantsTable, tables.candidatesTable]);
  await fixture.db.insert(tables.tenantsTable).values({
    id: tenantId,
    name: "Isolated resume handoff",
    slug: tenantId,
  });
  const ai = await import("./ai.js");
  const storage = await import("./objectStorage.js");
  mock.module(new URL("./ai.js", import.meta.url).href, {
    namedExports: {
      ...ai,
      generateJSON: async () => {
        extractionCalls++;
        return output;
      },
    },
  });
  mock.module(new URL("./objectStorage.js", import.meta.url).href, {
    namedExports: {
      ...storage,
      ObjectStorageService: class {
        async getObjectEntityFile(path: string) {
          return path;
        }
        async downloadObject() {
          return new Response(
            "FICTIONAL TEST RESUME. Synthetic engineer with SQL and TypeScript skills. This substituted storage document is not a real person or independent verification.",
          );
        }
      },
    },
  });
  enrich = await import("./enrich-candidate");
  readiness = await import("./workflow-profile-screening");
});
after(async () => {
  await fixture?.close();
});

async function candidate(skills: string[] = []) {
  const id = randomUUID();
  const [row] = await fixture.db
    .insert(tables.candidatesTable)
    .values({
      id,
      tenantId,
      firstName: "Synthetic",
      lastName: "Resume",
      email: `${id}@example.invalid`,
      skills,
      currentTitle: null,
      source: "manual",
      resumeUrl: "/objects/fictional-resume.txt",
    })
    .returning();
  return row;
}

test("actual resume enrichment persists substituted extraction before screening readiness changes", async () => {
  const row = await candidate();
  assert.equal(readiness.workflowScreeningReadiness(row).ready, false);
  output = { skills: ["SQL", " sql ", "TypeScript", ""] };
  const beforeCalls = extractionCalls;
  const merged = await enrich.enrichCandidateFromResume(row.id, row.resumeUrl!);
  assert.deepEqual(merged, ["SQL", "TypeScript"]);
  const [saved] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, row.id));
  assert.equal(extractionCalls, beforeCalls + 1);
  assert.equal(readiness.workflowScreeningReadiness(saved).ready, true);
  assert.equal(saved.source, "manual");
  assert.equal(saved.resumeScreenScore, null);
  assert.equal(saved.verificationStatus, row.verificationStatus);
});

test("empty extraction does not invent qualifications or screening evidence", async () => {
  const row = await candidate();
  output = { skills: [] };
  assert.equal(await enrich.enrichCandidateFromResume(row.id, row.resumeUrl!), null);
  const [saved] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, row.id));
  assert.deepEqual(saved.skills, []);
  assert.equal(readiness.workflowScreeningReadiness(saved).ready, false);
  assert.equal(saved.resumeScreenScore, null);
});

test("repeated resume extraction unions skills without removing manually saved qualifications", async () => {
  const row = await candidate(["Manual qualification"]);
  output = { skills: ["manual qualification", "SQL"] };
  await enrich.enrichCandidateFromResume(row.id, row.resumeUrl!);
  await enrich.enrichCandidateFromResume(row.id, row.resumeUrl!);
  const [saved] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, row.id));
  assert.deepEqual(saved.skills, ["Manual qualification", "SQL"]);
});
