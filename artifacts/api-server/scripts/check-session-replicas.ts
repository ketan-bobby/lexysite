/**
 * Development-only real HTTP/process/SQL proof. Credentials remain in memory.
 * Reuses the exact ownership journal and crash-recovery cleanup of native tests.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { eq, and } from "drizzle-orm";
import { registerChildHarnessPort } from "../../../scripts/test-egress-guard.mjs";
import {
  controlDb,
  pool,
  usersTable,
  candidatesTable,
  passwordResetTokensTable,
  auditLogsTable,
} from "@workspace/db";
import { assertDevelopmentTarget } from "./offer-session-fixture";
import { newFixture, prepareFixture, cleanupFixture } from "./mail-hold-session-fixture";
import { issueToken, verifyToken } from "../src/lib/auth-token";
import { logoutAllSessions } from "../src/lib/logout-all-sessions";

const args = process.argv.slice(2);
assert(
  args.every((a) => /^--(development-fingerprint|cleanup)=.+$/.test(a)),
  "Unknown option",
);
assert.equal(new Set(args.map((a) => a.split("=")[0])).size, args.length, "Duplicate option");
const fingerprint = args.find((a) => a.startsWith("--development-fingerprint="))?.split("=")[1];
const recovery = args.find((a) => a.startsWith("--cleanup="))?.split("=")[1];
type Replica = { child: ChildProcess; origin: string; errors: string; simulatedEmails: number };
const replicas: Replica[] = [];
let checkedReads = 0;
let stopped = false;
const stop = () => {
  stopped = true;
  for (const r of replicas) r.child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function start(): Promise<Replica> {
  assert(!stopped, "Interrupted");
  const child = fork(fileURLToPath(new URL("./session-replica-worker.ts", import.meta.url)), [], {
    execArgv: [
      "--import",
      "tsx",
      "--experimental-test-module-mocks",
      "--import",
      fileURLToPath(new URL("../../../scripts/test-egress-guard.mjs", import.meta.url)),
    ],
    // Inherited application secrets stay inside the process; never printed.
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const replica = { child, origin: "", errors: "", simulatedEmails: 0 };
  replicas.push(replica);
  child.stderr?.on("data", (chunk) => {
    replica.errors += String(chunk);
  });
  child.on("message", (message: any) => {
    if (message.kind === "simulated-email") replica.simulatedEmails++;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Replica startup timed out"));
    }, 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error(`Replica exited before readiness: ${replica.errors.slice(-1600)}`));
    });
    child.once("message", (message: any) => {
      clearTimeout(timer);
      assert(Number.isInteger(message.port));
      assert.equal(message.pid, child.pid);
      registerChildHarnessPort(child, message.port);
      replica.origin = `http://127.0.0.1:${message.port}`;
      resolve();
    });
  });
  return replica;
}
async function terminate(r: Replica) {
  if (r.child.exitCode !== null || r.child.signalCode !== null) {
    assert.equal(r.child.exitCode, 0, "Replica exited unsuccessfully");
    assert(!r.errors.includes("[test-egress-guard]"), "Replica attempted provider traffic");
    return;
  }
  const exited = once(r.child, "exit");
  r.child.kill("SIGTERM");
  const timeout = setTimeout(() => r.child.kill("SIGKILL"), 10_000);
  const [code] = await exited;
  clearTimeout(timeout);
  assert.equal(code, 0, "Replica did not shut down cleanly");
  assert(!r.errors.includes("[test-egress-guard]"), "Replica attempted provider traffic");
}
async function req(r: Replica, path: string, credential = "", body?: unknown, bearer = false) {
  assert(!stopped, "Interrupted");
  return fetch(`${r.origin}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Origin: r.origin,
      ...(credential
        ? bearer
          ? { Authorization: `Bearer ${credential.slice("session_token=".length)}` }
          : { Cookie: credential }
        : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookie(response: Response) {
  const value = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("session_token="))
    ?.split(";")[0];
  assert(value, "Response did not set a session cookie");
  return value;
}
try {
  await assertDevelopmentTarget(fingerprint);
  if (recovery) {
    // Reset-token rows belong only to the two exact journal-owned identities.
    await cleanupFixture(recovery, fingerprint!);
    console.log("PASS exact replica fixture recovery");
  } else {
    const f = await newFixture(fingerprint!);
    try {
      await prepareFixture(f);
      const a = await start(),
        b = await start();
      assert.notEqual(a.child.pid, b.child.pid);
      const login = async (r: Replica, id = f.changedId, password = f.password) => {
        const response = await req(r, "/auth/login", "", {
          email: `${id}@example.invalid`,
          password,
        });
        assert.equal(response.status, 200, "Native login failed");
        return cookie(response);
      };
      const check = async (r: Replica, c: string, status: number) => {
        for (const bearer of [false, true]) {
          const response = await req(r, "/auth/me", c, undefined, bearer);
          checkedReads++;
          assert.equal(
            response.status,
            status,
            `Replica ${r.child.pid} rejected unexpected credential state`,
          );
          if (status === 200) assert.equal((await response.json()).id, f.changedId);
          else assert.deepEqual(await response.json(), { error: "Unauthorized" });
        }
      };
      const loggedOut = await login(a),
        other = await login(b);
      await check(a, loggedOut, 200);
      await check(b, loggedOut, 200);
      assert.equal((await req(a, "/auth/logout", loggedOut, {})).status, 200);
      await check(a, loggedOut, 401);
      await check(b, loggedOut, 401);
      await check(a, other, 200);
      await check(b, other, 200);
      console.log(
        "PASS logout on replica A fences copied cookie/bearer on both processes; independent login survives",
      );
      const oldPid = b.child.pid;
      await terminate(b);
      const restarted = await start();
      assert.notEqual(oldPid, restarted.child.pid);
      await check(restarted, loggedOut, 401);
      await check(restarted, other, 200);
      console.log(
        "PASS revoked credential stays rejected after process restart; non-revoked credential remains valid",
      );

      // Actual public reset endpoint, with email replaced inside child processes.
      const raw = randomBytes(32).toString("base64url");
      await controlDb.insert(passwordResetTokensTable).values({
        id: randomUUID(),
        userId: f.changedId,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const nextPassword = `Aa1!${randomBytes(24).toString("base64url")}`;
      const response = await req(a, "/public/reset-password", other, {
        token: raw,
        password: nextPassword,
      });
      assert.equal(response.status, 200, "Reset failed");
      const fresh = cookie(response);
      const resetBody = await response.json();
      assert.equal(resetBody.user.id, f.changedId);
      assert(!("passwordHash" in resetBody.user));
      assert(!("credentialVersion" in resetBody.user));
      for (const replica of [a, restarted]) {
        await check(replica, other, 401);
        await check(replica, fresh, 200);
      }
      assert.equal(
        (
          await req(restarted, "/auth/login", "", {
            email: `${f.changedId}@example.invalid`,
            password: f.password,
          })
        ).status,
        401,
      );
      const newLogin = await login(restarted, f.changedId, nextPassword);
      await check(a, newLogin, 200);
      assert.equal(
        (
          await req(restarted, "/public/reset-password", other, {
            token: raw,
            password: nextPassword,
          })
        ).status,
        400,
      );
      console.log(
        "PASS real password reset invalidates all older sessions across processes; fresh session/new login succeed; old password and one-time replay fail",
      );

      // Trigger covers direct/current/future change writers; no clock precision.
      const before = (
        await controlDb.select().from(usersTable).where(eq(usersTable.id, f.changedId))
      )[0];
      const sameSecondPassword = `Aa1!${randomBytes(24).toString("base64url")}`;
      const hash = await bcrypt.hash(sameSecondPassword, 10);
      const [changed] = await controlDb
        .update(usersTable)
        .set({ passwordHash: hash })
        .where(eq(usersTable.id, f.changedId))
        .returning();
      assert.notEqual(changed.credentialVersion, before.credentialVersion);
      // Mint tokens with identical iat to prove epoch, not time, controls authority.
      const realNow = Date.now;
      const fixedNow = realNow();
      let stale: string, current: string;
      try {
        Date.now = () => fixedNow;
        stale = issueToken({
          userId: f.changedId,
          tenantId: f.tenantId,
          role: "platform_admin",
          credentialVersion: before.credentialVersion,
        });
        current = issueToken({
          userId: f.changedId,
          tenantId: f.tenantId,
          role: "platform_admin",
          credentialVersion: changed.credentialVersion,
        });
      } finally {
        Date.now = realNow;
      }
      const sv = verifyToken(stale),
        cv = verifyToken(current);
      assert(sv.ok && cv.ok);
      assert.equal(sv.payload.iat, cv.payload.iat);
      for (const replica of [a, restarted]) {
        await check(replica, fresh, 401);
        await check(replica, newLogin, 401);
        await check(replica, `session_token=${stale}`, 401);
        await check(replica, `session_token=${current}`, 200);
      }
      await controlDb
        .update(usersTable)
        .set({ credentialVersion: before.credentialVersion })
        .where(eq(usersTable.id, f.changedId));
      await check(a, `session_token=${stale}`, 401);
      const [unchanged] = await controlDb
        .update(usersTable)
        .set({ name: "Fixture name edit", passwordHash: hash })
        .where(eq(usersTable.id, f.changedId))
        .returning();
      assert.equal(unchanged.credentialVersion, changed.credentialVersion);
      const unaffected = await login(a, f.retainedId);
      assert.equal((await req(restarted, "/auth/me", unaffected)).status, 200);
      assert.equal((await req(a, "/auth/logout", `session_token=${current}`, {})).status, 200);
      await check(restarted, `session_token=${current}`, 401);
      const retained = await login(a, f.changedId, sameSecondPassword);
      await check(restarted, retained, 200);
      // Returning to an older hash must not revive its earlier signed sessions.
      await controlDb
        .update(usersTable)
        .set({ passwordHash: before.passwordHash })
        .where(eq(usersTable.id, f.changedId));
      await check(a, retained, 401);
      await check(restarted, newLogin, 401);
      const latest = await login(a, f.changedId, nextPassword);
      await terminate(restarted);
      const restartedAgain = await start();
      await check(restartedAgain, other, 401);
      await check(restartedAgain, retained, 401);
      await check(restartedAgain, loggedOut, 401);
      await check(restartedAgain, latest, 200);
      assert.equal((await req(restartedAgain, "/auth/me", unaffected)).status, 200);
      console.log(
        "PASS same-second epochs, blocked epoch rollback, unchanged-hash/profile edit, unrelated account and session-specific logout after password change",
      );

      await controlDb
        .update(usersTable)
        .set({ role: "candidate" })
        .where(eq(usersTable.id, f.changedId));
      await controlDb
        .update(candidatesTable)
        .set({ userId: f.changedId })
        .where(eq(candidatesTable.id, f.candidateId));
      const candidateResponse = await req(a, "/auth/candidate-login", "", {
        email: `${f.changedId}@example.invalid`,
        password: nextPassword,
      });
      assert.equal(candidateResponse.status, 200, "Candidate login must carry the rotated epoch");
      const candidateSession = cookie(candidateResponse);
      await check(restartedAgain, candidateSession, 200);
      const candidateRaw = randomBytes(32).toString("base64url");
      await controlDb.insert(passwordResetTokensTable).values({
        id: randomUUID(),
        userId: f.changedId,
        tokenHash: createHash("sha256").update(candidateRaw).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const candidatePassword = `Aa1!${randomBytes(24).toString("base64url")}`;
      const candidateReset = await req(restartedAgain, "/public/reset-password", candidateSession, {
        token: candidateRaw,
        password: candidatePassword,
      });
      assert.equal(candidateReset.status, 200);
      await check(a, candidateSession, 401);
      await check(a, cookie(candidateReset), 200);
      const candidateAgain = await req(a, "/auth/candidate-login", "", {
        email: `${f.changedId}@example.invalid`,
        password: candidatePassword,
      });
      assert.equal(candidateAgain.status, 200);
      await check(restartedAgain, cookie(candidateAgain), 200);
      assert.equal((await req(a, "/auth/me", unaffected)).status, 200);
      console.log(
        "PASS candidate login/reset/re-login carry the rotated epoch; earlier candidate session is denied",
      );
      const confirmed = cookie(candidateAgain);
      const secondResponse = await req(restartedAgain, "/auth/candidate-login", "", {
        email: `${f.changedId}@example.invalid`,
        password: candidatePassword,
      });
      assert.equal(secondResponse.status, 200);
      const second = cookie(secondResponse);
      const beforeAll = (
        await controlDb.select().from(usersTable).where(eq(usersTable.id, f.changedId))
      )[0];
      const auditRows = () =>
        controlDb
          .select()
          .from(auditLogsTable)
          .where(
            and(
              eq(auditLogsTable.actorId, f.changedId),
              eq(auditLogsTable.action, "auth.sessions_revoked"),
            ),
          );
      assert.equal((await auditRows()).length, 0);
      assert.equal(
        (await req(a, "/auth/logout-all", "", { password: candidatePassword, acknowledge: true }))
          .status,
        401,
      );
      assert.equal(
        (await req(a, "/auth/logout-all", confirmed, { password: "incorrect", acknowledge: true }))
          .status,
        403,
      );
      assert.equal(
        (
          await req(a, "/auth/logout-all", confirmed, {
            password: candidatePassword,
            acknowledge: false,
          })
        ).status,
        400,
      );
      // Real SQL rollback: fail only the audit insert inside the service's real
      // transaction, after the actual epoch update; no global schema changes.
      const brokenAuditDatabase = {
        transaction: (fn: any) =>
          controlDb.transaction((tx) =>
            fn({
              select: tx.select.bind(tx),
              update: tx.update.bind(tx),
              insert: () => {
                throw Error("isolated audit failure");
              },
            }),
          ),
      } as unknown as typeof controlDb;
      await assert.rejects(
        logoutAllSessions(
          confirmed.slice("session_token=".length),
          candidatePassword,
          true,
          brokenAuditDatabase,
        ),
        /isolated audit failure/,
      );
      assert.equal(
        (await controlDb.select().from(usersTable).where(eq(usersTable.id, f.changedId)))[0]
          .credentialVersion,
        beforeAll.credentialVersion,
      );
      await check(a, confirmed, 200);
      await check(restartedAgain, second, 200);
      assert.equal((await auditRows()).length, 0);
      const allResult = await req(a, "/auth/logout-all", confirmed, {
        password: candidatePassword,
        acknowledge: true,
      });
      assert.equal(allResult.status, 200);
      assert(allResult.headers.getSetCookie().some((c) => c.startsWith("session_token=;")));
      for (const replica of [a, restartedAgain]) {
        await check(replica, confirmed, 401);
        await check(replica, second, 401);
        assert.equal((await req(replica, "/auth/me", unaffected)).status, 200);
      }
      const afterAll = (
        await controlDb.select().from(usersTable).where(eq(usersTable.id, f.changedId))
      )[0];
      assert.equal(afterAll.passwordHash, beforeAll.passwordHash);
      assert.notEqual(afterAll.credentialVersion, beforeAll.credentialVersion);
      const audit = await auditRows();
      assert.equal(audit.length, 1);
      assert.equal(audit[0].subjectId, f.changedId);
      assert.equal(audit[0].tenantId, null);
      const serializedAudit = JSON.stringify(audit);
      for (const value of [
        candidatePassword,
        confirmed,
        second,
        afterAll.passwordHash,
        afterAll.credentialVersion,
      ])
        assert(!serializedAudit.includes(value));
      await terminate(restartedAgain);
      const afterAllRestart = await start();
      await check(afterAllRestart, confirmed, 401);
      await check(afterAllRestart, second, 401);
      assert.equal((await req(afterAllRestart, "/auth/me", unaffected)).status, 200);
      // Fresh process also proves the committed all-device epoch survives
      // restart. Never relax production login limits for a long fixture.
      const loginAfterAll = await req(afterAllRestart, "/auth/candidate-login", "", {
        email: `${f.changedId}@example.invalid`,
        password: candidatePassword,
      });
      assert.equal(loginAfterAll.status, 200);
      await check(a, cookie(loginAfterAll), 200);
      for (const expected of [403, 403, 429])
        assert.equal(
          (
            await req(a, "/auth/logout-all", cookie(loginAfterAll), {
              password: "incorrect",
              acknowledge: true,
            })
          ).status,
          expected,
        );
      assert.equal((await auditRows()).length, 1);
      console.log(
        "PASS all-device sign-out: reauthentication/consent, real audit-failure rollback, cross-replica invalidation, private audit, unchanged password, fresh login and rate limit",
      );
      assert.equal(
        replicas.reduce((sum, r) => sum + r.simulatedEmails, 0),
        2,
      );
      console.log(
        JSON.stringify({
          kind: "session_replica_verification",
          processes: replicas.length,
          restarts: replicas.length - 2,
          checkedProtectedRequests: checkedReads,
          nativePasswordResets: 2,
          simulatedSecurityNotifications: 2,
          productionAccess: false,
        }),
      );
    } finally {
      try {
        await Promise.all(replicas.map(terminate));
      } finally {
        await cleanupFixture(f.runId, fingerprint!);
      }
    }
  }
} finally {
  await Promise.all(replicas.map(terminate));
  await pool.end();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
