import { jsonRowsSchema, readJsonObject } from "../test-utils/json-response";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import * as schema from "@workspace/db";
import { sql } from "drizzle-orm";
import { createTransactionalDb } from "../test-fixtures/transactional-db";

let fixture: Awaited<ReturnType<typeof createTransactionalDb>> | undefined;
let pilot: typeof import("./pilot-codes");
let plans: typeof import("./plans");
let gates: typeof import("./plan-enforcement");

before(async () => {
  fixture = await createTransactionalDb([
    schema.tenantsTable,
    schema.pilotCodesTable,
    schema.tenantPilotGrantsTable,
    schema.billingSubscriptionsTable,
    schema.jobsTable,
    schema.interviewSessionsTable,
    schema.creditUsageEventsTable,
    schema.usersTable,
    schema.staffInviteTokensTable,
    schema.planLimitNotificationsTable,
  ]);
  pilot = await import("./pilot-codes");
  plans = await import("./plans");
  gates = await import("./plan-enforcement");
});
after(async () => {
  mock.restoreAll();
  await fixture?.close();
});

test("pilot codes normalize without changing their identity", () => {
  assert.equal(pilot.normalizePilotCode(" linx-pilot "), "LINX-PILOT");
});
test("complimentary Enterprise keeps every feature and unlimited allowance", () => {
  const plan = pilot.complimentaryPlan(plans.getPlan("enterprise"));
  assert.ok(Object.values(plan.features).every(Boolean));
  assert.ok(Object.values(plan.limits).every((value) => value === -1));
  assert.equal(plan.expiresAfterDays, 0);
});
test("complimentary prices are zero across regions without modifying the catalog", () => {
  const original = plans.getPlan("enterprise");
  const plan = pilot.complimentaryPlan(original);
  for (const region of ["us", "in", "gb", "eu"] as const) {
    const price = plans.getRegionalPrice(plan, region);
    assert.equal(price.priceMonthly, 0);
    assert.equal(price.pricePerSeat, 0);
    assert.equal(price.perHireFee, 0);
  }
  assert.equal(plan.perHireFeeUsd, 0);
  assert.notEqual(original.perHireFeeUsd, 0);
});

