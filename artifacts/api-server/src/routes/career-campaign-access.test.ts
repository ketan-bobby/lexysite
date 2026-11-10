import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "@workspace/db";
import type { CandidateRegistrationPage } from "@workspace/api-zod";

// Real router and real Drizzle predicates; no database writes, provider calls or emails.
const dialect = new PgDialect();
const candidate = (id: string) => ({
  id,
  tenantId: "fixture-tenant",
  firstName: "Fixture",
  lastName: id,
  email: `${id}@example.invalid`,
  jobTitle: null,
  company: null,
  source: "self_registered",
  userId: `user-${id}` as string | null,
  pool: "pending_profile",
  createdAt: new Date("2026-10-16T00:00:00Z"),
  dataErasedAt: null as Date | null,
  doNotContact: false,
});
let callerId: string | null;
let caller: { id: string; role: string; tenantId: string; status: string } | undefined;
let allowed: string[] | null;
let candidates: ReturnType<typeof candidate>[];
let owned: Set<string>;
let assignedJobs: string[];
type Profile = {
  candidateId: string;
  baselineInterviewCompleted: boolean;
  profileCompleteness: number;
  updatedAt: Date;
};
type Invite = { id: string; candidateId: string; createdAt: Date; usedAt: Date | null };
let profiles: Profile[];
let tokens: Invite[];
const reads: {
  table: unknown;
  query: { sql: string; params: unknown[] } | null;
  limit: number | undefined;
  order: string;
}[] = [];

