import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import {
  dbAdmin,
  usersTable,
  tenantsTable,
  candidatesTable,
  passwordResetTokensTable,
  inviteTokensTable,
  deletionRequestsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { closeCandidateAccount, collectClosingAccountAvatars } from "./candidate-account-erasure";
import { stageErasureCleanup, serializeErasureRequest } from "./erasure-cleanup";
import { rejectErasedAccount } from "../middlewares/rejectErasedAccount";
import { resolveUser } from "../middlewares/resolveUser";
import { issueToken, SESSION_COOKIE_NAME } from "./auth-token";
import authRouter from "../routes/auth";
import publicRouter from "../routes/public";

const prefix = `account-erasure-${randomUUID()}`;
const tenant = `${prefix}-tenant`;
const users: string[] = [],
  candidates: string[] = [];
let server: Server, base: string;

const password = "DisposableFixturePassword123!";
let passwordHash: string;
before(async () => {
  passwordHash = await bcrypt.hash(password, 4);
  await dbAdmin.insert(tenantsTable).values({
    id: tenant,
    slug: tenant,
    name: "Disposable account-erasure fixture",
    country: "US",
    region: "us",
  });
  const app = express();
  app.use(express.json(), cookieParser(), rejectErasedAccount);
  app.use(authRouter);
  app.use("/public", publicRouter);
  app.get("/protected", resolveUser, (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin.transaction(async (tx) => {
    if (candidates.length) {
      await tx
        .delete(deletionRequestsTable)
        .where(inArray(deletionRequestsTable.candidateId, candidates));
      await tx.delete(candidatesTable).where(inArray(candidatesTable.id, candidates));
    }
    if (users.length) {
      await tx
        .delete(passwordResetTokensTable)
        .where(inArray(passwordResetTokensTable.userId, users));
      await tx.delete(inviteTokensTable).where(inArray(inviteTokensTable.userId, users));
      await tx.delete(usersTable).where(inArray(usersTable.id, users));
    }
    await tx.delete(tenantsTable).where(eq(tenantsTable.id, tenant));
  });
});

async function fixture(role: "candidate" | "recruiter" = "candidate") {
  const userId = `${prefix}-${randomUUID()}`;
  const candidateId = `${prefix}-${randomUUID()}`;
  users.push(userId);
  candidates.push(candidateId);
  await dbAdmin.insert(usersTable).values({
    id: userId,
    tenantId: tenant,
    email: `${randomUUID()}@example.invalid`,
    name: "Disposable candidate",
    role,
    passwordHash,
    avatarUrl: "/objects/disposable-avatar",
    timezone: "Asia/Kolkata",
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId: tenant,
    userId,
    firstName: "Disposable",
    lastName: "Fixture",
    email: `${randomUUID()}@example.invalid`,
  });
  const resetToken = randomUUID();
  await dbAdmin.insert(passwordResetTokensTable).values({
    userId,
    tokenHash: createHash("sha256").update(resetToken).digest("hex"),
    expiresAt: new Date(Date.now() + 3600000),
  });
  await dbAdmin.insert(inviteTokensTable).values({
    candidateId,
    userId,
    tenantId: tenant,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000),
  });
  const [original] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, userId));
  return { userId, candidateId, resetToken, original: original! };
}
async function request(path: string, token?: string, cookie = false, body?: unknown) {
  return fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token
        ? cookie
          ? { cookie: `${SESSION_COOKIE_NAME}=${token}` }
          : { authorization: `Bearer ${token}` }
        : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("candidate-only closure scrubs identity, revokes recovery links and records its outcome", async () => {
  const f = await fixture();
  const receipt = await dbAdmin.transaction(async (tx) => {
    const avatars = await collectClosingAccountAvatars(tx, f.candidateId);
    assert.deepEqual(avatars, [f.original.avatarUrl]);
    const id = await stageErasureCleanup(tx, {
      candidateId: f.candidateId,
      origin: "fixture",
      paths: avatars,
    });
    assert.equal(await closeCandidateAccount(tx, f.candidateId), "closed");
    return id;
  });
  const [closed] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, f.userId));
  assert.ok(closed!.accountErasedAt);
  assert.equal(closed!.status, "suspended");
  assert.equal(closed!.name, "Deleted candidate");
  assert.match(closed!.email, /^erased\+[a-f0-9]{40}@deleted\.invalid$/);
  assert.equal(closed!.avatarUrl, null);
  assert.equal(closed!.timezone, "UTC");
  assert.equal(closed!.notificationFrequency, "off");
  assert.notEqual(closed!.passwordHash, f.original.passwordHash);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, f.userId))
    ).length,
    0,
  );
  assert.equal(
    (await dbAdmin.select().from(inviteTokensTable).where(eq(inviteTokensTable.userId, f.userId)))
      .length,
    0,
  );
  const [row] = await dbAdmin
    .select()
    .from(deletionRequestsTable)
    .where(eq(deletionRequestsTable.id, receipt));
  assert.equal(serializeErasureRequest(row!).cleanup!.account, "closed");
});

