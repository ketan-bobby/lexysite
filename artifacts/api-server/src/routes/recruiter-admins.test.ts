/**
 * recruiter-admins.test.ts — Recruiter Admin ↔ Client ASSIGNMENT endpoints
 *
 * Sibling to recruiter-admin-permissions.test.ts, which proves the downstream
 * *data-access* effects of an assignment. THIS file guards the assignment
 * endpoints themselves — the writes a Tenant Admin makes from the UI:
 *
 *   GET  /api/recruiter-admins                 (list + available clients)
 *   PUT  /api/recruiter-admins/:userId/clients (replace-set the assigned clients)
 *   GET  /api/recruiter-admins/my/clients      (recruiter_admin self-service)
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * The scoping is enforced at the APP layer (getAllowedTenantIds + clientType
 * checks), NOT by Postgres RLS, so we exercise the REAL router end-to-end over
 * HTTP without RLS plumbing: outside `withTenantContext` the `db` proxy falls
 * through to `dbAdmin` (BYPASSRLS), which isolates the app-layer logic under test.
 *
 *   • mount the REAL recruiter-admins router on a bare Express app,
 *   • seed a two-agency hierarchy + users via `dbAdmin`,
 *   • issue real bearer tokens with issueToken(), and
 *   • hit the routes with the global fetch() against an ephemeral port.
 *
 * ─── Fixture (all ids prefixed `radm_` for safe teardown) ────────────────────
 *   agency  (parent)
 *    ├─ clientA   (sub_client)
 *    ├─ clientB   (sub_client)
 *    └─ clientC   (sub_client)
 *   other   (a DIFFERENT agency, outside agency's subtree)
 *    └─ otherClient (sub_client under `other`)
 *
 *   raA   — recruiter_admin in `agency`            (the assignment target)
 *   raOther — recruiter_admin in `other`           (outside agency's subtree)
 *   tAdmin / pAdmin / recr / hm — caller roles
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  recruiterAdminClientsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import recruiterAdminsRouter from "./recruiter-admins";

const P = "radm_";
const id = (s: string) => P + s;

const TENANT_IDS = ["agency", "clientA", "clientB", "clientC", "other", "otherClient"].map(id);
const USER_IDS = ["padmin", "tadmin", "recr", "hm", "raa", "raother"].map(id);

let server: Server;
let baseUrl: string;

function tokenFor(userId: string, role: string, tenantId: string | null) {
  return issueToken({ userId, role, tenantId });
}
const tok = {
  pAdmin: () => tokenFor(id("padmin"), "platform_admin", id("agency")),
  tAdmin: () => tokenFor(id("tadmin"), "tenant_admin", id("agency")),
  recr: () => tokenFor(id("recr"), "recruiter", id("agency")),
  hm: () => tokenFor(id("hm"), "hiring_manager", id("agency")),
  raA: () => tokenFor(id("raa"), "recruiter_admin", id("agency")),
  raOther: () => tokenFor(id("raother"), "recruiter_admin", id("other")),
};

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Read the raw assignment rows for a recruiter admin (bypasses the route). */
async function assignedClientIds(recruiterAdminUserId: string): Promise<Set<string>> {
  const rows = await dbAdmin
    .select({ clientTenantId: recruiterAdminClientsTable.clientTenantId })
    .from(recruiterAdminClientsTable)
    .where(eq(recruiterAdminClientsTable.recruiterAdminUserId, recruiterAdminUserId));
  return new Set(rows.map((r) => r.clientTenantId));
}

async function clearAssignments() {
  await dbAdmin.delete(recruiterAdminClientsTable).where(inArray(recruiterAdminClientsTable.tenantId, TENANT_IDS));
}

