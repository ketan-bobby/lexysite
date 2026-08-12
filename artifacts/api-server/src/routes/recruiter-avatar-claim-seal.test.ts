/**
 * recruiter-avatar-claim-seal.test.ts — Seals the avatar-claim cross-tenant
 * read hole (the profile photo pointer doubles as a READ GRANT).
 *
 * The storage read path (GET /storage/objects/*) has a namespace fallback for
 * /objects/recruiter-avatars/… that authorizes from the owning
 * recruiter_avatar_profiles row. That makes POST /recruiter-avatar/profile
 * security-critical: if it accepted an arbitrary caller-supplied path, a staff
 * user could "claim" ANY private object (e.g. another company's resume in
 * /objects/uploads/…) as their avatar and then read it — cross-tenant IDOR.
 *
 * Sealed behavior locked in here:
 *   1. Claiming a generic /objects/uploads/… path → 400, and the object stays
 *      unreadable via GET /api/storage/objects/… afterwards.
 *   2. Claiming a path already pinned to ANOTHER recruiter's profile → 409,
 *      and it stays unreadable to the attacker afterwards.
 *   3. Legitimate reads still work for photo AND intro video: the owning
 *      recruiter, in-scope staff (tenant subtree), and a recruiter_admin whose
 *      DATA SCOPE (recruiter_admin_clients) covers the asset's tenant.
 *   4. Out-of-scope staff, scope-less recruiter_admins, and non-staff strangers
 *      get 403; unauthenticated gets 401.
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * Mounts the REAL storage + recruiter-avatar routers on a bare Express app,
 * seeds tenants/users/profiles via dbAdmin (outside withTenantContext the `db`
 * proxy falls through to dbAdmin, so RLS never filters — isolating the
 * app-layer gates), uploads tiny REAL objects via uploadBuffer (which writes
 * NO ACL tag — exactly the state the fallbacks exist for), and drives the
 * routes over HTTP with real bearer tokens. Fixture ids prefixed `acs_`;
 * uploaded objects are deleted in teardown.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  recruiterAvatarProfilesTable,
  recruiterAvatarVideoJobsTable,
  recruiterAdminClientsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { ObjectStorageService } from "../lib/objectStorage";
import storageRouter from "./storage";
import recruiterAvatarRouter from "./recruiter-avatar";

const P = "acs_";
const id = (s: string) => P + s;

/* Tenant layout:
 *   agency (parent)
 *     ├── clientA  — ownerA's tenant (avatar photo + intro video live here)
 *     └── clientB  — attacker's tenant (sibling client; must NOT read clientA)
 *   strangerTx     — unrelated tenant entirely
 */
const TENANT_IDS = ["agency", "clientA", "clientB", "strangerTx"].map(id);
const USER_IDS = [
  "ownerA", // recruiter in clientA — legitimate owner of the avatar assets
  "victimB", // recruiter in clientB — owns a pinned avatar the attacker covets
  "attacker", // recruiter in clientA — sibling-client attacker vs victimB (clientB)
  "agencyAdmin", // tenant_admin in agency — subtree covers clientA (in scope)
  "raScoped", // recruiter_admin in agency, data scope → clientA (in scope)
  "raUnscoped", // recruiter_admin in agency, NO client assignments (empty scope)
  "outsideAdmin", // tenant_admin in strangerTx — out of scope
  "candStranger", // candidate — non-staff
].map(id);

let server: Server;
let baseUrl: string;
let resumePath: string; // /objects/uploads/…            (victim's private doc)
let avatarAPath: string; // /objects/recruiter-avatars/…  (pinned to ownerA)
let avatarBPath: string; // /objects/recruiter-avatars/…  (pinned to victimB)
let videoAPath: string; // /objects/recruiter-intros/…   (ownerA's intro MP4)

const storage = new ObjectStorageService();

const tok = {
  ownerA: () => issueToken({ userId: id("ownerA"), role: "recruiter", tenantId: id("clientA") }),
  attacker: () =>
    issueToken({ userId: id("attacker"), role: "recruiter", tenantId: id("clientA") }),
  agencyAdmin: () =>
    issueToken({ userId: id("agencyAdmin"), role: "tenant_admin", tenantId: id("agency") }),
  raScoped: () =>
    issueToken({ userId: id("raScoped"), role: "recruiter_admin", tenantId: id("agency") }),
  raUnscoped: () =>
    issueToken({ userId: id("raUnscoped"), role: "recruiter_admin", tenantId: id("agency") }),
  outsideAdmin: () =>
    issueToken({ userId: id("outsideAdmin"), role: "tenant_admin", tenantId: id("strangerTx") }),
  candStranger: () =>
    issueToken({ userId: id("candStranger"), role: "candidate", tenantId: id("strangerTx") }),
};