test("already-issued bearer and cookie sessions, password login and old reset links cannot reopen an erased account", async () => {
  const f = await fixture();
  const token = issueToken({ userId: f.userId, role: "candidate", tenantId: tenant, region: "us" });
  assert.equal(
    (
      await request("/auth/candidate-login", undefined, false, {
        email: f.original.email,
        password,
      })
    ).status,
    200,
  );
  assert.equal((await request("/protected", token)).status, 200);
  await dbAdmin.transaction((tx) => closeCandidateAccount(tx, f.candidateId));
  // Even an accidental status-only reactivation cannot revive the old identity.
  await dbAdmin
    .update(usersTable)
    .set({ status: "active", passwordHash: f.original.passwordHash })
    .where(eq(usersTable.id, f.userId));
  assert.equal((await request("/protected", token)).status, 401);
  const cookie = await request("/auth/me", token, true);
  assert.equal(cookie.status, 401);
  assert.match(cookie.headers.get("set-cookie") ?? "", /session_token=/);
  assert.equal(
    (
      await request("/auth/candidate-login", undefined, false, {
        email: f.original.email,
        password,
      })
    ).status,
    401,
  );
  const [closed] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, f.userId));
  assert.equal(
    (
      await request("/auth/candidate-login", undefined, false, {
        email: closed!.email,
        password,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/public/reset-password", undefined, false, {
        token: f.resetToken,
        password: "FreshPassword123!",
      })
    ).status,
    400,
  );
  const forgot = await request("/public/forgot-password", undefined, false, {
    email: closed!.email,
  });
  assert.equal(forgot.status, 200);
  assert.deepEqual(await forgot.json(), { ok: true });
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, f.userId))
    ).length,
    0,
  );
});

test("shared staff identity, credentials and recovery links survive candidate erasure", async () => {
  const f = await fixture("recruiter");
  const token = issueToken({ userId: f.userId, role: "recruiter", tenantId: tenant, region: "us" });
  await dbAdmin.transaction(async (tx) => {
    assert.deepEqual(await collectClosingAccountAvatars(tx, f.candidateId), []);
    assert.equal(await closeCandidateAccount(tx, f.candidateId), "staff_identity_preserved");
  });
  const [staff] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, f.userId));
  assert.deepEqual(staff, f.original);
  assert.equal((await request("/protected", token)).status, 200);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, f.userId))
    ).length,
    1,
  );
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, f.candidateId));
  assert.equal(candidate!.userId, null);
});

test("another live owned profile defers closure; erasing the last profile closes the identity", async () => {
  const f = await fixture();
  const peer = `${prefix}-${randomUUID()}`;
  candidates.push(peer);
  await dbAdmin.insert(candidatesTable).values({
    id: peer,
    tenantId: tenant,
    userId: f.userId,
    email: `${randomUUID()}@example.invalid`,
    firstName: "Other",
    lastName: "Fixture",
  });
  await dbAdmin.transaction(async (tx) => {
    assert.deepEqual(await collectClosingAccountAvatars(tx, f.candidateId), []);
    assert.equal(await closeCandidateAccount(tx, f.candidateId), "other_profiles_remaining");
  });
  const [preserved] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, f.userId));
  assert.deepEqual(preserved, f.original);
  await dbAdmin.transaction(async (tx) =>
    assert.equal(await closeCandidateAccount(tx, peer), "closed"),
  );
});

test("rollback restores credentials and tokens; email-only matches never disable unrelated users", async () => {
  const f = await fixture();
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      await closeCandidateAccount(tx, f.candidateId);
      throw new Error("fixture rollback");
    }),
    /fixture rollback/,
  );
  const [restored] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, f.userId));
  assert.deepEqual(restored, f.original);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, f.userId))
    ).length,
    1,
  );
  await dbAdmin
    .update(candidatesTable)
    .set({ userId: null, email: f.original.email })
    .where(eq(candidatesTable.id, f.candidateId));
  assert.equal(
    await dbAdmin.transaction((tx) => closeCandidateAccount(tx, f.candidateId)),
    "no_linked_identity",
  );
  const [untouched] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, f.userId));
  assert.deepEqual(untouched, f.original);
});
