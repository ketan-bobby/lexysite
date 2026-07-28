/**
 * hm-share-privacy-seal.test.ts — PROOF THE LOGIN-LESS HM-SHARE FRONT DOOR IS SEALED
 *
 * Incident: POST /hm-share packages a candidate and emails a signed, expiring,
 * NO-LOGIN link to an external hiring manager. The create path applied a tenant
 * DATA-scope ceiling but NO compliance seal — a GDPR-erased / do-not-contact
 * candidate could be packaged (name, title, résumé, contact) and emailed to a
 * login-less recipient, and the public token endpoints served the frozen
 * snapshot without ever re-checking the candidate's live compliance state.
 *
 * The fix applies the canonical hard-exclusion seal (applyCandidateHardExclusions
 * → erased / DNC / pending_profile) at TWO points:
 *   1. CREATE  — a barred candidate can never be turned into a share link.
 *   2. PUBLIC READ — a candidate erased / set DNC AFTER minting is revoked (410)
 *      from the external view + résumé stream, closing the create-then-bar window.
 *
 * Discovery-preference filters (hide / block / pause / match-only) are
 * intentionally NOT applied here — an hm-share is a recruiter acting on an
 * EXISTING pipeline relationship, not a discovery surface.
 *
 * The control (candOk) MUST succeed and be viewable, guarding against an
 * all-fail false-pass (a broken handler that rejects everything).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  hiringManagerSharesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import hmShareRouter, { hmSharePublicRouter } from "./hm-share";

const P = "hmsps_";
const id = (s: string) => P + s;

const T = id("acme");        // recruiter tenant
const T2 = id("other");      // foreign tenant (cross-tenant probe)
const CAND = {
  ok: id("candOk"),
  dnc: id("candDnc"),
  erased: id("candErased"),
  foreign: id("candForeign"),
};
const ALL_SEEDED = [CAND.ok, CAND.dnc, CAND.erased, CAND.foreign];

let server: Server;
let baseUrl: string;
let okToken = ""; // hm-share token minted for the compliant control

// Force email.ts into its simulated-send branch so create never hits real SES.
const SAVED_ENV: Record<string, string | undefined> = {};
const EMAIL_ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"];

const admin = () => issueToken({ userId: id("tadmin"), role: "tenant_admin", tenantId: T });

async function api(method: string, path: string, token?: string, body?: any): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function sharePayload(candidateId: string) {
  return {
    candidateId,
    recipients: [{ email: "hm@example.com", name: "Hiring Manager" }],
    includeContact: false,
    includeResume: false,
    includeNotes: true,
    package: { candidate: { firstName: "Test", lastName: "Candidate" } },
    expiresInDays: 14,
  };
}

async function cleanup() {
  await dbAdmin.delete(hiringManagerSharesTable).where(inArray(hiringManagerSharesTable.candidateId, ALL_SEEDED));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, ALL_SEEDED));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, [T, T2]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [T, T2]));
}

async function seed() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: T, name: "Acme", slug: T, plan: "enterprise" },
    { id: T2, name: "Other Co", slug: T2, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("tadmin"), tenantId: T, email: id("tadmin") + "@acme.com", name: "Acme Admin", passwordHash: "x", role: "tenant_admin", status: "active" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: CAND.ok, tenantId: T, firstName: "Clean", lastName: "Control", email: CAND.ok + "@js.test", source: "career_site" },
    { id: CAND.dnc, tenantId: T, firstName: "DoNot", lastName: "Contact", email: CAND.dnc + "@js.test", source: "career_site", doNotContact: true },
    { id: CAND.erased, tenantId: T, firstName: "Erased", lastName: "Seeker", email: CAND.erased + "@js.test", source: "career_site", dataErasedAt: new Date() },
    // Foreign tenant candidate — caller (tenant_admin of T) must not be able to share it.
    { id: CAND.foreign, tenantId: T2, firstName: "Foreign", lastName: "Seeker", email: CAND.foreign + "@js.test", source: "career_site" },
  ]);
}

before(async () => {
  for (const k of EMAIL_ENV_KEYS) { SAVED_ENV[k] = process.env[k]; delete process.env[k]; }
  await seed();
  const app = express();
  app.use(express.json());
  app.use(hmShareRouter);                          // authed routes, mounted at root
  app.use("/public/hm-share", hmSharePublicRouter); // public token routes
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
  for (const k of EMAIL_ENV_KEYS) { if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k]; }
});

test("control: a compliant candidate CAN be shared and the link is viewable (no all-fail false-pass)", async () => {
  const r = await api("POST", "/hm-share", admin(), sharePayload(CAND.ok));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sent?.length, 1);

  const [row] = await dbAdmin.select({ token: hiringManagerSharesTable.token })
    .from(hiringManagerSharesTable).where(eq(hiringManagerSharesTable.candidateId, CAND.ok)).limit(1);
  okToken = row?.token ?? "";
  assert.ok(okToken, "a token must have been minted for the control share");

  const view = await api("GET", `/public/hm-share/${okToken}`);
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.ok(view.json.package, "the login-less package view must render for a compliant candidate");
});

test("LEAK GUARD: a do-not-contact candidate can NEVER be packaged into a share link", async () => {
  const r = await api("POST", "/hm-share", admin(), sharePayload(CAND.dnc));
  assert.equal(r.status, 403, `LEAK: a DNC candidate was shareable (${r.status}) ${JSON.stringify(r.json)}`);
  const shares = await dbAdmin.select().from(hiringManagerSharesTable).where(eq(hiringManagerSharesTable.candidateId, CAND.dnc));
  assert.equal(shares.length, 0, "no share row may be written for a DNC candidate");
});

test("LEAK GUARD: a GDPR-erased candidate can NEVER be packaged into a share link", async () => {
  const r = await api("POST", "/hm-share", admin(), sharePayload(CAND.erased));
  assert.equal(r.status, 403, `LEAK: an erased candidate was shareable (${r.status}) ${JSON.stringify(r.json)}`);
  const shares = await dbAdmin.select().from(hiringManagerSharesTable).where(eq(hiringManagerSharesTable.candidateId, CAND.erased));
  assert.equal(shares.length, 0, "no share row may be written for an erased candidate");
});

test("LEAK GUARD: a cross-tenant candidate cannot be shared by an out-of-scope caller", async () => {
  const r = await api("POST", "/hm-share", admin(), sharePayload(CAND.foreign));
  assert.equal(r.status, 404, `LEAK: a foreign-tenant candidate was shareable (${r.status}) ${JSON.stringify(r.json)}`);
});

test("REVOCATION: erasing a candidate AFTER minting revokes the live public link (410)", async () => {
  assert.ok(okToken, "control token must exist from the first test");
  // Simulate the candidate exercising GDPR erasure after the link was sent.
  await dbAdmin.update(candidatesTable).set({ dataErasedAt: new Date() }).where(eq(candidatesTable.id, CAND.ok));
  const view = await api("GET", `/public/hm-share/${okToken}`);
  assert.equal(view.status, 410, `LEAK: an erased candidate's snapshot was still served (${view.status}) ${JSON.stringify(view.json)}`);
  assert.equal(view.json.error, "revoked");
});
