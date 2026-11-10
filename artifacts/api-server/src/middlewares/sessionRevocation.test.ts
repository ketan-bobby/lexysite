import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { issueToken } from "../lib/auth-token";
import { createSessionRevocationGuard } from "./sessionRevocation";
process.env.SESSION_SECRET = "synthetic-revocation-test-secret-0123456789";

test("logout nonce isolates independent logins for the same account", () => {
  const actor = { userId: "fixture", role: "platform_admin", tenantId: null };
  assert.notEqual(issueToken(actor), issueToken(actor));
});
test("revocation guard checks both bearer and cookie, fails closed, and permits idempotent logout/re-login", async () => {
  const token = issueToken({ userId: "fixture", role: "recruiter", tenantId: "fixture" });
  for (const transport of ["cookie", "bearer"] as const)
    for (const state of ["revoked", "active", "unavailable"] as const) {
      let next = 0,
        status = 0,
        lookups = 0,
        body: unknown;
      const guard = createSessionRevocationGuard(async (raw) => {
        lookups++;
        assert.equal(raw, transport === "cookie" ? token : `Bearer ${token}`);
        if (state === "unavailable") throw Error("isolated failure");
        return state === "revoked";
      });
      const req = {
        path: "/auth/me",
        method: "GET",
        headers: transport === "bearer" ? { authorization: `Bearer ${token}` } : {},
        cookies: transport === "cookie" ? { session_token: token } : {},
      } as Request;
      const res = {
        status: (n: number) => {
          status = n;
          return res;
        },
        json: (b: unknown) => {
          body = b;
          return res;
        },
      } as unknown as Response;
      await guard(req, res, () => {
        next++;
      });
      assert.equal(lookups, 1);
      assert.equal(next, state === "active" ? 1 : 0);
      assert.equal(status, state === "active" ? 0 : state === "revoked" ? 401 : 503);
      assert(!JSON.stringify(body ?? {}).includes(token));
      for (const path of [
        "/auth/logout",
        "/auth/login",
        "/auth/candidate-login",
        "/public/forgot-password",
        "/public/reset-password",
      ]) {
        await guard({ ...req, path, method: "POST" } as Request, res, () => {
          next++;
        });
      }
      assert.equal(lookups, 1);
      for (const path of ["/auth/microsoft/start", "/auth/microsoft/callback"]) {
        await guard({ ...req, path, method: "GET" } as Request, res, () => {
          next++;
        });
      }
      assert.equal(lookups, 1);
    }
});
