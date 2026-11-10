import assert from "node:assert/strict";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { logoutAllSessions, LogoutAllError } from "./logout-all-sessions";
import { issueToken } from "./auth-token";
import { controlDb } from "@workspace/db";
process.env.SESSION_SECRET = "synthetic-logout-all-tests-01234567890123456789";
const password = "Synthetic1!confirmation";
const hash = await bcrypt.hash(password, 4);
function fixture(
  options: {
    auditFail?: boolean;
    epoch?: string;
    hash?: string;
    locked?: boolean;
    status?: string;
  } = {},
) {
  const state = { version: options.epoch ?? "0", audits: [] as any[] };
  const user = {
    id: "owned",
    tenantId: "owned-tenant",
    role: "candidate",
    status: options.status ?? "active",
    passwordHash: options.hash ?? hash,
    credentialVersion: state.version,
    accountErasedAt: null,
    lockedAt: options.locked ? new Date() : null,
  };
  const database = {
    transaction: async (fn: any) => {
      const before = { version: state.version, audits: [...state.audits] };
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({ for: async () => [{ ...user, credentialVersion: state.version }] }),
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => {
                state.version = "new-opaque-epoch";
                return [{ version: state.version }];
              },
            }),
          }),
        }),
        insert: () => ({
          values: async (value: any) => {
            if (options.auditFail) throw Error("isolated audit failure");
            state.audits.push(value);
          },
        }),
      };
      try {
        return await fn(tx);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
  } as unknown as typeof controlDb;
  const token = issueToken({ userId: "owned", tenantId: "owned-tenant", role: "candidate" });
  return { state, database, token };
}
test("mandatory acknowledgement and password gate the self-only action", async () => {
  for (const [ack, pw, status] of [
    [false, password, 400],
    [true, "incorrect", 403],
    [true, "", 400],
  ] as const) {
    const f = fixture();
    await assert.rejects(
      logoutAllSessions(f.token, pw, ack, f.database),
      (e: any) => e instanceof LogoutAllError && e.status === status,
    );
    assert.equal(f.state.version, "0");
    assert.equal(f.state.audits.length, 0);
  }
});
test("stale, locked, suspended and organization-only identities fail closed", async () => {
  for (const [options, status] of [
    [{ epoch: "rotated" }, 401],
    [{ locked: true }, 423],
    [{ status: "suspended" }, 401],
    [{ hash: "sso_microsoft" }, 409],
  ] as const) {
    const f = fixture(options);
    await assert.rejects(
      logoutAllSessions(f.token, password, true, f.database),
      (e: any) => e.status === status,
    );
    assert.equal(f.state.audits.length, 0);
  }
});
test("confirmation rotates the epoch and appends a credential-free audit", async () => {
  const f = fixture();
  await logoutAllSessions(f.token, password, true, f.database);
  assert.notEqual(f.state.version, "0");
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].actorId, "owned");
  assert.equal(f.state.audits[0].subjectId, "owned");
  const audit = JSON.stringify(f.state.audits);
  for (const secret of [password, f.token, hash, "new-opaque-epoch"])
    assert(!audit.includes(secret));
});
test("audit failure rolls back invalidation rather than claiming unaudited success", async () => {
  const f = fixture({ auditFail: true });
  await assert.rejects(
    logoutAllSessions(f.token, password, true, f.database),
    /isolated audit failure/,
  );
  assert.equal(f.state.version, "0");
  assert.equal(f.state.audits.length, 0);
});
