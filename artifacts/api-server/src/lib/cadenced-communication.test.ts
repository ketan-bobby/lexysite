import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { dbAdmin, candidatesTable, tenantsTable, communicationEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  cadencedCommunicationStore,
  createCadencedCommunicationSender,
  type CadencedCommunication,
} from "./cadenced-communication";
import { processSelfReportedJobChange } from "./self-report-reengagement";

async function fixture(t: TestContext, pool: "tenant" | "platform" = "tenant") {
  const tenantId = `cadence_test_${randomUUID()}`,
    candidateId = randomUUID();
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: tenantId, name: "Synthetic cadence fixture", slug: tenantId });
  t.after(async () => {
    await dbAdmin
      .delete(communicationEventsTable)
      .where(eq(communicationEventsTable.candidateId, candidateId));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidateId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    pool,
    firstName: "Synthetic",
    lastName: "Fixture",
    email: "fixture@example.invalid",
    currentTitle: "Engineer",
    currentCompany: "Old company",
  });
  const input: CadencedCommunication = {
    kind: "self_report",
    intervalDays: 30,
    tenantId,
    ownerTenantId: tenantId,
    candidateId,
    expectedPool: "tenant",
    to: "fixture@example.invalid",
    subject: "Synthetic fixture",
    body: "Synthetic summary",
    html: "<p>Synthetic fixture</p>",
    htmlOnly: true,
    actorLabel: "Mocked fixture",
    action: "self_report.job_change",
  };
  const events = () =>
    dbAdmin
      .select()
      .from(communicationEventsTable)
      .where(eq(communicationEventsTable.candidateId, candidateId));
  return { input, events, candidateId };
}
test("atomic cadence reservation prevents concurrent sends but allows new 30/60-day cycles", async (t) => {
  const f = await fixture(t);
  let sends = 0,
    start: () => void = () => {},
    release: () => void = () => {};
  const began = new Promise<void>((resolve) => {
    start = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async (opts) => {
      sends++;
      assert.equal(opts.singleAttempt, true);
      assert.equal(opts.text, undefined);
      assert.equal(opts.useRecruiterMailbox, false);
      start();
      await wait;
      return { ok: true, acceptance: "accepted" };
    },
  });
  const first = send(f.input);
  try {
    await Promise.race([
      began,
      first.then((result) =>
        assert.fail(`Reservation failed before mocked send: ${result.reason}`),
      ),
    ]);
    assert.equal((await send(f.input)).reason, "review_required");
  } finally {
    release();
  }
  assert.equal((await first).ok, true);
  assert.equal(sends, 1);
  assert.equal((await send(f.input)).reason, "cooldown");
  await dbAdmin
    .update(communicationEventsTable)
    .set({ sentAt: new Date(Date.now() - 31 * 86400000) })
    .where(eq(communicationEventsTable.candidateId, f.candidateId));
  assert.equal((await send({ ...f.input, intervalDays: 60 })).reason, "cooldown");
  assert.equal((await send(f.input)).ok, true);
  assert.equal(sends, 2);
  await dbAdmin
    .update(communicationEventsTable)
    .set({ sentAt: new Date(Date.now() - 61 * 86400000) })
    .where(eq(communicationEventsTable.candidateId, f.candidateId));
  assert.equal((await send({ ...f.input, intervalDays: 60 })).ok, true);
  assert.equal(sends, 3);
  const events = await f.events();
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((e) => e.id)).size, 3);
});
test("status check-in and self-report share reservations, including uncertain attempts across origins", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const sender = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async () => {
      sends++;
      return { ok: false, acceptance: "unknown", reviewRequired: true };
    },
  });
  assert.equal((await sender({ ...f.input, kind: "status_checkin" })).reason, "review_required");
  assert.equal((await sender(f.input)).reason, "review_required");
  assert.equal(sends, 1);
  const rows = await f.events();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "follow_up");
});
test("weekly digest respects the legacy six-day stamp and isolates its receipts from job-change and inactivity cadence", async (t) => {
  const f = await fixture(t, "platform");
  let sends = 0;
  const input: CadencedCommunication = {
    ...f.input,
    kind: "weekly_digest",
    intervalDays: 6,
    tenantId: "platform",
    expectedPool: "platform",
  };
  const sender = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async () => {
      sends++;
      return { ok: true, acceptance: "accepted" };
    },
  });
  await dbAdmin
    .update(candidatesTable)
    .set({ weeklyDigestLastSentAt: new Date() })
    .where(eq(candidatesTable.id, f.candidateId));
  assert.equal((await sender(input)).reason, "cooldown");
  assert.equal(sends, 0);
  await dbAdmin
    .update(candidatesTable)
    .set({ weeklyDigestLastSentAt: new Date(Date.now() - 7 * 86400000) })
    .where(eq(candidatesTable.id, f.candidateId));
  assert.equal((await sender(input)).ok, true);
  assert.equal(sends, 1);
  // Acceptance ledger protects the next tick even if legacy stamp persistence failed.
  assert.equal((await sender(input)).reason, "cooldown");
  assert.equal(sends, 1);
  assert.equal((await sender({ ...f.input, expectedPool: "platform" })).ok, true);
  assert.equal(
    (await sender({ ...f.input, kind: "platform_inactivity", expectedPool: "platform" })).ok,
    true,
  );
  const rows = await f.events();
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.type === "status_update").length, 1);
});
test("uncertain or interrupted-final-write follow-ups remain held while subsequent profile sync still succeeds", async (t) => {
  for (const lostWrite of [false, true]) {
    const f = await fixture(t);
    let sends = 0;
    const sender = createCadencedCommunicationSender({
      ...cadencedCommunicationStore,
      ...(lostWrite
        ? {
            finish: async () => {
              throw Error("Synthetic write interruption");
            },
          }
        : {}),
      send: async () => {
        sends++;
        return lostWrite
          ? { ok: true }
          : { ok: false, acceptance: "unknown", reviewRequired: true };
      },
    });
    for (const [prior, next] of [
      ["Old company", "New venture"],
      ["New venture", "Another venture"],
    ]) {
      const result = await processSelfReportedJobChange(
        {
          candidateId: f.candidateId,
          prevTitle: "Engineer",
          prevCompany: prior,
          newTitle: undefined,
          newCompany: next,
        },
        sender,
      );
      assert.equal(result.changed, true);
      assert.equal(result.emailSent, false);
      assert.equal(result.reason, "review_required");
      const [candidate] = await dbAdmin
        .select()
        .from(candidatesTable)
        .where(eq(candidatesTable.id, f.candidateId));
      assert.equal(candidate.currentCompany, next);
    }
    assert.equal(sends, 1);
    const events = await f.events();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "pending");
    assert.equal(events[0].sentAt, null);
  }
});
test("explicit rejection/non-attempt retains history without blocking a legitimate subsequent attempt", async (t) => {
  for (const acceptance of ["rejected", "not_attempted"] as const) {
    const f = await fixture(t);
    let sends = 0;
    const sender = createCadencedCommunicationSender({
      ...cadencedCommunicationStore,
      send: async () =>
        ++sends === 1 ? { ok: false, acceptance } : { ok: true, acceptance: "accepted" },
    });
    assert.equal((await sender(f.input)).reason, "send_failed");
    assert.equal((await sender(f.input)).ok, true);
    assert.equal(sends, 2);
    const rows = await f.events();
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.status === "failed").length, 1);
    assert.equal(rows.filter((r) => r.status === "sent").length, 1);
  }
});
test("the reservation rechecks quiet/privacy and stale identity snapshots before transport", async (t) => {
  for (const [changes, expected] of [
    [{ doNotContact: true }, "do_not_contact"],
    [{ discoveryPaused: true }, "discovery_paused"],
    [{ email: "changed@example.invalid" }, "profile_changed"],
    [{ dataErasedAt: new Date() }, "erased"],
  ] as const) {
    const f = await fixture(t);
    let sends = 0;
    await dbAdmin.update(candidatesTable).set(changes).where(eq(candidatesTable.id, f.candidateId));
    const sender = createCadencedCommunicationSender({
      ...cadencedCommunicationStore,
      send: async () => {
        sends++;
        return { ok: true };
      },
    });
    assert.equal((await sender(f.input)).reason, expected);
    assert.equal(sends, 0);
    assert.equal((await f.events()).length, 0);
  }
  const f = await fixture(t);
  let sends = 0;
  const sender = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async () => {
      sends++;
      return { ok: true };
    },
  });
  for (const changed of [
    { ownerTenantId: "different-owner" },
    { expectedPool: "platform" },
    { expectedTitle: "Wrong title" },
    { expectedCompany: "Wrong company" },
    { expectedUpdatedAt: new Date(0) },
    { kind: "platform_inactivity" as const },
  ]) {
    assert.equal((await sender({ ...f.input, ...changed })).reason, "profile_changed");
  }
  assert.equal(sends, 0);
  assert.equal((await f.events()).length, 0);
});
test("legacy accepted follow-up receipts share cooldown; unrelated pending messages do not become global contact locks", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const sender = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async () => {
      sends++;
      return { ok: true };
    },
  });
  await dbAdmin.insert(communicationEventsTable).values({
    tenantId: f.input.tenantId,
    candidateId: f.candidateId,
    type: "follow_up",
    status: "pending",
    body: "Unrelated manual pending reply",
  });
  assert.equal((await sender(f.input)).ok, true);
  assert.equal(sends, 1);
  await dbAdmin
    .delete(communicationEventsTable)
    .where(eq(communicationEventsTable.candidateId, f.candidateId));
  await dbAdmin.insert(communicationEventsTable).values({
    tenantId: f.input.tenantId,
    candidateId: f.candidateId,
    type: "follow_up",
    status: "sent",
    body: "Legacy monitor receipt",
    sentAt: new Date(),
  });
  assert.equal((await sender(f.input)).reason, "cooldown");
  assert.equal(sends, 1);
});
test("known simulation/suppression does not leave false cooldown or accepted history", async (t) => {
  for (const flags of [{ simulated: true }, { suppressed: true }]) {
    const f = await fixture(t);
    const sender = createCadencedCommunicationSender({
      ...cadencedCommunicationStore,
      send: async () => ({ ok: true, ...flags }),
    });
    const result = await processSelfReportedJobChange(
      {
        candidateId: f.candidateId,
        prevTitle: "Engineer",
        prevCompany: "Old company",
        newTitle: undefined,
        newCompany: "Synthetic new employer",
      },
      sender,
    );
    assert.equal(result.emailSent, false);
    assert.equal(result.reason, flags.simulated ? "simulated" : "suppressed");
    assert.equal((await f.events()).length, 0);
  }
});
test("a failed reservation never reaches transport, and invalid timing cannot bypass cooldown", async () => {
  let sends = 0;
  const send = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    reserve: async () => {
      throw Error("Private transaction error");
    },
    send: async () => {
      sends++;
      return { ok: true };
    },
  });
  const input: CadencedCommunication = {
    kind: "self_report",
    intervalDays: 30,
    tenantId: "fixture",
    candidateId: "fixture",
    ownerTenantId: "fixture",
    to: "fixture@example.invalid",
    subject: "Fixture",
    body: "Fixture",
    actorLabel: "Fixture",
    action: "self_report.job_change",
  };
  assert.equal((await send(input)).reason, "review_required");
  assert.equal(sends, 0);
  assert.equal((await send({ ...input, intervalDays: NaN })).reason, "invalid_cadence");
  assert.equal(sends, 0);
});
test("the current platform loop preserves thresholds and counts only accepted, non-simulated mail", async () => {
  const source = ts.createSourceFile(
    "candidate-reengagement-scheduler.ts",
    readFileSync(new URL("./candidate-reengagement-scheduler.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (n) =>
      ts.isFunctionDeclaration(n) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
  );
  assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.name);
  const code = ts.transpileModule(fn.getText(source).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [age, result, expectedSent, expectedInterval] of [
    [45, { ok: true }, 1, 30],
    [100, { ok: true }, 1, 60],
    [45, { ok: true, simulated: true }, 0, 30],
    [45, { ok: true, suppressed: true }, 0, 30],
    [45, { ok: false, reason: "review_required" }, 0, 30],
  ] as const) {
    const candidates = {},
      pushes = {},
      events = {};
    const candidate = {
      id: "fixture",
      tenantId: "owner",
      pool: "platform",
      firstName: "Synthetic",
      lastName: "Fixture",
      email: "fixture@example.invalid",
      updatedAt: new Date(Date.now() - age * 86400000),
      discoveryPaused: true,
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = table === candidates ? [candidate] : [];
            return {
              groupBy: async () => rows,
              then: (resolve: (rows: unknown[]) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    };
    let sends = 0;
    const bindings = {
      db,
      candidatesTable: candidates,
      talentPoolSubmissionsTable: pushes,
      communicationEventsTable: events,
      eq: () => null,
      and: () => null,
      inArray: () => null,
      isNull: () => null,
      sql: () => null,
      platformReadExemption: () => {},
      PLATFORM_READ_EXEMPTION: { SELF_DIRECTED_CANDIDATE_MESSAGING: "fixture" },
      logger: { info() {} },
      PASSIVE_THRESHOLD_DAYS: 30,
      INACTIVE_THRESHOLD_DAYS: 90,
      PASSIVE_REMAIL_INTERVAL: 30,
      INACTIVE_REMAIL_INTERVAL: 60,
      buildPassiveEmail: () => ({ subject: "Fixture passive", html: "<p>Fixture</p>" }),
      buildInactiveEmail: () => ({ subject: "Fixture inactive", html: "<p>Fixture</p>" }),
      sendCadencedCommunication: async (input: CadencedCommunication) => {
        sends++;
        assert.equal(input.kind, "platform_inactivity");
        assert.equal(input.intervalDays, expectedInterval);
        assert.equal(input.ownerTenantId, "owner");
        assert.equal(input.htmlOnly, true);
        return result;
      },
    };
    const run: () => Promise<{ sent: number; skipped: number }> = new Function(
      ...Object.keys(bindings),
      `${code};return ${fn.name.text};`,
    )(...Object.values(bindings));
    const output: { sent: number; skipped: number } = await run();
    assert.equal(output.sent, expectedSent);
    assert.equal(sends, 1);
    assert.equal(output.skipped, expectedSent ? 0 : 1);
  }
});