test("transactional pilot lifecycle, capacity, inheritance and restoration", async (t) => {
  const db = fixture!.db;
  const actor = "isolated-pilot-actor";
  const root = "pilot-root",
    child = "pilot-child",
    grandchild = "pilot-grandchild";
  const other = "pilot-other",
    later = "pilot-later",
    codeId = "pilot-code";
  const code = `TEST-${crypto.randomUUID()}`.toUpperCase();
  for (const [id, parent, plan] of [
    [root, null, "starter"],
    [child, root, "growth"],
    [grandchild, child, "starter"],
    [other, null, "starter"],
  ]) {
    await db.execute(sql`INSERT INTO tenants (id,name,slug,plan,status,parent_id)
      VALUES (${id},'Isolated pilot test',${id},${plan}::tenant_plan,'active',${parent})`);
  }
  await db.execute(sql`INSERT INTO pilot_codes (id,code,label,max_redemptions,created_by)
    VALUES (${codeId},${code},'Isolated automated check',1,${actor})`);

  await t.test("same-account concurrent redemption consumes capacity once", async () => {
    const ids = await Promise.all([
      pilot.redeemPilot(code, root, actor),
      pilot.redeemPilot(code, root, actor),
    ]);
    assert.equal(ids[0], ids[1]);
    const count = (
      await db.execute(sql`SELECT redemption_count FROM pilot_codes WHERE id=${codeId}`)
    ).rows[0];
    assert.equal(count.redemption_count, 1);
    assert.equal(
      (await db.execute(sql`SELECT count(*)::int AS n FROM tenant_pilot_grants`)).rows[0].n,
      1,
    );
  });
  await t.test(
    "all descendants inherit; unrelated and child-account redemption are rejected",
    async () => {
      assert.ok(await pilot.activePilot(root));
      assert.ok(await pilot.activePilot(child));
      assert.ok(await pilot.activePilot(grandchild));
      assert.equal(await pilot.activePilot(other), null);
      await assert.rejects(pilot.redeemPilot(code, other, actor), /unavailable/);
      await assert.rejects(pilot.redeemPilot(code, child, actor), /main account/);
    },
  );
  await t.test("disabled code preserves existing grants and idempotent redemption", async () => {
    await db.execute(sql`UPDATE pilot_codes SET disabled=true WHERE id=${codeId}`);
    assert.ok(await pilot.activePilot(child));
    await pilot.redeemPilot(code, root, actor);
  });
  await t.test(
    "lapsed billing does not block any pilot allowance; manual suspension does",
    async () => {
      await db.execute(
        sql`UPDATE tenants SET paid_through_at=now()-interval '30 days' WHERE id IN (${root},${child})`,
      );
      const checks = async (id: string) =>
        Promise.all([
          gates.checkJobCreationAllowed(id),
          gates.checkInterviewCreationAllowed(id),
          gates.checkCreditAllowed(id, "ai_generation"),
          gates.checkSeatInviteAllowed(id),
          gates.checkSubClientCreationAllowed(id),
        ]);
      for (const id of [root, child]) {
        const results = await checks(id);
        assert.ok(results.every((result) => result.allowed && result.limit === -1));
      }
      await db.execute(sql`UPDATE tenants SET status='suspended' WHERE id=${root}`);
      assert.ok((await checks(root)).every((result) => !result.allowed));
      await db.execute(sql`UPDATE tenants SET status='active' WHERE id=${root}`);
    },
  );
  await t.test(
    "ending restores each original plan and future-client inheritance without changing payment evidence",
    async () => {
      await db.execute(sql`INSERT INTO tenants (id,name,slug,plan,status,parent_id)
      VALUES (${later},'Later isolated client',${later},'enterprise','active',${root})`);
      assert.ok(await pilot.activePilot(later));
      const paidBefore = (
        await db.execute(sql`SELECT paid_through_at FROM tenants WHERE id=${root}`)
      ).rows[0].paid_through_at;
      const grant = await pilot.activePilot(root);
      await pilot.endPilot(grant!.id as string, actor);
      await pilot.endPilot(grant!.id as string, actor);
      for (const id of [root, child, grandchild, later])
        assert.equal(await pilot.activePilot(id), null);
      const rows = (
        await db.execute(
          sql`SELECT id,plan FROM tenants WHERE id IN (${root},${child},${grandchild},${later})`,
        )
      ).rows;
      assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.plan])), {
        [root]: "starter",
        [child]: "growth",
        [grandchild]: "starter",
        [later]: "starter",
      });
      assert.equal(
        +new Date(
          (await db.execute(sql`SELECT paid_through_at FROM tenants WHERE id=${root}`)).rows[0]
            .paid_through_at as string,
        ),
        +new Date(paidBefore as string),
      );
      await assert.rejects(pilot.redeemPilot(code, root, actor), /unavailable/);
    },
  );
  await t.test("two different accounts cannot oversubscribe a one-use code", async () => {
    const raceCode = "ISOLATED-CAPACITY";
    for (const id of ["race-a", "race-b"])
      await db.execute(sql`
      INSERT INTO tenants (id,name,slug,plan,status) VALUES (${id},'Capacity fixture',${id},'starter','active')`);
    await db.execute(sql`INSERT INTO pilot_codes (id,code,label,max_redemptions,created_by)
      VALUES ('race-code',${raceCode},'Capacity fixture',1,${actor})`);
    const results = await Promise.allSettled(
      ["race-a", "race-b"].map((id) => pilot.redeemPilot(raceCode, id, actor)),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(
      (await db.execute(sql`SELECT redemption_count FROM pilot_codes WHERE id='race-code'`)).rows[0]
        .redemption_count,
      1,
    );
  });
  await t.test("fixture SQL cannot explicitly reach public data", async () => {
    await assert.rejects(db.execute(sql`SELECT id FROM public.tenants LIMIT 1`), (error: unknown) =>
      /escape into public data/.test(String((error as { cause?: unknown }).cause)),
    );
    await assert.rejects(
      db.execute(sql`SELECT * FROM subscription_prices`),
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42P01",
    );
  });
});