async function cleanup() {
  await clearAssignments();
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("agency"), name: "RADM Agency", slug: id("agency"), plan: "enterprise" },
    { id: id("clientA"), name: "RADM Client A", slug: id("clientA"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientB"), name: "RADM Client B", slug: id("clientB"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientC"), name: "RADM Client C", slug: id("clientC"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("other"), name: "RADM Other Agency", slug: id("other"), plan: "enterprise" },
    { id: id("otherClient"), name: "RADM Other Client", slug: id("otherClient"), parentId: id("other"), clientType: "sub_client", plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("padmin"), tenantId: id("agency"), email: id("padmin") + "@t.test", name: "PAdmin", passwordHash: "x", role: "platform_admin" },
    { id: id("tadmin"), tenantId: id("agency"), email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin" },
    { id: id("recr"), tenantId: id("agency"), email: id("recr") + "@t.test", name: "Recr", passwordHash: "x", role: "recruiter" },
    { id: id("hm"), tenantId: id("agency"), email: id("hm") + "@t.test", name: "HM", passwordHash: "x", role: "hiring_manager" },
    { id: id("raa"), tenantId: id("agency"), email: id("raa") + "@t.test", name: "RAA", passwordHash: "x", role: "recruiter_admin" },
    { id: id("raother"), tenantId: id("other"), email: id("raother") + "@t.test", name: "RAOther", passwordHash: "x", role: "recruiter_admin" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use("/api", recruiterAdminsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

/* Each test starts from a known assignment state. */
beforeEach(async () => {
  await clearAssignments();
});

const idsOf = (rows: any[] | undefined) => new Set((rows ?? []).map((r) => r.id));

/* ─────────────────────────────────────────────────────────────────────────────
 * PUT /recruiter-admins/:userId/clients — the assignment write.
 * ──────────────────────────────────────────────────────────────────────────── */
test("tenant_admin can assign clients within their subtree (rows written)", async () => {
  const { status, json } = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA"), id("clientB")],
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(new Set(json.clientTenantIds), new Set([id("clientA"), id("clientB")]));
  assert.deepEqual(await assignedClientIds(id("raa")), new Set([id("clientA"), id("clientB")]));
});

test("PUT has replace-set semantics: a second write replaces the prior set", async () => {
  const first = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA"), id("clientB")],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await assignedClientIds(id("raa")), new Set([id("clientA"), id("clientB")]));

  // Replace with just clientC — A and B must be gone, C present.
  const second = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientC")],
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await assignedClientIds(id("raa")), new Set([id("clientC")]));
});

test("PUT with an empty array unassigns all clients", async () => {
  await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA")],
  });
  assert.deepEqual(await assignedClientIds(id("raa")), new Set([id("clientA")]));

  const cleared = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [],
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await assignedClientIds(id("raa")), new Set());
});

test("PUT de-duplicates repeated client ids", async () => {
  const { status, json } = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA"), id("clientA"), id("clientB")],
  });
  assert.equal(status, 200);
  assert.deepEqual(new Set(json.clientTenantIds), new Set([id("clientA"), id("clientB")]));
  assert.deepEqual(await assignedClientIds(id("raa")), new Set([id("clientA"), id("clientB")]));
});

test("PUT rejects a client OUTSIDE the caller's subtree (400, no rows written)", async () => {
  const { status } = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA"), id("otherClient")],
  });
  assert.equal(status, 400);
  // The whole set is rejected — nothing is written.
  assert.deepEqual(await assignedClientIds(id("raa")), new Set());
});

test("PUT rejects a tenant that is NOT a sub_client (400)", async () => {
  // The agency tenant itself is inside the subtree but is not a sub_client.
  const { status } = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("agency")],
  });
  assert.equal(status, 400);
  assert.deepEqual(await assignedClientIds(id("raa")), new Set());
});

test("PUT targeting a NON-recruiter_admin user is 404", async () => {
  const { status } = await api("PUT", `/api/recruiter-admins/${id("recr")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA")],
  });
  assert.equal(status, 404);
});

test("PUT targeting a non-existent user is 404", async () => {
  const { status } = await api("PUT", `/api/recruiter-admins/${id("ghost")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA")],
  });
  assert.equal(status, 404);
});

