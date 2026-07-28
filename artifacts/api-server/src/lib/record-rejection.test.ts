/**
 * record-rejection.test.ts — unit tests for the canonical rejection helper.
 *
 * The drizzle admin handle's `select`/`insert` are stubbed with an in-memory
 * fake keyed by table, so NO real database queries run.
 *
 * NOT covered here: the actual email dispatch inside
 * candidate-rejection-email.ts (hardwired import — would need refactoring to
 * inject; per instructions we do not modify source). All tests either pass
 * sendEmail:false or resolve no candidate email, so the email branch is
 * short-circuited before any network call.
 *
 * Run: npx tsx --test src/lib/record-rejection.test.ts
 */
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const {
  dbAdmin,
  applicationsTable,
  sourcedCandidatesTable,
  candidatesTable,
  jobsTable,
  tenantsTable,
  candidateRejectionsTable,
} = await import("@workspace/db");
const { recordRejection } = await import("./record-rejection");

/** rows returned per table for select().from(table)… */
let tableRows = new Map<unknown, any[]>();
let insertedRows: any[] = [];
let selectShouldThrow = false;
let insertShouldThrow = false;

beforeEach(() => {
  mock.restoreAll();
  tableRows = new Map();
  insertedRows = [];
  selectShouldThrow = false;
  insertShouldThrow = false;

  mock.method(dbAdmin as any, "select", () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (selectShouldThrow) throw new Error("db down");
          return tableRows.get(table) ?? [];
        },
      }),
    }),
  }));

  mock.method(dbAdmin as any, "insert", (table: unknown) => ({
    values: (row: any) => ({
      returning: async () => {
        if (insertShouldThrow) throw new Error("insert failed");
        assert.equal(table, candidateRejectionsTable);
        insertedRows.push(row);
        return [{ id: "rej-1" }];
      },
    }),
  }));
});

test("persists a rejection row and returns its id (email disabled)", async () => {
  tableRows.set(candidatesTable, [
    { id: "cand-1", email: "jane@example.com", firstName: "Jane", lastName: "Doe" },
  ]);
  tableRows.set(jobsTable, [{ id: "job-1", title: "Backend Engineer" }]);
  tableRows.set(tenantsTable, [{ id: "ten-1", name: "Acme Corp" }]);

  const r = await recordRejection({
    tenantId: "ten-1",
    jobId: "job-1",
    candidateId: "cand-1",
    rejectedByRole: "recruiter",
    reason: "not_a_fit",
    fromStage: "screening",
    sendEmail: false,
  });

  assert.equal(r.rejectionId, "rej-1");
  assert.equal(r.emailOk, null, "email must not be attempted when sendEmail=false");
  const row = insertedRows[0];
  assert.equal(row.tenantId, "ten-1");
  assert.equal(row.candidateId, "cand-1");
  assert.equal(row.candidateEmail, "jane@example.com");
  assert.equal(row.candidateName, "Jane Doe");
  assert.equal(row.jobTitle, "Backend Engineer");
  assert.equal(row.emailSent, false);
  assert.equal(row.rejectedByRole, "recruiter");
});

test("resolves candidateId via applicationId", async () => {
  tableRows.set(applicationsTable, [{ id: "app-1", candidateId: "cand-9" }]);
  tableRows.set(candidatesTable, [
    { id: "cand-9", email: "x@example.com", firstName: "Xin", lastName: "Li" },
  ]);
  await recordRejection({
    tenantId: "ten-1",
    applicationId: "app-1",
    rejectedByRole: "system",
    sendEmail: false,
  });
  assert.equal(insertedRows[0].candidateId, "cand-9");
  assert.equal(insertedRows[0].candidateEmail, "x@example.com");
});

test("resolves context from sourced_candidates rawData incl. language", async () => {
  tableRows.set(sourcedCandidatesTable, [
    {
      id: "src-1",
      normalizedCandidateId: null,
      rawData: {
        firstName: "Marie",
        lastName: "Curie",
        email: "marie@example.fr",
        preferredLanguage: "fr",
      },
    },
  ]);
  await recordRejection({
    tenantId: "ten-1",
    sourcedId: "src-1",
    rejectedByRole: "recruiter",
    sendEmail: false,
  });
  const row = insertedRows[0];
  assert.equal(row.candidateEmail, "marie@example.fr");
  assert.equal(row.candidateName, "Marie Curie");
  assert.equal(row.language, "fr");
});

test("explicit language input wins over resolved preferredLanguage", async () => {
  tableRows.set(candidatesTable, [
    { id: "cand-1", email: "a@b.c", firstName: "A", lastName: "B", preferredLanguage: "de" },
  ]);
  await recordRejection({
    tenantId: "ten-1",
    candidateId: "cand-1",
    rejectedByRole: "system",
    language: "en",
    sendEmail: false,
  });
  assert.equal(insertedRows[0].language, "en");
});

test("no candidate email resolved → email skipped, emailOk stays null", async () => {
  // candidate lookup returns nothing; sendEmail defaults to true but there
  // is no address, so the email branch must be skipped entirely.
  const r = await recordRejection({
    tenantId: "ten-1",
    candidateId: "ghost",
    rejectedByRole: "system",
  });
  assert.equal(r.emailOk, null);
  assert.equal(insertedRows[0].candidateEmail, null);
  assert.equal(insertedRows[0].emailSent, false);
});

test("context-lookup failure is non-fatal: row still persists", async () => {
  selectShouldThrow = true;
  const r = await recordRejection({
    tenantId: "ten-1",
    candidateId: "cand-1",
    rejectedByRole: "recruiter",
    sendEmail: false,
  });
  assert.equal(r.rejectionId, "rej-1");
  assert.equal(insertedRows[0].candidateEmail, null);
});

test("NEVER throws even when the final insert fails", async () => {
  insertShouldThrow = true;
  const r = await recordRejection({
    tenantId: "ten-1",
    candidateId: "cand-1",
    rejectedByRole: "system",
    sendEmail: false,
  });
  assert.equal(r.rejectionId, "", "returns empty id instead of throwing");
});