test("recurring subscriptions in a client prevent a misleading no-charge grant", async () => {
  const db = fixture!.db;
  for (const status of ["active", "trialing", "past_due"] as const) {
    const root = `recurring-${status}`,
      child = `${root}-child`,
      code = `RECURRING-${status}`.toUpperCase();
    for (const [id, parent] of [
      [root, null],
      [child, root],
    ]) {
      await db.execute(sql`INSERT INTO tenants (id,name,slug,plan,status,parent_id)
        VALUES (${id},'Recurring fixture',${id},'starter','active',${parent})`);
    }
    await db.execute(sql`INSERT INTO pilot_codes (id,code,label,max_redemptions,created_by)
      VALUES (${root},${code},'Recurring fixture',1,'fixture-actor')`);
    await db.insert(schema.billingSubscriptionsTable).values({
      id: root,
      tenantId: child,
      stripeSubscriptionId: root,
      stripePriceId: "fixture-only",
      planCode: "starter",
      status,
    });
    await assert.rejects(pilot.redeemPilot(code, root, "fixture-actor"), /existing recurring/);
    assert.equal(await pilot.activePilot(root), null);
    assert.equal(
      (await db.execute(sql`SELECT redemption_count FROM pilot_codes WHERE id=${root}`)).rows[0]
        .redemption_count,
      0,
    );
    assert.ok(
      (await db.execute(sql`SELECT plan FROM tenants WHERE id IN (${root},${child})`)).rows.every(
        (row) => row.plan === "starter",
      ),
    );
    await db.execute(sql`UPDATE billing_subscriptions SET status='canceled' WHERE id=${root}`);
    assert.ok(await pilot.redeemPilot(code, root, "fixture-actor"));
  }
});

