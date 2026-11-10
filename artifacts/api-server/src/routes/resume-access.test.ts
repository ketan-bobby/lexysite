import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  candidatesTable,
  candidateImportRecordsTable,
  candidateImportBatchesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { s3Client } from "../lib/s3";
import { assertResumeUploadOwned, bindCandidateResume } from "../lib/candidate-resume-access";

// A private-process test credential, NOT a project secret or an enabled live importer.
process.env.LEXY_IMPORT_API_KEY = "isolated-resume-contract-test";
const ai = await import("../lib/ai");
mock.module(new URL("../lib/ai.ts", import.meta.url), {
  namedExports: {
    ...ai,
    generateJSON: async () => ({
      firstName: "Fictional",
      lastName: "Import",
      email: "resume-contract@example.invalid",
      skills: ["PostgreSQL", "SQL"],
      currentTitle: "Database Engineer",
      currentCompany: "Fictional Company",
      location: "Test Location",
    }),
  },
});
const { default: storageRouter } = await import("./storage");
const { default: candidatesRouter } = await import("./candidates");
const { default: importRouter } = await import("./candidate-import");

const prefix = `racc_${randomUUID()}`;
const tenantA = `${prefix}_a`,
  tenantB = `${prefix}_b`;
const adminA = `${prefix}_admin`,
  peer = `${prefix}_peer`,
  outsider = `${prefix}_foreign`;
const candidateId = `${prefix}_candidate`,
  claimantId = `${prefix}_claimant`;
const objects = new Map<
  string,
  { bytes: Buffer; type: string; tags?: { Key: string; Value: string }[] }
>();
let failUpload = false;
let denyTagPermission = false;
const s3 = mock.method(s3Client, "send", async (command: any) => {
  const input = command.input;
  if (command.constructor.name === "PutObjectCommand") {
    if (failUpload) throw new Error("Test storage failure");
    if (denyTagPermission && input.Tagging) {
      throw Object.assign(new Error("Test missing S3 tagging permission"), {
        name: "AccessDenied",
      });
    }
    const tags = input.Tagging
      ? Array.from(new URLSearchParams(input.Tagging), ([Key, Value]) => ({ Key, Value }))
      : [];
    for (const tag of tags) {
      assert.ok(tag.Value.length <= 256);
      assert.match(tag.Value, /^[\p{L}\p{N}\p{Z}+\-=._:/@]*$/u);
    }
    objects.set(input.Key, { bytes: Buffer.from(input.Body), type: input.ContentType, tags });
    return { ETag: "fixture" };
  }
  const object = objects.get(input.Key);
  if (!object) throw Object.assign(new Error("Missing fixture"), { name: "NotFound" });
  switch (command.constructor.name) {
    case "HeadObjectCommand":
      return { ContentType: object.type, ContentLength: object.bytes.length };
    case "GetObjectTaggingCommand":
      return {
        TagSet: object.tags ?? [],
      };
    case "PutObjectTaggingCommand":
      for (const tag of input.Tagging.TagSet) {
        assert.ok(tag.Value.length <= 256, "S3 tag values must fit the provider limit");
        assert.match(tag.Value, /^[\p{L}\p{N}\p{Z}+\-=._:/@]*$/u, "S3 rejects JSON punctuation");
      }
      object.tags = input.Tagging.TagSet;
      return {};
    case "GetObjectCommand":
      return {
        Body: Readable.from([object.bytes]),
        ContentType: object.type,
        ContentLength: object.bytes.length,
      };
    default:
      throw new Error(`Unexpected storage operation: ${command.constructor.name}`);
  }
});

test("missing storage tagging permission returns actionable 503 without storing an unowned file", async () => {
  const before = objects.size;
  denyTagPermission = true;
  try {
    const result = await request("/storage/uploads/file", "POST", document());
    assert.equal(result.status, 503);
    assert.equal((await result.json()).code, "resume_storage_permissions");
    assert.equal(objects.size, before);
  } finally {
    denyTagPermission = false;
  }
});
let server: ReturnType<express.Express["listen"]>, base: string, path: string;
const token = (id = adminA, tenantId = tenantA) =>
  issueToken({ userId: id, role: "tenant_admin", tenantId });
async function request(
  route: string,
  method = "GET",
  body?: unknown,
  auth: string | null = token(),
): Promise<
  Omit<Awaited<ReturnType<typeof fetch>>, "json"> & { json(): Promise<Record<string, any>> }