async function readObject(objectPath: string, token?: string): Promise<number> {
  const res = await fetch(baseUrl + "/storage" + objectPath, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // Drain/cancel the body so the socket is released.
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
  return res.status;
}

async function claimAvatar(
  avatarImageObjectPath: string,
  token: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + "/recruiter-avatar/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ avatarImageObjectPath }),
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function cleanupDb() {
  await dbAdmin
    .delete(recruiterAvatarVideoJobsTable)
    .where(inArray(recruiterAvatarVideoJobsTable.tenantId, TENANT_IDS));
  await dbAdmin
    .delete(recruiterAvatarProfilesTable)
    .where(inArray(recruiterAvatarProfilesTable.recruiterUserId, USER_IDS));
  await dbAdmin
    .delete(recruiterAdminClientsTable)
    .where(inArray(recruiterAdminClientsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

before(async () => {
  await cleanupDb();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("agency"), name: "ACS Agency", slug: id("agency"), plan: "enterprise" },
    {
      id: id("clientA"),
      name: "ACS Client A",
      slug: id("clientA"),
      plan: "enterprise",
      parentId: id("agency"),
    },
    {
      id: id("clientB"),
      name: "ACS Client B",
      slug: id("clientB"),
      plan: "enterprise",
      parentId: id("agency"),
    },
    { id: id("strangerTx"), name: "ACS Stranger", slug: id("strangerTx"), plan: "enterprise" },
  ]);

  const u = (uid: string, tenantId: string, role: string) => ({
    id: id(uid),
    tenantId,
    email: id(uid) + "@t.test",
    name: uid,
    passwordHash: "x",
    role,
  });
  await dbAdmin
    .insert(usersTable)
    .values([
      u("ownerA", id("clientA"), "recruiter"),
      u("victimB", id("clientB"), "recruiter"),
      u("attacker", id("clientA"), "recruiter"),
      u("agencyAdmin", id("agency"), "tenant_admin"),
      u("raScoped", id("agency"), "recruiter_admin"),
      u("raUnscoped", id("agency"), "recruiter_admin"),
      u("outsideAdmin", id("strangerTx"), "tenant_admin"),
      u("candStranger", id("strangerTx"), "candidate"),
    ]);

  // raScoped's data scope covers clientA (direct client assignment).
  await dbAdmin.insert(recruiterAdminClientsTable).values({
    tenantId: id("agency"),
    recruiterAdminUserId: id("raScoped"),
    clientTenantId: id("clientA"),
  });

  // Real (untagged) objects — exactly what uploadBuffer produces in prod.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  resumePath = await storage.uploadBuffer(
    Buffer.from("acs private resume"),
    "application/pdf",
    "uploads",
  );
  avatarAPath = await storage.uploadBuffer(png, "image/png", "recruiter-avatars");
  avatarBPath = await storage.uploadBuffer(png, "image/png", "recruiter-avatars");
  videoAPath = await storage.uploadBuffer(
    Buffer.from([1, 2, 3, 4]),
    "video/mp4",
    "recruiter-intros",
  );

  // Pin avatars: ownerA ← avatarA, victimB ← avatarB.
  const [profileA] = await dbAdmin
    .insert(recruiterAvatarProfilesTable)
    .values([
      {
        recruiterUserId: id("ownerA"),
        tenantId: id("clientA"),
        avatarImageObjectPath: avatarAPath,
        consentConfirmed: true,
        status: "ready",
      },
    ])
    .returning();
  await dbAdmin.insert(recruiterAvatarProfilesTable).values([
    {
      recruiterUserId: id("victimB"),
      tenantId: id("clientB"),
      avatarImageObjectPath: avatarBPath,
      consentConfirmed: true,
      status: "ready",
    },
  ]);

  // ownerA's completed intro video job (owns videoAPath).
  await dbAdmin.insert(recruiterAvatarVideoJobsTable).values({
    recruiterAvatarProfileId: profileA.id,
    tenantId: id("clientA"),
    language: "en-US",
    scriptText: "hello",
    scriptHash: "acs_hash",
    status: "completed",
    outputVideoObjectPath: videoAPath,
  });

  const app = express();
  app.use(express.json());
  // The routers log denials via req.log (pino-http in prod); stub it here.
  app.use((req: any, _res, next) => {
    req.log = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use(storageRouter);
  app.use(recruiterAvatarRouter);
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  server?.close();
  await cleanupDb();
  // Best-effort S3 cleanup of the four tiny objects.
  for (const p of [resumePath, avatarAPath, avatarBPath, videoAPath]) {
    if (!p) continue;
    const rel = p.replace(/^\/objects\//, "");
    try {
      await storage.deleteObjectsUnderPrefix(rel);
    } catch {
      /* best-effort */
    }
  }
});

// ── 1. Claiming a foreign generic upload is rejected AND grants nothing ──────

test("claiming a generic /objects/uploads/… path (a resume) → 400", async () => {
  const { status } = await claimAvatar(resumePath, tok.attacker());
  assert.equal(status, 400);
});

test("after the rejected claim, the resume stays unreadable (403)", async () => {
  assert.equal(await readObject(resumePath, tok.attacker()), 403);
});

test("resume is also unreadable to its own would-be claimer via object-url presign route", async () => {
  const res = await fetch(baseUrl + "/storage/object-url" + resumePath, {
    headers: { Authorization: `Bearer ${tok.attacker()}` },
  });
  await res.arrayBuffer().catch(() => {});
  assert.equal(res.status, 403);
});

// ── 2. Re-claiming another recruiter's pinned avatar is rejected ─────────────

test("claiming a path pinned to ANOTHER recruiter's profile → 409", async () => {
  const { status } = await claimAvatar(avatarBPath, tok.attacker());
  assert.equal(status, 409);
});

test("after the 409, victim's avatar stays unreadable to the attacker (sibling client) → 403", async () => {
  assert.equal(await readObject(avatarBPath, tok.attacker()), 403);
});

test("re-claiming YOUR OWN pinned path is fine (idempotent self-claim) → 200", async () => {
  const { status, json } = await claimAvatar(avatarAPath, tok.ownerA());
  assert.equal(status, 200);
  assert.equal(json?.avatarImageObjectPath, avatarAPath);
});

// ── 3. Legitimate reads: photo ────────────────────────────────────────────────

test("owner reads own avatar photo → 200", async () => {
  assert.equal(await readObject(avatarAPath, tok.ownerA()), 200);
});

test("in-scope staff (agency tenant_admin, subtree) reads avatar photo → 200", async () => {
  assert.equal(await readObject(avatarAPath, tok.agencyAdmin()), 200);
});

test("recruiter_admin WITH data scope over the asset's tenant reads photo → 200", async () => {
  assert.equal(await readObject(avatarAPath, tok.raScoped()), 200);
});

// ── 3b. Legitimate reads: intro video ────────────────────────────────────────

test("owner reads own intro video → 200", async () => {
  assert.equal(await readObject(videoAPath, tok.ownerA()), 200);
});

test("in-scope staff (agency tenant_admin) reads intro video → 200", async () => {
  assert.equal(await readObject(videoAPath, tok.agencyAdmin()), 200);
});

test("recruiter_admin WITH data scope reads intro video → 200", async () => {
  assert.equal(await readObject(videoAPath, tok.raScoped()), 200);
});

// ── 4. Denials ────────────────────────────────────────────────────────────────

test("recruiter_admin WITHOUT any client scope → 403 on photo AND video", async () => {
  assert.equal(await readObject(avatarAPath, tok.raUnscoped()), 403);
  assert.equal(await readObject(videoAPath, tok.raUnscoped()), 403);
});

test("out-of-scope staff (unrelated tenant admin) → 403 on photo AND video", async () => {
  assert.equal(await readObject(avatarAPath, tok.outsideAdmin()), 403);
  assert.equal(await readObject(videoAPath, tok.outsideAdmin()), 403);
});

test("non-staff stranger (candidate) → 403 on photo AND video", async () => {
  assert.equal(await readObject(avatarAPath, tok.candStranger()), 403);
  assert.equal(await readObject(videoAPath, tok.candStranger()), 403);
});

test("unauthenticated → 401 before existence is revealed", async () => {
  assert.equal(await readObject(avatarAPath), 401);
  assert.equal(await readObject(videoAPath), 401);
});