const fakeDb = {
  select(fields?: Record<string, unknown>) {
    let table: unknown;
    let predicate: SQL | undefined;
    let limit: number | undefined;
    let order = "";
    const chain = {
      from(value: unknown) {
        table = value;
        return chain;
      },
      where(value: SQL | undefined) {
        predicate = value;
        return chain;
      },
      orderBy(...values: SQL[]) {
        order = values.map((value) => dialect.sqlToQuery(value).sql).join(", ");
        return chain;
      },
      limit(value: number) {
        limit = value;
        return chain;
      },
      then(resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve()
          .then(() => {
            const query = predicate ? dialect.sqlToQuery(predicate) : null;
            reads.push({ table, query, limit, order });
            if (table === schema.usersTable && fields?.role) return caller ? [caller] : [];
            if (table === schema.usersTable)
              throw new Error("Do not infer activation from user/email lookups");
            if (table === schema.candidatesTable) {
              let rows = candidates.filter((c) => allowed === null || allowed.includes(c.tenantId));
              if (query?.params.includes("self_registered")) {
                rows = rows.filter(
                  (c) =>
                    c.source === "self_registered" &&
                    c.userId !== null &&
                    c.dataErasedAt === null &&
                    !c.doNotContact,
                );
                const searchParameter = query.sql.match(/lower\(\$(\d+)\)/)?.[1];
                if (searchParameter) {
                  const search = String(query.params[Number(searchParameter) - 1]).toLowerCase();
                  rows = rows.filter((c) =>
                    `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase().includes(search),
                  );
                }
              }
              if (query?.sql.includes("EXISTS") || query?.sql.includes("false")) {
                rows = rows.filter((c) => assignedJobs.length > 0 && owned.has(c.id));
              }
              const cursorParameter = query?.sql.match(/"candidates"\."id" > \$(\d+)/)?.[1];
              const cursor = cursorParameter
                ? query?.params[Number(cursorParameter) - 1]
                : undefined;
              if (typeof cursor === "string") rows = rows.filter((c) => c.id > cursor);
              rows = rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
              const page = rows.slice(0, limit);
              return fields?.registeredAt
                ? page.map((c) => ({
                    candidateId: c.id,
                    firstName: c.firstName,
                    lastName: c.lastName,
                    email: c.email,
                    registeredAt: c.createdAt,
                    pool: c.pool,
                  }))
                : page;
            }
            if (table === schema.inviteTokensTable) {
              return tokens
                .filter((t) => query?.params.includes(t.candidateId))
                .sort(
                  (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
                );
            }
            if (table === schema.candidateCareerProfilesTable) {
              return profiles.filter((profile) => query?.params.includes(profile.candidateId));
            }
            return [];
          })
          .then(resolve, reject);
      },
    };
    return chain;
  },
};
mock.module("@workspace/db", { namedExports: { ...schema, db: fakeDb } });
const auth = await import("../lib/auth-token");
mock.module(new URL("../lib/auth-token.ts", import.meta.url), {
  namedExports: { ...auth, getAuthUserId: () => callerId },
});
const tenancy = await import("../lib/tenantUtils");
mock.module(new URL("../lib/tenantUtils.ts", import.meta.url), {
  namedExports: {
    ...tenancy,
    getDataScopeTenantIds: async () => allowed,
    getRecruiterAssignedJobIds: async () => assignedJobs,
  },
});
const ownership = await import("../lib/ownership");
mock.module(new URL("../lib/ownership.ts", import.meta.url), {
  namedExports: {
    ...ownership,
    recruiterOwnsResource: async (_caller: unknown, resource: { value: string }) =>
      owned.has(resource.value),
  },
});
const email = await import("../lib/email");
mock.module(new URL("../lib/email.ts", import.meta.url), {
  namedExports: {
    ...email,
    sendEmail: async () => {
      throw new Error("Campaign reporting must never send email");
    },
  },
});
const { default: router } = await import("./invites");
let server: Server;
let origin: string;
before(async () => {
  const app = express();
  app.use(router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  callerId = "fixture-staff";
  caller = { id: callerId, role: "tenant_admin", tenantId: "fixture-tenant", status: "active" };
  allowed = ["fixture-tenant"];
  candidates = [candidate("allowed-a"), candidate("allowed-b")];
  owned = new Set(["allowed-a"]);
  assignedJobs = ["assigned-job"];
  profiles = candidates.map((c) => ({
    candidateId: c.id,
    baselineInterviewCompleted: true,
    profileCompleteness: 85,
    updatedAt: new Date("2026-10-14T00:00:00Z"),
  }));
  tokens = [];
  reads.length = 0;
});
async function request(query = "") {
  const response = await fetch(`${origin}/invites/career-campaign-status${query}`);
  const body = (await response.json()) as {
    data?: {
      candidateId: string;
      status: string;
      invitedAt: string | null;
      completedAt: string | null;
    }[];
    hasMore?: boolean;
    nextCursor?: string | null;
    error?: string;
  };
  return { status: response.status, body };
}
function assertChildScope(ids: string[]) {
  for (const table of [schema.inviteTokensTable, schema.candidateCareerProfilesTable]) {
    const matches = reads.filter((read) => read.table === table);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].query?.sql.includes("candidate_id"));
    assert.deepEqual(matches[0].query?.params, ids);
  }
  assert.equal(
    reads.filter((read) => read.table === schema.usersTable).length,
    1,
    "only resolve the caller; never look up candidate users by email",
  );
}
async function registrations(query = "") {
  const response = await fetch(`${origin}/platform/candidate-registrations${query}`);
  return { status: response.status, body: (await response.json()) as CandidateRegistrationPage };
}

test("registration inventory requires an active platform administrator", async () => {
  for (const role of [
    "candidate",
    "tenant_admin",
    "recruiter_admin",
    "recruiter",
    "hiring_manager",
    "interviewer",
  ]) {
    caller!.role = role;
    assert.equal((await registrations()).status, 403);
  }
  assert.equal(reads.filter((read) => read.table === schema.candidatesTable).length, 0);
  caller!.role = "platform_admin";
  caller!.status = "suspended";
  assert.equal((await registrations()).status, 401);
  callerId = null;
  assert.equal((await registrations()).status, 401);
});

test("registration inventory includes private sign-ups without exposing developmental evidence", async () => {
  caller!.role = "platform_admin";
  allowed = null;
  candidates.push(
    { ...candidate("imported"), source: "manual" },
    { ...candidate("unlinked"), userId: null },
    { ...candidate("erased"), dataErasedAt: new Date() },
    { ...candidate("dnc"), doNotContact: true },
    { ...candidate("opted-in"), pool: "platform", tenantId: "another-tenant" },
  );
  const result = await registrations();
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.data.map((row: { candidateId: string }) => row.candidateId),
    ["allowed-a", "allowed-b", "opted-in"],
  );
  assert.equal(result.body.data[0].pool, "pending_profile");
  assert.deepEqual(Object.keys(result.body.data[0]).sort(), [
    "candidateId",
    "email",
    "name",
    "pool",
    "registeredAt",
  ]);
  assert.equal(reads.length, 2, "caller and metadata only; never read private child tables");
  const query = reads[1].query!;
  assert.match(query.sql, /"source" = /);
  assert.match(query.sql, /"user_id" is not null/);
  assert.match(query.sql, /data_erased_at/);
  assert.match(query.sql, /do_not_contact/);
});

test("registration inventory supports bounded pagination and literal name/email search", async () => {
  caller!.role = "platform_admin";
  allowed = null;
  const first = await registrations("?limit=1");
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextCursor, "allowed-a");
  const second = await registrations("?limit=1&cursor=allowed-a");
  assert.equal(second.body.data[0].candidateId, "allowed-b");
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.nextCursor, null);
  const found = await registrations("?search=ALLOWED-B%40example.invalid");
  assert.deepEqual(
    found.body.data.map((row: { candidateId: string }) => row.candidateId),
    ["allowed-b"],
  );
  assert.equal(
    (await registrations("?search=%25")).body.data.length,
    0,
    "percent is literal, not a wildcard",
  );
  assert.equal((await registrations("?limit=201")).status, 400);
  assert.equal((await registrations("?search=a&search=b")).status, 400);
  assert.equal((await registrations(`?search=${"a".repeat(201)}`)).status, 400);
});

test("unauthenticated callers cannot read campaign data", async () => {
  callerId = null;
  assert.equal((await request()).status, 401);
  assert.equal(reads.length, 0);
});
test("missing or inactive staff cannot read campaign data", async () => {
  caller = undefined;
  assert.equal((await request()).status, 401);
  caller = { id: callerId!, role: "tenant_admin", tenantId: "fixture-tenant", status: "suspended" };
  assert.equal((await request()).status, 401);
  assert.ok(reads.every((read) => read.table === schema.usersTable));
});
test("candidate accounts cannot use the staff campaign endpoint", async () => {
  caller!.role = "candidate";
  assert.equal((await request()).status, 403);
  assert.ok(reads.every((read) => read.table === schema.usersTable));
});
test("tenant campaign child reads use only the authorized candidate IDs", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data?.map((row) => row.candidateId),
    ["allowed-a", "allowed-b"],
  );
  assert.equal(response.body.data?.[0]?.status, "profile_complete");
  assertChildScope(["allowed-a", "allowed-b"]);
  const parent = reads.find((read) => read.table === schema.candidatesTable);
  assert.ok(parent?.query?.params.includes("fixture-tenant"));
  assert.equal(parent?.limit, 51);
  assert.equal(parent?.order, '"candidates"."id" asc');
  assert.ok(parent?.query?.sql.includes("data_erased_at"));
  assert.ok(parent?.query?.sql.includes("do_not_contact"));
});
test("recruiter ownership filtering happens before any child read", async () => {
  caller!.role = "recruiter";
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data?.map((row) => row.candidateId),
    ["allowed-a"],
  );
  assertChildScope(["allowed-a"]);
  const parent = reads.find((read) => read.table === schema.candidatesTable);
  for (const relation of ["applications", "sourced_candidates", "talent_pool_submissions"]) {
    assert.ok(parent?.query?.sql.includes(relation), `missing ownership path: ${relation}`);
  }
  assert.equal(parent?.query?.params.filter((value) => value === "assigned-job").length, 3);
  assert.ok(reads.every((read) => !read.query?.params.includes("allowed-b")));
});
test("empty tenant scope returns an empty report without child reads", async () => {
  allowed = [];
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { data: [], hasMore: false, nextCursor: null });
  assert.equal(reads.length, 2);
});
test("recruiters with no owned candidates do not scan child tables", async () => {
  caller!.role = "recruiter";
  owned.clear();
  assert.deepEqual((await request()).body, { data: [], hasMore: false, nextCursor: null });
  assert.equal(reads.length, 2);
});
test("platform admins still bound child reads to the report's candidate set", async () => {
  caller!.role = "platform_admin";
  allowed = null;
  assert.equal((await request()).status, 200);
  assertChildScope(["allowed-a", "allowed-b"]);
});

test("same-email candidates in different visible tenants cannot share activation", async () => {
  allowed = ["fixture-tenant", "other-visible-client"];
  candidates[1] = {
    ...candidates[1],
    email: candidates[0].email,
    tenantId: "other-visible-client",
  };
  profiles = [];
  tokens = [
    {
      id: "accepted-a",
      candidateId: "allowed-a",
      createdAt: new Date("2026-10-12Z"),
      usedAt: new Date("2026-10-13Z"),
    },
  ];
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data?.map((row) => row.status),
    ["portal_created", "not_invited"],
  );
  assertChildScope(["allowed-a", "allowed-b"]);
});
test("placeholder accounts and unsent invites do not prove activation", async () => {
  profiles = [];
  tokens = [
    {
      id: "pending-a",
      candidateId: "allowed-a",
      createdAt: new Date("2026-10-12Z"),
      usedAt: null,
    },
  ];
  const response = await request();
  assert.deepEqual(
    response.body.data?.map((row) => row.status),
    ["invited", "not_invited"],
  );
  assertChildScope(["allowed-a", "allowed-b"]);
});
test("an incomplete career profile proves activation, not interview completion", async () => {
  profiles = [{ ...profiles[0], baselineInterviewCompleted: false }];
  const response = await request();
  assert.deepEqual(
    response.body.data?.map((row) => row.status),
    ["portal_created", "not_invited"],
  );
  assert.equal(response.body.data?.[0]?.completedAt, null);
});
test("a later unused invite cannot erase earlier accepted-invite evidence", async () => {
  profiles = [];
  tokens = [
    {
      id: "old-accepted",
      candidateId: "allowed-a",
      createdAt: new Date("2026-10-10Z"),
      usedAt: new Date("2026-10-11Z"),
    },
    {
      id: "new-pending",
      candidateId: "allowed-a",
      createdAt: new Date("2026-10-14Z"),
      usedAt: null,
    },
    {
      id: "foreign-accepted",
      candidateId: "foreign",
      createdAt: new Date("2026-10-14Z"),
      usedAt: new Date("2026-10-14Z"),
    },
  ];
  const response = await request();
  assert.deepEqual(
    response.body.data?.map((row) => row.status),
    ["portal_created", "not_invited"],
  );
  assert.equal(response.body.data?.[0]?.invitedAt, new Date("2026-10-14Z").toISOString());
});
test("all candidates beyond the former 200 cutoff are reachable without duplicates", async () => {
  candidates = Array.from({ length: 237 }, (_, i) =>
    candidate(`candidate-${String(i).padStart(4, "0")}`),
  );
  profiles = [];
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const response = await request(`?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.status, 200);
    assert.ok(response.body.data);
    assert.ok(response.body.data.length <= 50);
    seen.push(...response.body.data.map((row) => row.candidateId));
    assert.equal(response.body.hasMore, response.body.nextCursor !== null);
    cursor = response.body.nextCursor ?? undefined;
    pages++;
    assert.ok(pages <= 5, "pagination must terminate");
  } while (cursor);
  assert.equal(pages, 5);
  assert.deepEqual(
    seen,
    candidates.map((c) => c.id),
  );
  assert.equal(new Set(seen).size, 237);
});
test("recruiter-owned candidates beyond 200 unrelated rows appear on the first page", async () => {
  caller!.role = "recruiter";
  candidates = Array.from({ length: 225 }, (_, i) =>
    candidate(`candidate-${String(i).padStart(4, "0")}`),
  );
  owned = new Set(candidates.slice(220).map((c) => c.id));
  profiles = [];
  const response = await request("?limit=3");
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data?.map((row) => row.candidateId),
    candidates.slice(220, 223).map((c) => c.id),
  );
  assert.equal(response.body.hasMore, true);
  assert.equal(response.body.nextCursor, candidates[222].id);
  assertChildScope(candidates.slice(220, 223).map((c) => c.id));
});
test("an unowned or foreign cursor never broadens the current tenant scope", async () => {
  candidates = [
    candidate("allowed-a"),
    candidate("allowed-b"),
    { ...candidate("allowed-c"), tenantId: "foreign" },
  ];
  profiles = [];
  const response = await request("?limit=1&cursor=allowed-a");
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data?.map((row) => row.candidateId),
    ["allowed-b"],
  );
  assert.equal(response.body.hasMore, false);
  assertChildScope(["allowed-b"]);
});
test("permission changes are rechecked before loading the next page", async () => {
  caller!.role = "recruiter";
  owned = new Set(["allowed-a", "allowed-b"]);
  const first = await request("?limit=1");
  assert.equal(first.body.nextCursor, "allowed-a");
  assignedJobs = [];
  const second = await request("?limit=1&cursor=allowed-a");
  assert.deepEqual(second.body, { data: [], hasMore: false, nextCursor: null });
});
test("invalid limits, cursors and duplicate query values fail before candidate reads", async () => {
  for (const query of [
    "?limit=0",
    "?limit=201",
    "?limit=1.5",
    "?limit=no",
    "?limit=1&limit=2",
    "?cursor=",
    "?cursor=../bad",
    "?cursor=a&cursor=b",
  ]) {
    reads.length = 0;
    assert.equal((await request(query)).status, 400, query);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].table, schema.usersTable);
  }
});
test("the maximum page size is bounded and its lookahead never reaches child reads", async () => {
  candidates = Array.from({ length: 201 }, (_, i) =>
    candidate(`candidate-${String(i).padStart(4, "0")}`),
  );
  profiles = [];
  const response = await request("?limit=200");
  assert.equal(response.status, 200);
  assert.equal(response.body.data?.length, 200);
  assert.equal(response.body.nextCursor, candidates[199].id);
  assertChildScope(candidates.slice(0, 200).map((c) => c.id));
  assert.equal(reads.find((read) => read.table === schema.candidatesTable)?.limit, 201);
});
