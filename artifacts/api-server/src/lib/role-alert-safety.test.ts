import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  candidatesTable,
  candidateCareerProfilesTable,
  jobsTable,
  candidateActionEventsTable,
  candidateMarketEventsSentTable,
} from "@workspace/db";

const prefix = `role_safe_${crypto.randomUUID()}_`;
const tenantId = prefix + "tenant";
const candidateId = prefix + "candidate";
const company = prefix + "Employer";
const jobIds: string[] = [];
const sent: unknown[] = [];
let failTransport = false;
let accepted = true;
const policy = await import("./role-alert-policy");
let contextReads = 0;
let beforeHandoff: (() => Promise<void>) | undefined;
mock.module(new URL("./role-alert-policy.ts", import.meta.url), {
  namedExports: {
    ...policy,
    loadRoleAlertContext: async (...args: Parameters<typeof policy.loadRoleAlertContext>) => {
      contextReads++;
      // Simulate a committed withdrawal after initial eligibility/claim and
      // before the sender's final check, without calling any real provider.
      if (contextReads === 2 && beforeHandoff) await beforeHandoff();
      return policy.loadRoleAlertContext(...args);
    },
  },
});
const email = await import("./email");
mock.module(new URL("./email.ts", import.meta.url), {
  namedExports: {
    ...email,
    sendEmail: async (value: unknown) => {
      sent.push(value);
      if (failTransport) throw new Error("Uncertain test-only provider outcome");
      return { ok: accepted, messageId: "test-only-intercepted" };
    },
  },
});
const { recordRoleOpenAtTarget } = await import("./market-event-emitter");

before(async () => {
  await dbAdmin.insert(tenantsTable).values({ id: tenantId, name: company, slug: tenantId });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    firstName: "Fixture",
    lastName: "Candidate",
    email: `${prefix}candidate@example.invalid`,
    pool: "tenant",
  });
  await dbAdmin
    .insert(candidateCareerProfilesTable)
    .values({ candidateId, targetCompanies: [company] });
});
after(async () => {
  await dbAdmin
    .delete(candidateMarketEventsSentTable)
    .where(eq(candidateMarketEventsSentTable.candidateId, candidateId));
  await dbAdmin
    .delete(candidateActionEventsTable)
    .where(eq(candidateActionEventsTable.candidateId, candidateId));
  await dbAdmin
    .delete(candidateCareerProfilesTable)
    .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidateId));
  if (jobIds.length) await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});
