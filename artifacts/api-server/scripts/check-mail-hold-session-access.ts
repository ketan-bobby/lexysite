/** Real local HTTP password/cookie authentication. No response interception. */
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { dbAdmin, pool, usersTable, communicationEventsTable, auditLogsTable } from "@workspace/db";
import { assertDevelopmentTarget } from "./offer-session-fixture";
import { newFixture, prepareFixture, cleanupFixture } from "./mail-hold-session-fixture";

const args = process.argv.slice(2);
assert(
  args.every((a) => /^--(development-fingerprint|cleanup)=.+$/.test(a)),
  "Unknown or empty option",
);
assert.equal(new Set(args.map((a) => a.split("=")[0])).size, args.length, "Duplicate option");
const fingerprint = args.find((a) => a.startsWith("--development-fingerprint="))?.split("=")[1];
const recovery = args.find((a) => a.startsWith("--cleanup="))?.split("=")[1];
const origin = "http://localhost";
const controller = new AbortController();
const stop = () => controller.abort(new Error("Fixture run interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await assertDevelopmentTarget(fingerprint);
  if (recovery) {
    await cleanupFixture(recovery, fingerprint!);
    console.log("PASS exact mail-hold fixture recovery; no prefix scan.");
  } else {
    const f = await newFixture(fingerprint!);
    try {
      await prepareFixture(f);
      async function request(
        path: string,
        cookie = "",
        method = "GET",
        body?: unknown,
        transport = "cookie",
      ) {
        const response = await fetch(origin + path, {
          method,
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          headers: {
            ...(cookie
              ? transport === "bearer"
                ? { Authorization: `Bearer ${cookie.slice("session_token=".length)}` }
                : { Cookie: cookie }
              : {}),
            Origin: origin,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return response;
      }
      async function login(id: string) {
        const response = await request("/api/auth/login", "", "POST", {
          email: `${id}@example.invalid`,
          password: f.password,
        });
        assert.equal(response.status, 200, "Native fixture login failed");
        const cookie = response.headers
          .getSetCookie()
          .find((c) => c.startsWith("session_token="))
          ?.split(";")[0];
        assert(cookie, "Native login did not set a session cookie");
        const me = await request("/api/auth/me", cookie);
        assert.equal(me.status, 200);
        assert.equal((await me.json()).id, id, "HTTP service does not match verified fixture");
        return cookie;
      }
      const changed = await login(f.changedId),
        retained = await login(f.retainedId);
      async function readOwnHold(cookie: string) {
        let cursor: string | null = null;
        for (let i = 0; i < 20; i++) {
          const response = await request(
            `/api/platform/mail-holds${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            cookie,
          );
          assert.equal(response.status, 200, "Authorized control lost access");
          const body = await response.json();
          assert(Array.isArray(body.data));
          for (const row of body.data)
            assert.deepEqual(
              Object.keys(row).sort(),
              [
                "operationId",
                "tenantId",
                "candidateId",
                "kind",
                "reservedAt",
                "version",
                "lastReview",
                "lastReviewedAt",
              ].sort(),
            );
          const row = body.data.find(
            (r: { operationId: string }) => r.operationId === f.operationId,
          );
          if (row) return row;
          assert(
            body.hasMore && body.nextCursor && body.nextCursor !== cursor,
            "Own fixture not visible in bounded queue",
          );
          cursor = body.nextCursor;
        }
        throw new Error("Queue fixture not found in bounded page budget");
      }
      const auditCount = async () => {
        const [row] = await dbAdmin
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogsTable)
          .where(
            and(
              eq(auditLogsTable.subjectId, f.candidateId),
              eq(auditLogsTable.tenantId, f.tenantId),
              eq(auditLogsTable.action, "mail_hold_reviewed"),
            ),
          );
        return row!.count;
      };
      const reviewInput = (row: { version: string }) => ({
        operationId: f.operationId,
        version: row.version,
        disposition: "closed_no_resend",
        evidenceReference: "CASE-SESSION-FIXTURE",
        acknowledgeNoResend: true,
      });
      async function control() {
        const row = await readOwnHold(retained);
        const response = await request(
          "/api/platform/mail-holds/review",
          retained,
          "POST",
          reviewInput(row),
        );
        assert.equal(response.status, 200, "Authorized positive-control review failed");
        assert.equal((await response.json()).holdRetained, true);
      }
      await readOwnHold(changed);
      await control();
      async function denied(label: string, cookie: string, transport = "cookie") {
        const input = reviewInput(await readOwnHold(retained)),
          before = await auditCount();
        for (const [path, method, body] of [
          ["/api/platform/mail-holds", "GET", undefined],
          ["/api/platform/mail-holds?cursor=fixture", "GET", undefined],
          ["/api/platform/mail-holds/review", "POST", input],
        ] as const) {
          const response = await request(path, cookie, method, body, transport);
          assert([401, 403].includes(response.status), `${label}: request was not denied`);
          const text = await response.text();
          assert(
            !text.includes(f.operationId) &&
              !text.includes(f.candidateId) &&
              !text.includes("Synthetic private"),
          );
          assert(
            !text.includes('"data"') && !text.includes('"reviewId"'),
            "Denied response leaked resource data",
          );
        }
        assert.equal(await auditCount(), before, "Denied review wrote an audit decision");
        await control();
        console.log(
          `PASS ${label}; denied reads/write disclose no fixture data; independent cookie remains authorized`,
        );
      }
      await denied("missing cookie", "");
      await denied("malformed cookie", "session_token=not-a-session");
      await dbAdmin
        .update(usersTable)
        .set({ status: "suspended" })
        .where(eq(usersTable.id, f.changedId));
      await denied("suspended account reusing original admin cookie", changed);
      await dbAdmin
        .update(usersTable)
        .set({ status: "active" })
        .where(eq(usersTable.id, f.changedId));
      for (const role of ["tenant_admin", "recruiter_admin", "recruiter", "candidate"] as const) {
        await dbAdmin.update(usersTable).set({ role }).where(eq(usersTable.id, f.changedId));
        await denied(`role downgraded to ${role} with old admin claim`, changed);
      }
      await dbAdmin
        .update(usersTable)
        .set({ role: "platform_admin" })
        .where(eq(usersTable.id, f.changedId));
      await readOwnHold(changed);
      const logoutCookie = await login(f.changedId);
      assert.notEqual(logoutCookie, changed, "Independent logins must not share a session");
      const logout = await request("/api/auth/logout", logoutCookie, "POST");
      assert.equal(logout.status, 200);
      assert(
        logout.headers
          .getSetCookie()
          .some(
            (c) =>
              c.startsWith("session_token=") &&
              (/Max-Age=0/i.test(c) || /Expires=Thu, 01 Jan 1970/i.test(c)),
          ),
      );
      await denied("browser cookie removed by logout", "");
      await denied("copied cookie rejected after server-side logout", logoutCookie);
      await denied("copied bearer rejected after server-side logout", logoutCookie, "bearer");
      assert.equal(
        (await request("/api/auth/logout", logoutCookie, "POST")).status,
        200,
        "Logout replay is idempotent",
      );
      // Another login for the SAME account remains usable.
      await readOwnHold(changed);
      console.log("PASS independent same-account session survives another session's logout");
      await dbAdmin.delete(usersTable).where(eq(usersTable.id, f.changedId));
      await denied("deleted identity reusing original cookie", changed);
      const [event] = await dbAdmin
        .select({
          status: communicationEventsTable.status,
          sentAt: communicationEventsTable.sentAt,
        })
        .from(communicationEventsTable)
        .where(eq(communicationEventsTable.id, f.operationId));
      assert.equal(event!.status, "pending");
      assert.equal(event!.sentAt, null);
      console.log("PASS original send hold retained; no transport or delivery mutation");
    } finally {
      await cleanupFixture(f.runId, fingerprint!);
      console.log("PASS exact owned fixture removed and verified absent");
    }
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await pool.end();
}