> {
  return fetch(base + route, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  }) as Promise<
    Omit<Awaited<ReturnType<typeof fetch>>, "json"> & { json(): Promise<Record<string, any>> }
  >;
}
function document(docx = false) {
  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [
        docx
          ? new Uint8Array(
              readFileSync(
                new URL("../../../../docs/qa/fixtures/native-resume.docx", import.meta.url),
              ),
            )
          : "%PDF-fixture",
      ],
      {
        type: docx
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/pdf",
      },
    ),
    docx ? "fictional.docx" : "fictional.pdf",
  );
  return form;
}
async function importDocument(key = process.env.LEXY_IMPORT_API_KEY!) {
  const form = new FormData();
  form.append(
    "resume",
    new Blob(
      [
        new Uint8Array(
          readFileSync(new URL("../../../../docs/qa/fixtures/native-resume.docx", import.meta.url)),
        ),
      ],
      { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    ),
    "fictional.docx",
  );
  form.append("tenantId", tenantA);
  return request("/candidates/import", "POST", form, key);
}

before(async () => {
  await dbAdmin.insert(tenantsTable).values(
    [tenantA, tenantB].map((id) => ({
      id,
      name: "Isolated résumé fixture",
      slug: id,
      type: "client" as const,
      status: "active" as const,
    })),
  );
  await dbAdmin.insert(usersTable).values(
    [
      { id: adminA, tenantId: tenantA },
      { id: peer, tenantId: tenantA },
      { id: outsider, tenantId: tenantB },
    ].map((user) => ({
      ...user,
      role: "tenant_admin" as const,
      status: "active" as const,
      name: "Fictional Reviewer",
      email: `${user.id}@example.invalid`,
      passwordHash: "not-a-login-password",
    })),
  );
  await dbAdmin.insert(candidatesTable).values(
    [candidateId, claimantId].map((id) => ({
      id,
      tenantId: tenantA,
      firstName: "Fictional",
      lastName: "Fixture",
      email: id === candidateId ? "resume-contract@example.invalid" : `${id}@example.invalid`,
      skills: ["Manual fixture skill"],
      pool: "tenant" as const,
      verificationResult: { syntheticFixture: { kind: "staff_inbox" } },
    })),
  );
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(storageRouter, candidatesRouter, importRouter);
  app.use((error: Error, _req: any, res: any, _next: any) =>
    res.status(500).json({ error: error.message }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

test("new upload has private ownership, and anonymous access fails", async () => {
  const response = await request("/storage/uploads/file", "POST", document());
  assert.equal(response.status, 200);
  path = (await response.json()).objectPath;
  assert.match(path, /^\/objects\/resumes\//);
  assert.equal((await request(`/storage${path}`, "GET", undefined, null)).status, 401);
  assert.equal((await request(`/storage${path}`)).status, 200);
  await dbAdmin.update(usersTable).set({ tenantId: tenantB }).where(eq(usersTable.id, adminA));
  assert.equal((await request(`/storage${path}`)).status, 403);
  await assert.rejects(() =>
    assertResumeUploadOwned(path, { id: adminA, role: "tenant_admin", tenantId: tenantB }),
  );
  await dbAdmin.update(usersTable).set({ tenantId: tenantA }).where(eq(usersTable.id, adminA));
  await assert.rejects(() =>
    assertResumeUploadOwned(path, { id: outsider, role: "tenant_admin", tenantId: tenantB }),
  );
});

test("bound résumé allows another authorised staff member, rejects outsiders and stale uploader grants", async () => {
  await dbAdmin
    .update(candidatesTable)
    .set({ resumeUrl: path })
    .where(eq(candidatesTable.id, candidateId));
  await bindCandidateResume(
    path,
    { id: adminA, role: "tenant_admin", tenantId: tenantA },
    candidateId,
  );
  const read = await request(`/storage${path}`, "GET", undefined, token(peer));
  assert.equal(read.status, 200);
  assert.equal(await read.text(), "%PDF-fixture");
  assert.match(read.headers.get("cache-control") ?? "", /private/);
  assert.match(read.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(
    (await request(`/storage${path}`, "GET", undefined, token(outsider, tenantB))).status,
    403,
  );
  assert.equal(
    (await request(`/storage/object-url${path}`, "GET", undefined, token(outsider, tenantB)))
      .status,
    403,
  );
  await dbAdmin.update(usersTable).set({ tenantId: tenantB }).where(eq(usersTable.id, adminA));
  assert.equal((await request(`/storage${path}`)).status, 403);
  await dbAdmin.update(usersTable).set({ tenantId: tenantA }).where(eq(usersTable.id, adminA));
});

test("foreign file claims are rejected by attachment, creation and general update", async () => {
  assert.equal(
    (await request(`/candidates/${claimantId}/resume`, "POST", { objectPath: path })).status,
    403,
  );
  assert.equal(
    (await request(`/candidates/${claimantId}`, "PUT", { resumeUrl: path })).status,
    403,
  );
  assert.equal(
    (
      await request("/candidates", "POST", {
        firstName: "Other",
        lastName: "Fixture",
        email: `${prefix}@example.invalid`,
        resumeObjectPath: path,
      })
    ).status,
    403,
  );
  const [row] = await dbAdmin
    .select({ resumeUrl: candidatesTable.resumeUrl })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, claimantId));
  assert.equal(row.resumeUrl, null);
});

test("current privacy, erased state, replacement and suspended account revoke reads", async () => {
  for (const patch of [{ doNotContact: true }, { dataErasedAt: new Date() }, { resumeUrl: null }]) {
    await dbAdmin.update(candidatesTable).set(patch).where(eq(candidatesTable.id, candidateId));
    assert.equal((await request(`/storage${path}`)).status, 403);
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: false, dataErasedAt: null, resumeUrl: path })
      .where(eq(candidatesTable.id, candidateId));
  }
  await dbAdmin.update(usersTable).set({ status: "suspended" }).where(eq(usersTable.id, peer));
  assert.equal((await request(`/storage${path}`, "GET", undefined, token(peer))).status, 403);
});

test("bulk importer retains its key gate, preserves duplicate pointer and unions skills", async () => {
  assert.equal((await importDocument("wrong-fixture-key")).status, 401);
  const imported = await importDocument();
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).resumeUrl, path);
  const [row] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId));
  assert.ok(row.skills?.includes("Manual fixture skill"));
  assert.ok(row.skills?.includes("PostgreSQL"));
  assert.equal(row.currentTitle, "Database Engineer");
  await dbAdmin
    .update(candidatesTable)
    .set({ resumeUrl: null })
    .where(eq(candidatesTable.id, candidateId));
  const filled = await importDocument();
  assert.equal(filled.status, 200, await filled.clone().text());
  const filledPath = (await filled.json()).resumeUrl;
  assert.equal((await request(`/storage${filledPath}`)).status, 200);
});

