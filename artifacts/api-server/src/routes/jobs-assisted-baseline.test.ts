import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { jsonObjectSchema, readJsonObject } from "../test-utils/json-response";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  controlDb,
  tenantsTable,
  usersTable,
  jobsTable,
  jobRecruitersTable,
  auditLogsTable,
} from "@workspace/db";
import authRouter from "./auth";
import jobsRouter from "./jobs";
import { issueToken } from "../lib/auth-token";

// Unique fixture ownership; never use existing accounts, requisitions or candidates.
const prefix = `assisted_${randomUUID()}`;
const tenantId = `${prefix}_tenant`;
const foreignTenantId = `${prefix}_foreign`;
const adminId = `${prefix}_admin`;
const foreignAdminId = `${prefix}_foreign_admin`;
const email = `${prefix}@example.invalid`.toLowerCase();
const password = `Baseline-${randomUUID()}`;
const createdJobIds: string[] = [];
let server: Server;
let baseUrl: string;

const token = (foreign = false) =>
  issueToken({
    userId: foreign ? foreignAdminId : adminId,
    role: "tenant_admin",
    tenantId: foreign ? foreignTenantId : tenantId,
  });

async function request(method: string, route: string, body?: unknown, auth = token()) {
  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await readJsonObject(response), response };
}

before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: tenantId, name: "Assisted baseline", slug: `${prefix}_tenant` },
    { id: foreignTenantId, name: "Foreign baseline", slug: `${prefix}_foreign` },
  ]);
  await controlDb.insert(usersTable).values([
    {
      id: adminId,
      tenantId,
      name: "Baseline Admin",
      email,
      passwordHash: await bcrypt.hash(password, 4),
      role: "tenant_admin",
      status: "active",
    },
    {
      id: foreignAdminId,
      tenantId: foreignTenantId,
      name: "Foreign Admin",
      email: `${prefix}_foreign@example.invalid`.toLowerCase(),
      passwordHash: "unused-test-account",
      role: "tenant_admin",
      status: "active",
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", authRouter);
  app.use("/api", jobsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdJobIds.length) {
    await dbAdmin
      .delete(jobRecruitersTable)
      .where(inArray(jobRecruitersTable.jobId, createdJobIds));
  }
  await dbAdmin.delete(auditLogsTable).where(eq(auditLogsTable.tenantId, tenantId));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, tenantId));
  await controlDb.delete(usersTable).where(inArray(usersTable.id, [adminId, foreignAdminId]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId, foreignTenantId]));
});

test("staff login verifies the real password and issues an httpOnly session cookie", async () => {
  const wrong = await request("POST", "/auth/login", { email, password: "incorrect" }, "");
  assert.equal(wrong.status, 401);
  const login = await request("POST", "/auth/login", { email, password }, "");
  assert.equal(login.status, 200);
  assert.equal(jsonObjectSchema.parse(login.body.user).id, adminId);
  const cookies = login.response.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => /httponly/i.test(cookie)));
});

test("assisted create defaults to nonemployee sourcing and preserves the external req number", async () => {
  const created = await request("POST", "/jobs", {
    title: `Baseline ${prefix}`,
    // Below the existing ICP auto-generation threshold: no model work is requested.
    description: "Baseline fixture",
    clientWorkOrderNumber: "CLIENT-BASELINE",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(typeof created.body.id === "string");
  createdJobIds.push(created.body.id);
  assert.equal(created.body.internalMobility, false);
  assert.equal(created.body.clientWorkOrderNumber, "CLIENT-BASELINE");
  assert.ok(created.body.workOrderNumber);
  assert.notEqual(created.body.workOrderNumber, "CLIENT-BASELINE");
});

test("PUT edits and fresh GETs preserve both employee-only and normal sourcing choices", async () => {
  assert.ok(createdJobIds[0]);
  for (const internalMobility of [true, false]) {
    const updated = await request("PUT", `/jobs/${createdJobIds[0]}`, { internalMobility });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const reloaded = await request("GET", `/jobs/${createdJobIds[0]}`);
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.internalMobility, internalMobility);
    const [stored] = await dbAdmin
      .select({ internalMobility: jobsTable.internalMobility })
      .from(jobsTable)
      .where(eq(jobsTable.id, createdJobIds[0]));
    assert.equal(stored.internalMobility, internalMobility);
  }
});

test("an unrelated edit cannot reset sourcing scope or reassign tenant ownership", async () => {
  const id = createdJobIds[0];
  await request("PUT", `/jobs/${id}`, { internalMobility: true });
  const edited = await request("PUT", `/jobs/${id}`, {
    department: "Engineering",
    tenantId: foreignTenantId,
    approvedById: foreignAdminId,
  });
  assert.equal(edited.status, 200);
  const [stored] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, id));
  assert.equal(stored.internalMobility, true);
  assert.equal(stored.tenantId, tenantId);
  assert.equal(stored.department, "Engineering");
});

test("unauthenticated and foreign-tenant callers cannot change a requisition", async () => {
  const id = createdJobIds[0];
  const unauthenticated = await request("PUT", `/jobs/${id}`, { internalMobility: false }, "");
  assert.equal(unauthenticated.status, 401);
  const foreign = await request("PUT", `/jobs/${id}`, { internalMobility: false }, token(true));
  assert.equal(foreign.status, 404);
  const [stored] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, id));
  assert.equal(stored.internalMobility, true);
});

test("invalid sourcing mode is rejected without a partial write", async () => {
  const id = createdJobIds[0];
  const invalid = await request("PUT", `/jobs/${id}`, {
    internalMobility: "yes",
    department: "Must not persist",
  });
  assert.equal(invalid.status, 400);
  const [stored] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, id));
  assert.equal(stored.internalMobility, true);
  assert.equal(stored.department, "Engineering");
});
