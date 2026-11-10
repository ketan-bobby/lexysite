/** Controlled child-process interruption. Requires the same independently verified dev target. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { assertDevelopmentTarget } from "./offer-session-fixture";
import { OfferSessionJournalStore, type OfferSessionJournal } from "./offer-session-journal";
import { recoverOfferSessionJournal } from "./offer-session-recovery";
import { offerSessionOptions } from "./offer-session-options";

let fingerprint: string | undefined;
const store = new OfferSessionJournalStore();
type Child = {
  process: ChildProcess;
  name?: string;
  original?: OfferSessionJournal;
  exited: Promise<unknown[]>;
};
const children: Child[] = [];
const runner = fileURLToPath(new URL("./check-offer-session-access.ts", import.meta.url));

function alive(child: Child) {
  return child.process.exitCode === null && child.process.signalCode === null;
}
async function waitForExit(child: Child) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture child did not stop.")), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function startFixture() {
  const process = spawn(
    globalThis.process.execPath,
    [
      ...globalThis.process.execArgv,
      runner,
      `--development-fingerprint=${fingerprint}`,
      "--prepare-only",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const child: Child = { process, exited: once(process, "exit") };
  children.push(child); // Register before any await, so failed startup is also cleaned.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture child never became ready.")), 45_000);
    let output = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    process.on("error", finish);
    process.on("exit", () => finish(new Error("Fixture child exited before ready.")));
    process.stderr?.resume(); // Never echo arbitrary child diagnostic payloads.
    process.stdout?.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16384);
      const journal = output.match(/RECOVERY_JOURNAL (offer_session_[a-f0-9-]{36}\.json)/);
      if (journal) child.name = journal[1];
      if (output.includes(`FIXTURE_READY ${child.name}\n`)) finish();
    });
  });
  assert.ok(child.name);
  child.original = await store.read(child.name);
  return child;
}
async function businessCounts(journal: OfferSessionJournal, expected: number) {
  for (const table of [
    "users",
    "candidates",
    "applications",
    "recruiting_workflows",
    "jobs",
    "recruiting_journeys",
  ]) {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1`,
      [journal.tenantId],
    );
    const count =
      expected === 0
        ? 0
        : table === "users"
          ? 2
          : ["jobs", "recruiting_journeys"].includes(table)
            ? 1
            : 26;
    assert.equal(result.rows[0].count, count, "Fixture scope was unexpectedly changed.");
  }
  const tenant = await pool.query("SELECT count(*)::int AS count FROM tenants WHERE id=$1", [
    journal.tenantId,
  ]);
  assert.equal(tenant.rows[0].count, expected === 0 ? 0 : 1);
}

let completed = false;
try {
  ({ fingerprint } = offerSessionOptions(process.argv.slice(2), true));
  await assertDevelopmentTarget(fingerprint);
  const killed = await startFixture();
  const peer = await startFixture();
  const original = killed.original!;
  const peerOriginal = peer.original!;
  await assert.rejects(recoverOfferSessionJournal(killed.name!, fingerprint), /still running/);
  // Changing a live owner's start identity must not bypass the DB-bound ownership proof.
  await writeFile(
    path.join(store.directory, peer.name!),
    JSON.stringify({
      ...peerOriginal,
      owner: { ...peerOriginal.owner, startTime: "1" },
    }),
  );
  try {
    await assert.rejects(
      recoverOfferSessionJournal(peer.name!, fingerprint),
      /ownership marker mismatch/,
    );
  } finally {
    await writeFile(path.join(store.directory, peer.name!), JSON.stringify(peerOriginal));
  }
  await businessCounts(peerOriginal, 26);

  assert.ok(killed.process.kill("SIGKILL")); // Only our directly spawned fixture process.
  await waitForExit(killed);
  assert.equal(killed.process.signalCode, "SIGKILL");
  await businessCounts(original, 26); // Demonstrate that finally really was bypassed.
  await assert.rejects(
    recoverOfferSessionJournal(killed.name!, "0".repeat(32)),
    /not the verified development target/,
  );
  await writeFile(
    path.join(store.directory, killed.name!),
    JSON.stringify({ ...original, tenantId: peerOriginal.tenantId }),
  );
  try {
    await assert.rejects(
      recoverOfferSessionJournal(killed.name!, fingerprint),
      /identity mismatch/,
    );
  } finally {
    await writeFile(path.join(store.directory, killed.name!), JSON.stringify(original));
  }

  await recoverOfferSessionJournal(killed.name!, fingerprint);
  await recoverOfferSessionJournal(killed.name!, fingerprint);
  await businessCounts(original, 0);
  await businessCounts(peerOriginal, 26); // Recovery of A must never sweep live B's namespace.
  assert.ok(alive(peer));
  assert.ok(peer.process.kill("SIGTERM"));
  await waitForExit(peer);
  assert.equal(peer.process.exitCode, 143);
  await businessCounts(peerOriginal, 0);
  assert.equal((await store.read(peer.name!)).state, "cleaned");
  await recoverOfferSessionJournal(peer.name!, fingerprint);
  completed = true;
  console.log(
    "PASS: SIGKILL recovery; repeated exact-fixture cleanup; live peer preserved; forged ownership/IDs and wrong target refused; SIGTERM cleanup.",
  );
} finally {
  try {
    for (const child of children) {
      if (alive(child)) {
        child.process.kill("SIGKILL");
        await waitForExit(child);
      }
      if (child.name) {
        // Restore only our captured original journal if this negative-case test failed mid-edit.
        if (!completed && child.original) {
          await writeFile(path.join(store.directory, child.name), JSON.stringify(child.original));
        }
        await recoverOfferSessionJournal(child.name, fingerprint);
      }
    }
  } finally {
    await pool.end();
  }
}