test("PUT targeting a recruiter_admin OUTSIDE the caller's subtree is 403", async () => {
  const { status } = await api("PUT", `/api/recruiter-admins/${id("raother")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("otherClient")],
  });
  assert.equal(status, 403);
  assert.deepEqual(await assignedClientIds(id("raother")), new Set());
});

test("PUT is forbidden for non-admin roles (recruiter, hiring_manager → 403)", async () => {
  const recr = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.recr(), {
    clientTenantIds: [],
  });
  assert.equal(recr.status, 403);

  const hm = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.hm(), {
    clientTenantIds: [],
  });
  assert.equal(hm.status, 403);
});

test("PUT with a malformed body is rejected by validation (400)", async () => {
  const { status } = await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: "not-an-array",
  });
  assert.equal(status, 400);
});

test("platform_admin can assign a client in ANY agency (no subtree limit)", async () => {
  const { status } = await api("PUT", `/api/recruiter-admins/${id("raother")}/clients`, tok.pAdmin(), {
    clientTenantIds: [id("otherClient")],
  });
  assert.equal(status, 200);
  assert.deepEqual(await assignedClientIds(id("raother")), new Set([id("otherClient")]));
});

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /recruiter-admins — list scoped to the caller's subtree.
 * ──────────────────────────────────────────────────────────────────────────── */
test("GET /recruiter-admins (tenant_admin) is scoped to the agency subtree", async () => {
  await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA")],
  });

  const { status, json } = await api("GET", "/api/recruiter-admins", tok.tAdmin());
  assert.equal(status, 200);

  const admins = idsOf(json.recruiterAdmins);
  assert.ok(admins.has(id("raa")), "should list the in-subtree recruiter admin");
  assert.ok(!admins.has(id("raother")), "must NOT list a recruiter admin in another agency");

  // Available clients = only the caller's sub_client tenants.
  assert.deepEqual(
    idsOf(json.availableClients),
    new Set([id("clientA"), id("clientB"), id("clientC")]),
  );

  // The assigned clients are reported for the listed admin.
  const raaRow = json.recruiterAdmins.find((a: any) => a.id === id("raa"));
  assert.deepEqual(new Set(raaRow.clients.map((c: any) => c.clientTenantId)), new Set([id("clientA")]));
});

test("GET /recruiter-admins (platform_admin) sees admins across all agencies", async () => {
  const { status, json } = await api("GET", "/api/recruiter-admins", tok.pAdmin());
  assert.equal(status, 200);
  const admins = idsOf(json.recruiterAdmins);
  assert.ok(admins.has(id("raa")));
  assert.ok(admins.has(id("raother")), "platform_admin should see recruiter admins in every agency");
});

test("GET /recruiter-admins is forbidden for non-admin roles (403)", async () => {
  const recr = await api("GET", "/api/recruiter-admins", tok.recr());
  assert.equal(recr.status, 403);
  const ra = await api("GET", "/api/recruiter-admins", tok.raA());
  assert.equal(ra.status, 403);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /recruiter-admins/my/clients — recruiter_admin self-service.
 * ──────────────────────────────────────────────────────────────────────────── */
test("GET my/clients returns the caller's OWN assigned clients", async () => {
  await api("PUT", `/api/recruiter-admins/${id("raa")}/clients`, tok.tAdmin(), {
    clientTenantIds: [id("clientA"), id("clientB")],
  });

  const { status, json } = await api("GET", "/api/recruiter-admins/my/clients", tok.raA());
  assert.equal(status, 200);
  assert.deepEqual(idsOf(json.clients), new Set([id("clientA"), id("clientB")]));
});

test("GET my/clients returns [] for a recruiter_admin with zero assignments", async () => {
  const { status, json } = await api("GET", "/api/recruiter-admins/my/clients", tok.raA());
  assert.equal(status, 200);
  assert.deepEqual(json.clients, []);
});

test("GET my/clients is forbidden for non recruiter_admin roles (403)", async () => {
  const ta = await api("GET", "/api/recruiter-admins/my/clients", tok.tAdmin());
  assert.equal(ta.status, 403);
});
