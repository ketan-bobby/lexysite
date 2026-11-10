import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  tenantsTable,
  usersTable,
  tenantAiDocumentsTable,
  workorderAiDocumentsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";

// Real HTTP/auth/SQL controllers; only AI and object storage are substituted.
// Nothing is sent to a provider or written to a real object bucket.
const objects = new Set<string>();
let aiCalls = 0;
let uploaded = 0;
const originalAi = await import("../lib/ai");
mock.module(new URL("../lib/ai.ts", import.meta.url), {
  namedExports: {
    ...originalAi,
    generateWithAI: async () => {
      aiCalls++;
      return "Fixture-only document brief";
    },
  },
});
const originalStorage = await import("../lib/objectStorage");
mock.module(new URL("../lib/objectStorage.ts", import.meta.url), {
  namedExports: {
    ...originalStorage,
    ObjectStorageService: class {
      async uploadBuffer() {
        const key = `/objects/ai-document-fixture-${++uploaded}`;
        objects.add(key);
        return key;
      }
      async deleteObjectByPath(key: string) {
        assert.ok(objects.delete(key), "only fixture objects may be removed");
      }
    },
  },
});
const { default: router } = await import("./ai-documents");

const prefix = `aidoc_${randomUUID()}_`;
const own = `${prefix}own`;
const foreign = `${prefix}foreign`;
const ownJob = `${prefix}job`;
const foreignJob = `${prefix}foreign_job`;
const adminId = `${prefix}admin`;
const candidateId = `${prefix}candidate`;
let server: Server | undefined;
let origin = "";
type Document = {
  id: string;
  tenantId: string;
  jobId?: string;
  storageKey: string;
  fileName: string;
  docType: string;
  distilledBrief: string | null;
};
type Reply = { document?: Document; documents?: Document[]; ok?: boolean; error?: string };

const adminToken = () => issueToken({ userId: adminId, role: "tenant_admin", tenantId: own });
const candidateToken = () => issueToken({ userId: candidateId, role: "candidate", tenantId: own });

async function request(method: string, path: string, token?: string, file = false) {
  const form = new FormData();
  form.set("docType", "other");
  if (file)
    form.set(
      "file",
      new Blob(
        ["Fixture source document with enough factual text for the existing distillation path."],
        { type: "text/plain" },
      ),
      "fixture.txt",
    );
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? form : undefined,
  });
  return { status: response.status, body: (await response.json()) as Reply };
}

async function cleanup() {
  const tenants = [own, foreign];
  await dbAdmin
    .delete(workorderAiDocumentsTable)
    .where(inArray(workorderAiDocumentsTable.tenantId, tenants));
  await dbAdmin
    .delete(tenantAiDocumentsTable)
    .where(inArray(tenantAiDocumentsTable.tenantId, tenants));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, tenants));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, tenants));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, tenants));
}

before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: own, name: "Document fixture", slug: own, plan: "enterprise" },
    { id: foreign, name: "Foreign document fixture", slug: foreign, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: adminId,
      tenantId: own,
      email: `${adminId}@example.test`,
      name: "Fixture admin",
      role: "tenant_admin",
      status: "active",
      passwordHash: "fixture",
    },
    {
      id: candidateId,
      tenantId: own,
      email: `${candidateId}@example.test`,
      name: "Fixture candidate",
      role: "candidate",
      status: "active",
      passwordHash: "fixture",
    },
  ]);
  await dbAdmin.insert(jobsTable).values([
    { id: ownJob, tenantId: own, title: "Fixture role", description: "Fixture", status: "active" },
    {
      id: foreignJob,
      tenantId: foreign,
      title: "Foreign role",
      description: "Fixture",
      status: "active",
    },
  ]);
  const app = express();
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  try {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
  } finally {
    await cleanup();
    mock.restoreAll();
  }
});

for (const scope of ["tenant", "job"] as const) {
  test(`${scope} document upload, read and delete preserve scalar linkage and response contracts`, async () => {
    const path =
      scope === "tenant" ? `/tenants/${own}/ai-documents` : `/jobs/${ownJob}/ai-documents`;
    const created = await request("POST", path, adminToken(), true);
    assert.equal(created.status, 200);
    const doc = created.body.document;
    assert.ok(doc);
    assert.equal(typeof doc.id, "string");
    assert.equal(doc.tenantId, own);
    if (scope === "job") assert.equal(doc.jobId, ownJob);
    assert.equal(doc.fileName, "fixture.txt");
    assert.equal(doc.docType, "other");
    assert.equal(doc.distilledBrief, "Fixture-only document brief");
    assert.ok(objects.has(doc.storageKey));
    const listed = await request("GET", path, adminToken());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.documents?.some((row) => row.id === doc.id));
    const deleted = await request("DELETE", `${path}/${doc.id}`, adminToken());
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
    assert.ok(!objects.has(doc.storageKey));
    const rows =
      scope === "tenant"
        ? await dbAdmin
            .select()
            .from(tenantAiDocumentsTable)
            .where(eq(tenantAiDocumentsTable.id, doc.id))
        : await dbAdmin
            .select()
            .from(workorderAiDocumentsTable)
            .where(eq(workorderAiDocumentsTable.id, doc.id));
    assert.equal(rows.length, 0);
  });
}

test("foreign-tenant and missing-role uploads cannot reach storage or AI", async () => {
  const effects = { aiCalls, uploaded };
  for (const [path, token, expected] of [
    [`/tenants/${foreign}/ai-documents`, adminToken(), 403],
    [`/jobs/${foreignJob}/ai-documents`, adminToken(), 404],
    [`/jobs/${prefix}missing/ai-documents`, adminToken(), 404],
    [`/tenants/${own}/ai-documents`, candidateToken(), 403],
    [`/jobs/${ownJob}/ai-documents`, candidateToken(), 403],
    [`/tenants/${own}/ai-documents`, undefined, 401],
    [`/jobs/${ownJob}/ai-documents`, undefined, 401],
  ] as const) {
    assert.equal((await request("POST", path, token, true)).status, expected);
  }
  assert.deepEqual({ aiCalls, uploaded }, effects);
});

test("missing files return the existing 400 without provider or storage effects", async () => {
  const effects = { aiCalls, uploaded };
  for (const path of [`/tenants/${own}/ai-documents`, `/jobs/${ownJob}/ai-documents`]) {
    const response = await request("POST", path, adminToken());
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /No file attached/);
  }
  assert.deepEqual({ aiCalls, uploaded }, effects);
});
