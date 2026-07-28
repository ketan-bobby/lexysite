/**
 * career-register-enumeration.test.ts
 * ────────────────────────────────────────────────────────────────────────────
 * PERMANENT regression net for LEAK B: the unauthenticated, internet-facing
 * POST /public/career-register self-registration endpoint MUST NOT behave as an
 * account-enumeration oracle.
 *
 * Before the fix, the handler returned a 409 ("email already exists") for a
 * known address and a 201 with a session token for a new one — so anyone could
 * probe an arbitrary email and learn whether that person holds a Lexy career
 * account (i.e. "this person is job-hunting"), disclosed to unauthenticated
 * strangers at scale.
 *
 * INVARIANT PROVEN (the security property, asserted directly):
 *   The HTTP response for an ALREADY-REGISTERED email is byte-identical to the
 *   response for a BRAND-NEW email — same status code AND same JSON body — and
 *   neither response carries a session token or any user object that would let
 *   the caller distinguish the two branches.
 *
 * A compliant CONTROL is built in: the new-email call must actually create the
 * candidate+user pair (proving the endpoint still works and the test is not a
 * vacuous all-error false-pass), while the existing-email call must create
 * NOTHING new.
 *
 * Email is forced into the simulated-send branch (SES creds removed for the
 * duration) so no real mail is dispatched to the @js.test fixtures.
 * Harness mirrors candidate-privacy-seal-combinatorial.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray, like } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
} from "@workspace/db";
import publicRouter from "./public";

const P = "crenum_";
const id = (s: string) => P + s;

const TENANT = id("tenant");
const ADMIN = id("admin");

/* The address that ALREADY has an account (the enumeration target). */
const EXISTING_EMAIL = id("existing") + "@js.test";
/* A never-before-seen address (the new-account branch / CONTROL). */
const NEW_EMAIL = id("fresh") + "@js.test";

/* Meets the full password policy: len≥12, upper, lower, digit, symbol. */
const STRONG_PASSWORD = "Str0ngPass!2026";

let server: Server;
let baseUrl: string;

/* SES creds we blank out so sendEmail() takes its simulated-send branch. */
const SES_ENV_KEYS = [
  "SES_FROM_EMAIL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

type RegResult = { status: number; json: any; setCookie: string | null };

async function registerCall(email: string): Promise<RegResult> {
  const res = await fetch(baseUrl + "/career-register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Probe",
      lastName: "Tester",
      email,
      password: STRONG_PASSWORD,
    }),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

/* Both branches are exercised ONCE here so each test is self-contained and
 * order-independent (neither test relies on another test having run first). */
let existing: RegResult;
let fresh: RegResult;

async function cleanup() {
  // Remove anything the new-email branch may have created, plus the fixtures.
  await dbAdmin.delete(candidatesTable).where(like(candidatesTable.email, `${P}%`));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.email, NEW_EMAIL));
  await dbAdmin.delete(usersTable).where(like(usersTable.email, `${P}%`));
  await dbAdmin.delete(usersTable).where(eq(usersTable.email, NEW_EMAIL));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, TENANT));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [TENANT]));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: TENANT, name: "Enum Test Co", slug: TENANT, plan: "enterprise", website: "https://enum.test" },
  ]);

  // The admin doubles as the "already registered" account under EXISTING_EMAIL.
  await dbAdmin.insert(usersTable).values([
    { id: ADMIN, tenantId: TENANT, email: EXISTING_EMAIL, name: "Existing User", passwordHash: "x", role: "candidate", status: "active" },
  ]);
}

before(async () => {
  for (const k of SES_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  await seed();
  const app = express();
  app.use(express.json());
  app.use(publicRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  // Exercise both branches exactly once; tests below assert against the results.
  existing = await registerCall(EXISTING_EMAIL);
  fresh = await registerCall(NEW_EMAIL);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
  for (const k of SES_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("existing-email and new-email responses are byte-identical (no enumeration oracle)", async () => {
  // Same status code for both branches.
  assert.equal(existing.status, 200, `existing-email status: ${existing.status} ${JSON.stringify(existing.json)}`);
  assert.equal(fresh.status, 200, `new-email status: ${fresh.status} ${JSON.stringify(fresh.json)}`);
  assert.equal(existing.status, fresh.status, "status codes must match across branches");

  // Identical JSON body — the ONLY thing an attacker can observe.
  assert.deepEqual(existing.json, fresh.json, "response bodies must be identical across branches");

  // No session cookie may leak on either branch (would both auto-login the new
  // user AND make the branches distinguishable).
  assert.equal(existing.setCookie, fresh.setCookie, "set-cookie must not differ across branches");
  assert.equal(existing.setCookie, null, "no session cookie may be set on either branch");

  // Positive shape: a success envelope with a message, and crucially NO session
  // token or user object that would distinguish the branches or auto-login.
  assert.equal(existing.json?.ok, true, "response must be a success envelope");
  assert.equal(typeof existing.json?.message, "string", "response must carry a generic message");
  for (const leaky of ["token", "user", "error", "exists", "emailExists"]) {
    assert.ok(!(leaky in existing.json), `response must not carry a distinguishing '${leaky}' field`);
  }
});

test("existing-email branch creates NOTHING; new-email branch creates the candidate (control)", async () => {
  // The existing address must not have spawned a second user or any candidate.
  const usersForExisting = await dbAdmin
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, EXISTING_EMAIL));
  assert.equal(usersForExisting.length, 1, "existing email must still map to exactly one (the seeded) user");

  const candsForExisting = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.email, EXISTING_EMAIL));
  assert.equal(candsForExisting.length, 0, "existing-account branch must not create a candidate row");

  // CONTROL: the new email must have produced a real user + candidate, proving
  // the endpoint still works and this is not a vacuous all-error false-pass.
  const usersForNew = await dbAdmin
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, NEW_EMAIL));
  assert.equal(usersForNew.length, 1, "new-email branch must create exactly one user");

  const candsForNew = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.email, NEW_EMAIL));
  assert.equal(candsForNew.length, 1, "new-email branch must create exactly one candidate");
});