test("admin endpoints create, redeem, disable and end pilots with real authentication and role gates", async (t) => {
  const db = fixture!.db;
  const root = "http-root",
    child = "http-child",
    other = "http-other";
  for (const [id, parent] of [
    [root, null],
    [child, root],
    [other, null],
  ]) {
    await db.execute(sql`INSERT INTO tenants (id,name,slug,plan,status,parent_id)
      VALUES (${id},'Endpoint fixture',${id},'starter','active',${parent})`);
  }
  const { issueToken } = await import("./auth-token");
  const tokens: Record<string, string> = {};
  for (const [id, tenantId, role] of [
    ["http-admin", root, "platform_admin"],
    ["http-owner", root, "tenant_admin"],
    ["http-client", child, "tenant_admin"],
    ["http-candidate", root, "candidate"],
  ] as const) {
    await db.insert(schema.usersTable).values({
      id,
      tenantId,
      role,
      name: "Endpoint fixture",
      email: `${id}@fixture.invalid`,
      passwordHash: "not-a-login-hash",
    });
    tokens[id] = issueToken({ userId: id, role, tenantId, region: "us" });
  }
  const router = (await import("../routes/pilot-codes")).default;
  const { withTenantContext } = await import("../middlewares/withTenantContext");
  const app = express();
  app.get("/private-context-check", withTenantContext, (_req, res) => res.json({ ok: true }));
  app.use(express.json(), router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, actor?: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await readJsonObject(response) };
  };
  await t.test("anonymous, candidate and non-platform staff cannot administer codes", async () => {
    assert.equal((await request("/pilot-codes/admin")).status, 401);
    for (const actor of ["http-owner", "http-candidate"]) {
      assert.equal((await request("/pilot-codes/admin", actor)).status, 403);
      assert.equal(
        (
          await request("/pilot-codes/admin", actor, {
            code: "DENIED",
            label: "Denied",
            maxRedemptions: 1,
          })
        ).status,
        403,
      );
    }
    // A stale/escalated token claim never supersedes the live identity row.
    const ownerToken = tokens["http-owner"];
    tokens["http-owner"] = issueToken({
      userId: "http-owner",
      role: "platform_admin",
      tenantId: root,
      region: "us",
    });
    assert.equal((await request("/pilot-codes/admin", "http-owner")).status, 403);
    tokens["http-owner"] = ownerToken;
  });
  const created = await request("/pilot-codes/admin", "http-admin", {
    code: " endpoint-pilot ",
    label: "Endpoint fixture",
    maxRedemptions: 2,
  });
  await t.test(
    "suspension blocks existing tokens at both shared authentication boundaries",
    async () => {
      for (const actor of ["http-admin", "http-owner"]) {
        await db.execute(sql`UPDATE users SET status='suspended' WHERE id=${actor}`);
        assert.equal((await request("/pilot-codes/me", actor)).status, 403);
        assert.equal((await request("/private-context-check", actor)).status, 403);
        assert.equal(
          (await request("/pilot-codes/redeem", actor, { code: "ENDPOINT-PILOT" })).status,
          403,
        );
        await db.execute(sql`UPDATE users SET status='active' WHERE id=${actor}`);
        assert.equal((await request("/pilot-codes/me", actor)).status, 200);
      }
    },
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.code, "ENDPOINT-PILOT");
  await t.test("validation and duplicate errors are explicit", async () => {
    assert.equal(
      (
        await request("/pilot-codes/admin", "http-admin", {
          code: "INVALID",
          label: "Invalid",
          maxRedemptions: 0,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/pilot-codes/admin", "http-admin", {
          code: "endpoint-pilot",
          label: "Duplicate",
          maxRedemptions: 1,
        })
      ).status,
      409,
    );
  });
  await t.test(
    "own-account redemption works; foreign-account and child redemption do not",
    async () => {
      assert.equal(
        (
          await request("/pilot-codes/redeem", "http-owner", {
            code: "ENDPOINT-PILOT",
            tenantId: other,
          })
        ).status,
        403,
      );
      assert.equal(
        (await request("/pilot-codes/redeem", "http-candidate", { code: "ENDPOINT-PILOT" })).status,
        403,
      );
      assert.equal(
        (await request("/pilot-codes/redeem", "http-client", { code: "ENDPOINT-PILOT" })).status,
        409,
      );
      assert.equal(
        (await request("/pilot-codes/redeem", "http-owner", { code: "endpoint-pilot" })).status,
        200,
      );
      assert.equal((await request("/pilot-codes/me", "http-client")).body.complimentary, true);
      assert.equal(await pilot.activePilot(other), null);
    },
  );
  await t.test(
    "disable stops new redemption but not the existing grant; ending restores normal access",
    async () => {
      const list = await request("/pilot-codes/admin", "http-admin");
      assert.equal(list.status, 200);
      const grant = jsonRowsSchema.parse(list.body.grants).find((value) => value.tenantId === root);
      assert.ok(grant);
      assert.equal(
        (await request(`/pilot-codes/admin/${created.body.id}/disable`, "http-owner", {})).status,
        403,
      );
      assert.equal(
        (await request(`/pilot-codes/admin/${created.body.id}/disable`, "http-admin", {})).status,
        200,
      );
      assert.equal((await request("/pilot-codes/me", "http-owner")).body.complimentary, true);
      assert.equal(
        (
          await request("/pilot-codes/redeem", "http-admin", {
            code: "ENDPOINT-PILOT",
            tenantId: other,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(`/pilot-codes/admin/grants/${grant.id}/end`, "http-admin", {
            confirm: false,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(`/pilot-codes/admin/grants/${grant.id}/end`, "http-owner", {
            confirm: true,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(`/pilot-codes/admin/grants/${grant.id}/end`, "http-admin", {
            confirm: true,
          })
        ).status,
        200,
      );
      assert.equal((await request("/pilot-codes/me", "http-client")).body.complimentary, false);
      assert.equal(
        (await request("/pilot-codes/admin/missing/disable", "http-admin", {})).status,
        404,
      );
    },
  );
});

test("trial expiry skips pilot-inheriting demo clients without suppressing ordinary trial notices", async () => {
  const db = fixture!.db;
  await db.execute(sql`INSERT INTO tenants (id,name,slug,plan,status)
    VALUES ('trial-pilot-root','Trial pilot fixture','trial-pilot-root','starter','active')`);
  await db.execute(sql`INSERT INTO pilot_codes (id,code,label,max_redemptions,created_by)
    VALUES ('trial-pilot-code','TRIAL-PILOT','Trial pilot fixture',1,'fixture-actor')`);
  await pilot.redeemPilot("TRIAL-PILOT", "trial-pilot-root", "fixture-actor");
  for (const [id, parent] of [
    ["trial-pilot-client", "trial-pilot-root"],
    ["ordinary-demo", null],
  ] as const) {
    await db.execute(sql`INSERT INTO tenants (id,name,slug,plan,status,parent_id,created_at,plan_activated_at)
      VALUES (${id},'Trial fixture',${id},'demo','active',${parent},now()-interval '40 days',now()-interval '40 days')`);
    await db.insert(schema.usersTable).values({
      id,
      tenantId: id,
      role: "tenant_admin",
      name: "Trial fixture",
      email: `${id}@fixture.invalid`,
      passwordHash: "not-a-login-hash",
    });
  }
  const emails: { to: string }[] = [];
  mock.module("./email.ts", {
    namedExports: {
      sendEmail: async (message: { to: string }) => {
        emails.push(message);
        return { ok: true };
      },
      plainToHtml: (text: string) => text,
    },
  });
  const { runTrialExpiryCheck } = await import("./trial-expiry-scheduler");
  await runTrialExpiryCheck();
  assert.deepEqual(
    emails.map((message) => message.to),
    ["ordinary-demo@fixture.invalid"],
  );
  const row = (
    await db.execute(sql`SELECT trial_warning_3d_sent_at,trial_warning_1d_sent_at,trial_expired_email_sent_at
    FROM tenants WHERE id='trial-pilot-client'`)
  ).rows[0];
  assert.ok(
    Object.values(row).every((value) => value == null),
    "pilot clients must not consume trial-notice slots",
  );
});
