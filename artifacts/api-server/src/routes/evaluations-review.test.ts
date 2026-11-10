import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  candidateEvaluationsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { COMPETENCY_LIBRARY } from "../lib/competency-library";
import evaluationsRouter from "./evaluations";

const prefix = `evalreview_${crypto.randomUUID()}_`;
const tenant = prefix + "tenant",
  foreign = prefix + "foreign";
const admin = prefix + "admin",
  outsider = prefix + "outsider",
  recruiter = prefix + "recruiter",
  self = prefix + "self";
const job = prefix + "job",
  candidate = prefix + "candidate",
  report = prefix + "report",
  legacy = prefix + "legacy";
const key = Object.keys(COMPETENCY_LIBRARY)[0];
let server: Server;
let base = "";
const token = (id = admin, role = "tenant_admin", tenantId = tenant) =>
  issueToken({ userId: id, role, tenantId });
async function call(path: string, method = "GET", body?: unknown, auth = token()) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: tenant, name: "Report review fixture", slug: tenant, plan: "enterprise" },
    { id: foreign, name: "Foreign review fixture", slug: foreign, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: admin,
      tenantId: tenant,
      name: "Reviewer",
      email: admin + "@test.invalid",
      passwordHash: "x",
      role: "tenant_admin",
    },
    {
      id: outsider,
      tenantId: foreign,
      name: "Other",
      email: outsider + "@test.invalid",
      passwordHash: "x",
      role: "tenant_admin",
    },
    {
      id: recruiter,
      tenantId: tenant,
      name: "Unassigned",
      email: recruiter + "@test.invalid",
      passwordHash: "x",
      role: "recruiter",
    },
    {
      id: self,
      tenantId: tenant,
      name: "Candidate",
      email: self + "@test.invalid",
      passwordHash: "x",
      role: "candidate",
    },
  ]);
  await dbAdmin.insert(jobsTable).values({
    id: job,
    tenantId: tenant,
    title: "API review fixture",
    description: "Synthetic assessment",
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidate,
    tenantId: tenant,
    userId: self,
    firstName: "Fixture",
    lastName: "Candidate",
    email: candidate + "@test.invalid",
    doNotContact: true,
    pool: "tenant",
  });
  const content = {
    headline: "Original",
    executiveSummary: "Job assessment",
    roleAlignment: "",
    competencies: [
      {
        key,
        label: COMPETENCY_LIBRARY[key].label,
        score: 50,
        insufficientEvidence: false,
        evidence: "Job answer",
        rationale: "",
      },
    ],
    behavioralInsights: [],
    observations: [],
    developmentOpportunities: [],
    riskAssessment: { concerns: [], toValidate: [] },
    verification: { status: "pending", summary: "AI snapshot" },
    recommendation: { band: "further_assessment", rationale: "Review required" },
    evidenceBasis: {
      hasInterview: true,
      interviewAnswers: 5,
      hasResume: false,
      hasIntelligence: false,
      provenance: {
        kind: "job_bound_evaluation_v1",
        jobId: job,
        candidateId: candidate,
        interviewSessionId: "synthetic-job-session",
      },
    },
    privateExtra: "PRIVATE_RAW_BLOB_SENTINEL",
  };
  await dbAdmin.insert(candidateEvaluationsTable).values({
    id: report,
    tenantId: tenant,
    jobId: job,
    candidateId: candidate,
    aiContent: content,
    competencyKeys: [key],
    humanEdits: { recruiterComments: "PRIVATE_PREP_SENTINEL" },
  });
  const app = express();
  app.use(express.json());
  app.use("/evaluations", evaluationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/evaluations`;
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin
    .delete(candidateEvaluationsTable)
    .where(inArray(candidateEvaluationsTable.id, [report, legacy]));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.id, job));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidate));
  await dbAdmin
    .delete(usersTable)
    .where(inArray(usersTable.id, [admin, outsider, recruiter, self]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenant, foreign]));
});

test("legacy notes are suppressed and approval cannot silently certify withheld edits", async () => {
  const r = await call(`/${job}/${candidate}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.evaluation.reviewEditsStatus, "requires_review");
  assert.ok(r.body.evaluation.aiContent);
  assert.ok(!JSON.stringify(r.body).includes("SENTINEL"));
  assert.equal((await call(`/${report}/approve`, "POST")).status, 409);
});

