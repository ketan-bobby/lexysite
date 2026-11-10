/** Opt-in committed fixture with exact, non-credential recovery ownership. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  communicationEventsTable,
  auditLogsTable,
  jobsTable,
  passwordResetTokensTable,
} from "@workspace/db";

export function fixtureIdentity(runId: string) {
  assert.match(runId, /^[0-9a-f-]{36}$/);
  const tenantId = `mail_hold_session_${runId}`;
  return {
    runId,
    tenantId,
    candidateId: `${tenantId}_candidate`,
    changedId: `${tenantId}_changed`,
    retainedId: `${tenantId}_retained`,
    operationId: `inbox-reply:${createHash("sha256").update(runId).digest("hex")}`,
  };
}
const directory = new URL("../../../generated-artifacts/mail-hold-session/", import.meta.url);
function journalPath(runId: string) {
  fixtureIdentity(runId);
  return new URL(`${runId}.json`, directory);
}
export async function newFixture(fingerprint: string) {
  const f = fixtureIdentity(randomUUID());
  const ownership = createHash("sha256").update(randomBytes(32)).digest("hex");
  const journal = { ...f, fingerprint, ownership, ownerPid: process.pid, complete: false };
  await mkdir(directory, { recursive: true });
  await writeFile(journalPath(f.runId), JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  return { ...journal, password: `Aa1!${randomBytes(24).toString("base64url")}` };
}
export async function prepareFixture(f: Awaited<ReturnType<typeof newFixture>>) {
  const passwordHash = await bcrypt.hash(f.password, 10);
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(tenantsTable).values({
      id: f.tenantId,
      slug: f.tenantId,
      name: `ISOLATED mail hold ${f.ownership}`,
      region: "us",
    });
    await tx.insert(usersTable).values(
      [f.changedId, f.retainedId].map((id) => ({
        id,
        tenantId: f.tenantId,
        name: "Synthetic mail hold admin",
        email: `${id}@example.invalid`,
        role: "platform_admin" as const,
        status: "active" as const,
        passwordHash,
      })),
    );
    await tx.insert(candidatesTable).values({
      id: f.candidateId,
      tenantId: f.tenantId,
      pool: "tenant",
      firstName: "Synthetic",
      lastName: "Hold",
      email: "mail-hold@example.invalid",
    });
    await tx.insert(communicationEventsTable).values({
      id: f.operationId,
      tenantId: f.tenantId,
      candidateId: f.candidateId,
      type: "follow_up",
      channel: "email",
      status: "pending",
      subject: "Synthetic private subject",
      body: "Synthetic private body",
    });
  });
}
export async function cleanupFixture(runId: string, fingerprint: string) {
  const f = fixtureIdentity(runId);
  const journal = JSON.parse(await readFile(journalPath(runId), "utf8"));
  assert.equal(journal.fingerprint, fingerprint);
  for (const [key, value] of Object.entries(f))
    assert.equal(journal[key], value, "Altered fixture journal; review required");
  assert.match(journal.ownership, /^[a-f0-9]{64}$/);
  if (journal.ownerPid !== process.pid && !journal.complete) {
    let live = true;
    try {
      process.kill(journal.ownerPid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") live = false;
      else throw e;
    }
    assert.equal(live, false, "Fixture owner is still alive; refuse concurrent cleanup");
  }
  await dbAdmin.transaction(async (tx) => {
    const [tenant] = await tx
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, f.tenantId))
      .for("update");
    if (!tenant) return;
    assert.equal(journal.complete, false, "Completed fixture unexpectedly exists; review required");
    assert.equal(tenant.name, `ISOLATED mail hold ${journal.ownership}`);
    const users = await tx
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.tenantId, f.tenantId));
    assert(
      users.every(
        (u) => [f.changedId, f.retainedId].includes(u.id) && u.email === `${u.id}@example.invalid`,
      ),
    );
    const candidates = await tx
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(eq(candidatesTable.tenantId, f.tenantId))
      .for("update");
    assert(
      candidates.every((c) => c.id === f.candidateId),
      "Unexpected candidate; refuse cleanup",
    );
    const jobs = await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.tenantId, f.tenantId))
      .limit(1);
    assert.equal(jobs.length, 0, "Unexpected hiring records; refuse cleanup");
    const events = await tx
      .select({ id: communicationEventsTable.id })
      .from(communicationEventsTable)
      .where(eq(communicationEventsTable.tenantId, f.tenantId));
    assert(
      events.every((e) => e.id === f.operationId),
      "Unexpected mail; refuse cleanup",
    );
    await tx
      .delete(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.tenantId, f.tenantId),
          eq(auditLogsTable.subjectId, f.candidateId),
          eq(auditLogsTable.action, "mail_hold_reviewed"),
        ),
      );
    await tx
      .delete(communicationEventsTable)
      .where(
        and(
          eq(communicationEventsTable.id, f.operationId),
          eq(communicationEventsTable.tenantId, f.tenantId),
        ),
      );
    await tx
      .delete(candidatesTable)
      .where(and(eq(candidatesTable.id, f.candidateId), eq(candidatesTable.tenantId, f.tenantId)));
    // Exact owned control-plane security evidence, never a tenant/prefix scan.
    await tx
      .delete(auditLogsTable)
      .where(
        and(
          isNull(auditLogsTable.tenantId),
          inArray(auditLogsTable.actorId, [f.changedId, f.retainedId]),
          inArray(auditLogsTable.subjectId, [f.changedId, f.retainedId]),
          eq(auditLogsTable.action, "auth.sessions_revoked"),
        ),
      );
    // Only the two journal-owned identities; also supports reset/replica tests.
    await tx
      .delete(passwordResetTokensTable)
      .where(inArray(passwordResetTokensTable.userId, [f.changedId, f.retainedId]));
    await tx
      .delete(usersTable)
      .where(
        and(
          inArray(usersTable.id, [f.changedId, f.retainedId]),
          eq(usersTable.tenantId, f.tenantId),
        ),
      );
    await tx.delete(tenantsTable).where(eq(tenantsTable.id, f.tenantId));
  });
  const remaining = await dbAdmin
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, f.tenantId));
  assert.equal(remaining.length, 0);
  for (const rows of [
    await dbAdmin
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(inArray(usersTable.id, [f.changedId, f.retainedId])),
    await dbAdmin
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, f.candidateId)),
    await dbAdmin
      .select({ id: communicationEventsTable.id })
      .from(communicationEventsTable)
      .where(eq(communicationEventsTable.id, f.operationId)),
    await dbAdmin
      .select({ id: auditLogsTable.id })
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.subjectId, f.candidateId),
          eq(auditLogsTable.action, "mail_hold_reviewed"),
        ),
      ),
  ])
    assert.equal(
      rows.length,
      0,
      "Fixture rows remain outside their original scope; review required",
    );
  journal.complete = true;
  await writeFile(journalPath(runId), JSON.stringify(journal), { mode: 0o600 });
  return fileURLToPath(journalPath(runId));
}