test("storage failure is explicit, never an apparently successful résumé-less import", async () => {
  failUpload = true;
  assert.equal((await importDocument()).status, 503);
  failUpload = false;
});

test("successful native attachment, general update and create establish readable bindings", async () => {
  const upload = async () => {
    const response = await request("/storage/uploads/file", "POST", document(true));
    assert.equal(response.status, 200);
    return (await response.json()).objectPath as string;
  };
  const first = await upload();
  const attached = await request(`/candidates/${claimantId}/resume`, "POST", { objectPath: first });
  assert.equal(attached.status, 200, await attached.clone().text());
  assert.ok((await attached.json()).skills.includes("SQL"));
  assert.equal((await request(`/storage${first}`)).status, 200);
  const second = await upload();
  assert.equal(
    (await request(`/candidates/${claimantId}`, "PUT", { resumeUrl: second })).status,
    200,
  );
  assert.equal((await request(`/storage${first}`)).status, 403);
  assert.equal((await request(`/storage${second}`)).status, 200);
  const third = await upload();
  const created = await request("/candidates", "POST", {
    firstName: "Fictional",
    lastName: "Created",
    email: `${prefix}_new@example.invalid`,
    resumeObjectPath: third,
  });
  assert.equal(created.status, 201, await created.clone().text());
  await dbAdmin
    .update(candidatesTable)
    .set({
      verificationResult: { syntheticFixture: { kind: "staff_inbox" } },
    })
    .where(eq(candidatesTable.id, (await created.json()).id));
  assert.equal((await request(`/storage${third}`)).status, 200);
});

test("new bulk-import candidate receives a bound file and complete parsed fields", async () => {
  await dbAdmin
    .update(candidatesTable)
    .set({ email: `${prefix}_old@example.invalid` })
    .where(eq(candidatesTable.id, candidateId));
  const response = await importDocument();
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  await dbAdmin
    .update(candidatesTable)
    .set({
      verificationResult: { syntheticFixture: { kind: "staff_inbox" } },
    })
    .where(eq(candidatesTable.id, result.candidateId));
  const [row] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, result.candidateId));
  assert.equal(row.pool, "tenant");
  assert.equal(row.currentCompany, "Fictional Company");
  assert.equal(row.location, "Test Location");
  assert.equal(row.resumeUrl, result.resumeUrl);
  assert.equal((await request(`/storage${result.resumeUrl}`)).status, 200);
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin
    .delete(candidateImportRecordsTable)
    .where(eq(candidateImportRecordsTable.tenantId, tenantA));
  await dbAdmin
    .delete(candidateImportBatchesTable)
    .where(eq(candidateImportBatchesTable.tenantId, tenantA));
  await dbAdmin
    .delete(candidatesTable)
    .where(inArray(candidatesTable.tenantId, [tenantA, tenantB]));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, [tenantA, tenantB]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
  s3.mock.restore();
  await pool.end();
});