async function job(
  status: typeof jobsTable.$inferInsert.status = "published",
  confidential = false,
) {
  const jobId = prefix + crypto.randomUUID();
  jobIds.push(jobId);
  await dbAdmin.insert(jobsTable).values({
    id: jobId,
    tenantId,
    title: "Current public title",
    description: "Private test fixture",
    status,
    isConfidential: confidential,
  });
  contextReads = 0;
  return jobId;
}
async function emit(jobId: string) {
  await recordRoleOpenAtTarget({
    candidateId,
    jobId,
    companyName: "STALE_OR_FORGED_COMPANY",
    roleTitle: "STALE_OR_FORGED_TITLE",
  });
}
async function events(jobId: string) {
  return (
    await dbAdmin
      .select()
      .from(candidateActionEventsTable)
      .where(
        and(
          eq(candidateActionEventsTable.candidateId, candidateId),
          eq(candidateActionEventsTable.eventType, "role_open_at_target"),
        ),
      )
  ).filter((row) => row.payload?.jobId === jobId);
}
async function claims(jobId: string) {
  return dbAdmin
    .select()
    .from(candidateMarketEventsSentTable)
    .where(
      and(
        eq(candidateMarketEventsSentTable.candidateId, candidateId),
        eq(candidateMarketEventsSentTable.eventKey, `role_open_at_target:${jobId}`),
      ),
    );
}
test("published positive: current canonical content, one feed event and one email on concurrent retries", async () => {
  const jobId = await job();
  await Promise.all([emit(jobId), emit(jobId), emit(jobId)]);
  assert.equal((await events(jobId)).length, 1);
  assert.equal((await claims(jobId)).length, 1);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent).includes("STALE_OR_FORGED"), false);
  assert.equal(JSON.stringify(sent).includes("Current public title"), true);
});
test("draft, pending, active, paused, rejected, closed and confidential jobs create no alert or claim", async () => {
  const count = sent.length;
  for (const status of [
    "draft",
    "pending_approval",
    "active",
    "paused",
    "rejected",
    "closed",
  ] as const) {
    const jobId = await job(status);
    await emit(jobId);
    assert.equal((await events(jobId)).length, 0);
    assert.equal((await claims(jobId)).length, 0);
  }
  const confidential = await job("published", true);
  await emit(confidential);
  assert.equal((await events(confidential)).length, 0);
  assert.equal((await claims(confidential)).length, 0);
  assert.equal(sent.length, count);
});
test("DNC and paused discovery retain eligible private activity but consume no email claim", async () => {
  for (const field of ["doNotContact", "discoveryPaused"] as const) {
    await dbAdmin
      .update(candidatesTable)
      .set({ [field]: true })
      .where(eq(candidatesTable.id, candidateId));
    const jobId = await job();
    const count = sent.length;
    await emit(jobId);
    assert.equal((await events(jobId)).length, 1);
    assert.equal((await claims(jobId)).length, 0);
    assert.equal(sent.length, count);
    await dbAdmin
      .update(candidatesTable)
      .set({ [field]: false })
      .where(eq(candidatesTable.id, candidateId));
    await emit(jobId);
    assert.equal((await events(jobId)).length, 1);
    assert.equal(sent.length, count + 1);
  }
});
test("withdrawn or malformed subscriptions create no activity or email", async () => {
  const count = sent.length;
  for (const targets of [[], [null, 12], "malformed", ["Another employer"]]) {
    await dbAdmin
      .update(candidateCareerProfilesTable)
      .set({ targetCompanies: targets as unknown as string[] })
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
    const jobId = await job();
    await emit(jobId);
    assert.equal((await events(jobId)).length, 0);
    assert.equal((await claims(jobId)).length, 0);
  }
  assert.equal(sent.length, count);
  await dbAdmin
    .update(candidateCareerProfilesTable)
    .set({ targetCompanies: [company] })
    .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
});
test("missing or synthetic destination retains private activity without consuming a claim", async () => {
  const count = sent.length;
  for (const destination of [
    "",
    `${prefix}placeholder@unknown.local`,
    `${prefix}placeholder@import.local`,
  ]) {
    await dbAdmin
      .update(candidatesTable)
      .set({ email: destination })
      .where(eq(candidatesTable.id, candidateId));
    const jobId = await job();
    await emit(jobId);
    assert.equal((await events(jobId)).length, 1);
    assert.equal((await claims(jobId)).length, 0);
  }
  assert.equal(sent.length, count);
  await dbAdmin
    .update(candidatesTable)
    .set({ email: `${prefix}candidate@example.invalid` })
    .where(eq(candidatesTable.id, candidateId));
});
test("job withdrawal, confidentiality, opt-out and subscription withdrawal are rechecked before transport", async () => {
  const count = sent.length;
  for (const change of ["unpublish", "confidential", "dnc", "pause", "unsubscribe"] as const) {
    const jobId = await job();
    beforeHandoff = async () => {
      if (change === "unpublish")
        await dbAdmin.update(jobsTable).set({ status: "active" }).where(eq(jobsTable.id, jobId));
      if (change === "confidential")
        await dbAdmin
          .update(jobsTable)
          .set({ isConfidential: true })
          .where(eq(jobsTable.id, jobId));
      if (change === "dnc")
        await dbAdmin
          .update(candidatesTable)
          .set({ doNotContact: true })
          .where(eq(candidatesTable.id, candidateId));
      if (change === "pause")
        await dbAdmin
          .update(candidatesTable)
          .set({ discoveryPaused: true })
          .where(eq(candidatesTable.id, candidateId));
      if (change === "unsubscribe")
        await dbAdmin
          .update(candidateCareerProfilesTable)
          .set({ targetCompanies: [] })
          .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
    };
    try {
      await emit(jobId);
      assert.equal(sent.length, count);
      assert.equal(
        (await claims(jobId)).length,
        1,
        "acquired claims remain conservative, not automatically released",
      );
    } finally {
      beforeHandoff = undefined;
      await dbAdmin
        .update(candidatesTable)
        .set({ doNotContact: false, discoveryPaused: false })
        .where(eq(candidatesTable.id, candidateId));
      await dbAdmin
        .update(candidateCareerProfilesTable)
        .set({ targetCompanies: [company] })
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
    }
  }
});
test("uncertain transport retains the claim and does not resend on retry", async () => {
  const jobId = await job();
  const count = sent.length;
  failTransport = true;
  await emit(jobId);
  failTransport = false;
  await emit(jobId);
  assert.equal(sent.length, count + 1);
  assert.equal((await events(jobId)).length, 1);
  assert.equal((await claims(jobId)).length, 1);
});
test("explicit transport failure also retains its claim without immediate resend", async () => {
  const jobId = await job();
  const count = sent.length;
  accepted = false;
  try {
    await emit(jobId);
  } finally {
    accepted = true;
  }
  await emit(jobId);
  assert.equal(sent.length, count + 1);
  assert.equal((await claims(jobId)).length, 1);
});
test("erased and missing candidates cannot create activity, claims or email", async () => {
  // Erasure is irreversible in the fixture, just as it is in production.
  const jobId = await job();
  const count = sent.length;
  await dbAdmin
    .update(candidatesTable)
    .set({ dataErasedAt: new Date() })
    .where(eq(candidatesTable.id, candidateId));
  await emit(jobId);
  await recordRoleOpenAtTarget({
    candidateId: prefix + "missing",
    jobId,
    companyName: company,
    roleTitle: "Ignored",
  });
  assert.equal((await events(jobId)).length, 0);
  assert.equal((await claims(jobId)).length, 0);
  assert.equal(sent.length, count);
});
