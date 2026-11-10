import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  dbAdmin,
  candidatesTable,
  tenantsTable,
  aiJobsTable,
  resumeScreensTable,
  candidateErasureTombstonesTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { purgeCandidateLinkedData } from "./candidate-erasure";
import { serializeApplicationError } from "./logger";
import { isCandidateErased, isErasedAiWork } from "./candidate-erasure-barrier";
import { enqueueAiJob, completeJob, failJob } from "./ai-queue/queue";
import {
  enrichCandidateFromResume,
  fillCandidateSocialUrlsIfEmpty,
  mergeSkillsIntoCandidate,
} from "./enrich-candidate";

const tenant = `erasure-barrier-${randomUUID()}`;
test("blocked query parameters are not copied into error logs", () => {
  const error = new Error("Failed query containing disposable private-result");
  error.cause = new Error("candidate_erased");
  assert.deepEqual(serializeApplicationError(error), {
    type: "CandidateErased",
    message: "candidate_erased",
  });
});
const ids: string[] = [];
const jobIds: string[] = [];
function disposableScreen(candidateId: string) {
  return {
    tenantId: tenant,
    candidateId,
    screeningScore: 50,
    recruiterSummary: "Disposable late-result fixture",
  };
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values({
    id: tenant,
    slug: tenant,
    name: "Disposable barrier fixture",
    country: "US",
    region: "us",
  });
});
after(async () => {
  if (jobIds.length) await dbAdmin.delete(aiJobsTable).where(inArray(aiJobsTable.id, jobIds));
  if (ids.length) {
    await dbAdmin.delete(resumeScreensTable).where(inArray(resumeScreensTable.candidateId, ids));
    await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, ids));
    await dbAdmin
      .delete(candidateErasureTombstonesTable)
      .where(inArray(candidateErasureTombstonesTable.subjectId, ids));
  }
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenant));
});
async function fixture() {
  const id = randomUUID();
  ids.push(id);
  await dbAdmin.insert(candidatesTable).values({
    id,
    tenantId: tenant,
    firstName: "Disposable",
    lastName: "Barrier",
    email: `${id}@example.invalid`,
  });
  return id;
}
test("ATS profile provenance permits active writes but rejects late inserts and updates after erasure", async () => {
  const id = await fixture();
  const linkId = randomUUID();
  const rollback = new Error("disposable ATS barrier rollback");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO ats_candidate_profiles
          (id, tenant_id, system, account_ref, external_candidate_id, candidate_id,
           imported_by, fields, idempotency_key, request_hash)
        VALUES (${linkId}, ${tenant}, 'greenhouse', ${tenant}, ${id}, ${id},
                'disposable', ARRAY['name']::text[], ${linkId}, 'disposable')
      `);
      await tx.execute(sql`
        UPDATE ats_candidate_profiles SET fields=ARRAY['name','email']::text[]
        WHERE id=${linkId}
      `);
      // Retain the row deliberately to exercise a stale writer as well as a
      // late insert. Normal erasure cleanup removes this provenance first.
      await tx
        .update(candidatesTable)
        .set({ dataErasedAt: new Date() })
        .where(eq(candidatesTable.id, id));
      await assert.rejects(
        tx.transaction((inner) =>
          inner.execute(sql`
            INSERT INTO ats_candidate_profiles
              (id, tenant_id, system, account_ref, external_candidate_id, candidate_id,
               imported_by, fields, idempotency_key, request_hash)
            VALUES (${randomUUID()}, ${tenant}, 'greenhouse', ${tenant},
                    ${randomUUID()}, ${id}, 'disposable', ARRAY['name']::text[],
                    ${randomUUID()}, 'disposable')
          `),
        ),
        (error: unknown) => String((error as Error).cause ?? error).includes("candidate_erased"),
      );
      await assert.rejects(
        tx.transaction((inner) =>
          inner.execute(sql`
            UPDATE ats_candidate_profiles SET fields=ARRAY['email']::text[]
            WHERE id=${linkId}
          `),
        ),
        (error: unknown) => String((error as Error).cause ?? error).includes("candidate_erased"),
      );
      throw rollback;
    }),
    (error: unknown) => error === rollback,
  );
  assert.equal(await isCandidateErased(id), false);
});
async function erase(id: string, hard = false) {
  await dbAdmin.transaction(async (tx) => {
    await purgeCandidateLinkedData(tx, id);
    if (hard) await tx.delete(candidatesTable).where(eq(candidatesTable.id, id));
    else
      await tx
        .update(candidatesTable)
        .set({
          firstName: "Deleted",
          lastName: "Candidate",
          email: `erased+${id}@deleted.invalid`,
          skills: [],
          resumeUrl: null,
          dataErasedAt: new Date(),
        })
        .where(eq(candidatesTable.id, id));
  });
}
async function job(id: string, status: "pending" | "processing" = "pending") {
  const [row] = await dbAdmin
    .insert(aiJobsTable)
    .values({
      type: "match_candidate_to_job",
      tenantId: tenant,
      status,
      runAt: new Date(Date.now() + 86400000),
      lockedAt: status === "processing" ? new Date() : null,
      lockedBy: status === "processing" ? "disposable-worker" : null,
      payload: { candidateId: id, jobId: "disposable-role", stalePrivateText: "must disappear" },
      result: { stalePrivateText: "must disappear" },
    })
    .returning();
  jobIds.push(row!.id);
  return row!;
}
function blocked(error: any) {
  return (error?.cause?.message ?? error?.message) === "candidate_erased";
}
test("soft erasure rejects stale profile, score, source and résumé writes; peers still work", async () => {
  const id = await fixture(),
    peer = await fixture();
  await erase(id);
  assert.equal(await isCandidateErased(id), true);
  await assert.rejects(
    dbAdmin
      .update(candidatesTable)
      .set({ skills: ["stale secret"] })
      .where(eq(candidatesTable.id, id)),
    blocked,
  );
  await assert.rejects(
    dbAdmin.update(candidatesTable).set({ dataErasedAt: null }).where(eq(candidatesTable.id, id)),
    blocked,
  );
  await assert.rejects(dbAdmin.insert(resumeScreensTable).values(disposableScreen(id)), blocked);
  assert.equal(await enrichCandidateFromResume(id, "https://example.invalid/private.pdf"), null);
  await fillCandidateSocialUrlsIfEmpty(id, { linkedinUrl: "https://linkedin.com/in/disposable" });
  await mergeSkillsIntoCandidate(id, ["stale secret"]);
  const [row] = await dbAdmin.select().from(candidatesTable).where(eq(candidatesTable.id, id));
  assert.deepEqual(row!.skills, []);
  assert.equal(row!.linkedinUrl, null);
  await dbAdmin
    .update(candidatesTable)
    .set({ skills: ["allowed"] })
    .where(eq(candidatesTable.id, peer));
  assert.equal(await isCandidateErased(peer), false);
});
test("hard erasure prevents reinsertion, late child writes and new queue work", async () => {
  const id = await fixture();
  await erase(id, true);
  await assert.rejects(
    dbAdmin.insert(candidatesTable).values({
      id,
      tenantId: tenant,
      firstName: "Stale",
      lastName: "Result",
      email: `${id}@example.invalid`,
    }),
    blocked,
  );
  await assert.rejects(dbAdmin.insert(resumeScreensTable).values(disposableScreen(id)), blocked);
  assert.equal(
    await enqueueAiJob({
      type: "match_candidate_to_job",
      payload: { candidateId: id, jobId: "disposable-role" },
    }),
    null,
  );
  assert.equal(await isErasedAiWork({ sessionId: randomUUID() }), true);
});
test("erasure discards pending/running snapshots and fences late completion, failure and retries", async () => {
  const id = await fixture(),
    peer = await fixture();
  const pending = await job(id),
    running = await job(id, "processing"),
    untouched = await job(peer);
  await erase(id, true);
  await completeJob(running.id, { privateText: "late result" });
  await failJob(running, new Error("late failure containing private text"));
  for (const j of [pending, running]) {
    const [row] = await dbAdmin.select().from(aiJobsTable).where(eq(aiJobsTable.id, j.id));
    assert.equal(row!.status, "failed");
    assert.equal(row!.lastError, "candidate_erased");
    assert.deepEqual(row!.payload, { candidateId: id });
    assert.equal(row!.result, null);
    assert.equal(await isErasedAiWork(row!.payload), true);
  }
  const [other] = await dbAdmin.select().from(aiJobsTable).where(eq(aiJobsTable.id, untouched.id));
  assert.equal(other!.status, "pending");
});
test("ordinary application-role writes cannot bypass the barrier", async () => {
  const id = await fixture();
  await erase(id);
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.execute(sql`SELECT set_config('app.current_tenant_id',${tenant},true)`);
      await tx.execute(
        sql`INSERT INTO resume_screens (id,tenant_id,candidate_id,screening_score,recruiter_summary)
        VALUES (${randomUUID()},${tenant},${id},50,'Disposable late-result fixture')`,
      );
    }),
    blocked,
  );
});
test("rollback does not leave a suppression marker or discarded queue job", async () => {
  const id = await fixture(),
    queued = await job(id);
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      await purgeCandidateLinkedData(tx, id);
      throw new Error("disposable rollback");
    }),
    /disposable rollback/,
  );
  assert.equal(await isCandidateErased(id), false);
  const [row] = await dbAdmin.select().from(aiJobsTable).where(eq(aiJobsTable.id, queued.id));
  assert.equal(row!.status, "pending");
});
test("a child result already waiting when erasure commits is rejected", async () => {
  const id = await fixture();
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>((r) => (acquired = r));
  const gate = new Promise<void>((r) => (release = r));
  const erasing = dbAdmin.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM candidates WHERE id=${id} FOR UPDATE`);
    acquired();
    await gate;
    await purgeCandidateLinkedData(tx, id);
    await tx.delete(candidatesTable).where(eq(candidatesTable.id, id));
  });
  await ready;
  let writerPid = 0,
    writeError: unknown,
    waiting = false;
  const writing = dbAdmin
    .transaction(async (tx) => {
      const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      writerPid = Number(pid.rows[0]?.pid);
      await tx.insert(resumeScreensTable).values(disposableScreen(id));
    })
    .catch((error) => {
      writeError = error;
    });
  try {
    for (let i = 0; i < 100 && !writeError; i++) {
      if (writerPid) {
        const locks = await dbAdmin.execute(sql`SELECT EXISTS(
          SELECT 1 FROM pg_locks WHERE pid=${writerPid} AND NOT granted) AS waiting`);
        if (locks.rows[0]?.waiting === true) {
          waiting = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    release();
    await erasing;
    await writing;
  }
  assert.equal(
    waiting,
    true,
    "writer must demonstrably wait on erasure, not merely arrive afterward",
  );
  assert.ok(blocked(writeError));
  const rows = await dbAdmin
    .select()
    .from(resumeScreensTable)
    .where(eq(resumeScreensTable.candidateId, id));
  assert.equal(rows.length, 0);
});