test("authorized edits persist after reload, keep baseline safe, and preserve withheld notes", async () => {
  const r = await call(`/${report}`, "PATCH", {
    humanEdits: {
      headline: "Corrected headline",
      recruiterComments: "Transcript quality needs human review",
      verification: { summary: "Job identity still needs review" },
      competencyOverrides: {
        [key]: {
          score: 0,
          insufficientEvidence: false,
          evidence: "Not demonstrated",
          rationale: "Job evidence",
        },
      },
    },
  });
  assert.equal(r.status, 200);
  const loaded = await call(`/${job}/${candidate}`);
  const e = loaded.body.evaluation;
  assert.equal(e.content.headline, "Corrected headline");
  assert.equal(e.content.recruiterComments, "Transcript quality needs human review");
  assert.equal(e.content.verification.summary, "Job identity still needs review");
  assert.equal(e.content.competencies[0].score, 0);
  assert.equal(e.aiContent.headline, "Original");
  assert.equal(e.reviewEditsStatus, "verified");
  assert.ok(!JSON.stringify(e).includes("SENTINEL"));
  const [stored] = await dbAdmin
    .select()
    .from(candidateEvaluationsTable)
    .where(eq(candidateEvaluationsTable.id, report));
  assert.equal(
    (stored.humanEdits as any).legacyPrivateEdits.recruiterComments,
    "PRIVATE_PREP_SENTINEL",
  );
});

test("forged metadata, protected fields and foreign/nonstaff/unassigned writers fail", async () => {
  for (const humanEdits of [
    { kind: "job_bound_recruiter_review_v1" },
    { privatePrep: "PRIVATE" },
    { recommendation: { band: "strongly_recommend" } },
    { verification: { status: "verified" } },
  ])
    assert.equal((await call(`/${report}`, "PATCH", { humanEdits })).status, 400);
  assert.equal(
    (
      await call(
        `/${report}`,
        "PATCH",
        { humanEdits: {} },
        token(outsider, "tenant_admin", foreign),
      )
    ).status,
    404,
  );
  assert.equal(
    (await call(`/${report}`, "PATCH", { humanEdits: {} }, token(recruiter, "recruiter"))).status,
    404,
  );
  assert.equal(
    (await call(`/${job}/${candidate}`, "GET", undefined, token(self, "candidate"))).status,
    403,
  );
});

test("stale snapshots cannot overwrite or approve changed review content", async () => {
  const stale = "2000-01-01T00:00:00.000Z";
  assert.equal(
    (
      await call(`/${report}`, "PATCH", {
        humanEdits: { headline: "Wrong stale edit" },
        expectedUpdatedAt: stale,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(`/${report}/approve`, "POST", { expectedUpdatedAt: stale })).status,
    409,
  );
});

test("explicit approval locks edits, retains reviewed content, and reopen clears approval", async () => {
  const prior = (await call(`/${job}/${candidate}`)).body.evaluation;
  const r = await call(`/${report}/approve`, "POST", { expectedUpdatedAt: prior.updatedAt });
  assert.equal(r.status, 200);
  assert.equal(r.body.evaluation.approvedByUserId, admin);
  assert.ok(r.body.evaluation.approvedAt);
  assert.equal(r.body.evaluation.content.headline, "Corrected headline");
  assert.equal((await call(`/${report}`, "PATCH", { humanEdits: {} })).status, 409);
  assert.equal((await call(`/${report}/approve`, "POST")).status, 409);
  const reopened = await call(`/${report}/reopen`, "POST");
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.evaluation.approvedAt, null);
  assert.equal(reopened.body.evaluation.approvedByUserId, null);
  assert.equal(reopened.body.evaluation.content.headline, "Corrected headline");
  const cleared = await call(`/${report}`, "PATCH", { humanEdits: {}, competencyKeys: [] });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.evaluation.content.recruiterComments, "");
  assert.equal(cleared.body.evaluation.content.headline, "Original");
  assert.equal(cleared.body.evaluation.content.competencies.length, 0);
});

test("unverified or foreign-job AI evidence cannot be edited or approved", async () => {
  const [row] = await dbAdmin
    .select()
    .from(candidateEvaluationsTable)
    .where(eq(candidateEvaluationsTable.id, report));
  const ai = row.aiContent as any;
  await dbAdmin
    .update(candidateEvaluationsTable)
    .set({
      aiContent: {
        ...ai,
        evidenceBasis: {
          ...ai.evidenceBasis,
          provenance: {
            ...ai.evidenceBasis.provenance,
            jobId: "foreign-job",
          },
        },
      },
    })
    .where(eq(candidateEvaluationsTable.id, report));
  const read = await call(`/${job}/${candidate}`);
  assert.equal(read.body.evaluation.evidenceProvenanceVerified, false);
  assert.ok(!JSON.stringify(read.body).includes("SENTINEL"));
  assert.equal((await call(`/${report}`, "PATCH", { humanEdits: {} })).status, 409);
  assert.equal((await call(`/${report}/approve`, "POST")).status, 409);
});
