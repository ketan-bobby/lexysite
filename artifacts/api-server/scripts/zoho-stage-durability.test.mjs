/**
 * Separate opt-in check: creates its OWN disposable PostgreSQL cluster.
 * Never uses DATABASE_URL/PG* or the application database; no network listener.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const worker = fileURLToPath(
  new URL("../src/lib/ats-connectors/fixtures/zoho-stage-durability.worker.ts", import.meta.url),
);
const guard = fileURLToPath(new URL("../../../scripts/test-egress-guard.mjs", import.meta.url));

function snapshot() {
  const binding = { applicationId: "993001", candidateId: "992001", jobId: "991001" };
  const connectionRevision = randomUUID();
  return {
    actor: { id: randomUUID(), tenantId: randomUUID() },
    scope: { campaignId: randomUUID(), recipientId: randomUUID() },
    binding,
    accountRef: "a".repeat(64),
    connectionRevision,
    sourceRevision: "b".repeat(64),
    currentStatus: "Associated",
    targetStatus: "In Review",
    targetStage: "Screening",
    decision: "advance",
    currentHumanDecision: true,
    writePermissionConfirmed: true,
    proof: {
      ...binding,
      contract: "recruit-candidate-job-status-v2",
      evidenceReference: "isolated-synthetic-only",
      accountRef: "a".repeat(64),
      connectionRevision,
      fromStatus: "Associated",
      toStatus: "In Review",
      verifiedBy: "synthetic-reviewer",
      verifiedAt: 1000,
      expiresAt: 2000,
      employerWriteApproved: true,
      applicationTransitionVerified: true,
      sideEffectsReviewed: true,
    },
  };
}

test(
  "committed Zoho ledger survives killed workers and isolated PostgreSQL crash recovery",
  {
    timeout: 180_000,
  },
  async (t) => {
    const root = await mkdtemp("/tmp/lexy-stage-durability-");
    const directory = `${root}/data`;
    const socket = `${root}/socket`;
    const token = randomUUID();
    const env = { PATH: process.env.PATH, HOME: root, LANG: "C", TZ: "UTC" };
    const children = new Set();
    let started = false;
    let pool;
    let systemIdentifier;
    const ctl = (args) =>
      exec("pg_ctl", ["-D", directory, "-w", "-t", "15", ...args], {
        env,
        timeout: 25_000,
      });
    const start = async () => {
      // A timed-out startup may already have launched a server. Attempt shutdown
      // before deleting its directory even when pg_ctl did not report success.
      started = true;
      await ctl([
        "-l",
        `${root}/postgres.log`,
        "-o",
        `-k ${socket} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=20`,
        "start",
      ]);
    };
    const connection = `postgresql://stage_fixture@localhost/postgres?host=${encodeURIComponent(socket)}`;
    const workerEnv = {
      ...env,
      NODE_ENV: "test",
      DATABASE_URL: connection,
    };
    function launch(s, mode, extra = {}) {
      const child = spawn(process.execPath, ["--import", guard, "--import", loader, worker], {
        cwd,
        env: workerEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.add(child);
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4000);
      });
      child.stdout.resume();
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => {
          children.delete(child);
          resolve({ code, signal });
        }),
      );
      const message = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Isolated worker checkpoint timed out"));
        }, 20_000);
        child.once("message", (value) => {
          clearTimeout(timer);
          if (value.kind === "error") reject(new Error(value.error));
          else resolve(value);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`Worker exited before result (${code}/${signal}): ${stderr}`));
        });
      });
      child.send({
        directory,
        token,
        systemIdentifier,
        snapshot: s,
        mode,
        requestId: randomUUID(),
        ...extra,
      });
      return { child, message, exited };
    }
    async function run(s, mode, extra) {
      const job = launch(s, mode, extra);
      const message = await job.message;
      assert.equal(message.kind, "result");
      assert.deepEqual(await job.exited, { code: 0, signal: null });
      return message.result;
    }
    async function killAt(s, mode, point) {
      const job = launch(s, mode, { pauseAt: mode === "uncommitted" ? undefined : point });
      assert.deepEqual(await job.message, { kind: "checkpoint", point });
      job.child.kill("SIGKILL");
      assert.deepEqual(await job.exited, { code: null, signal: "SIGKILL" });
    }
    try {
      await mkdir(socket, { mode: 0o700 });
      await exec(
        "initdb",
        ["-D", directory, "-U", "stage_fixture", "--auth=trust", "--no-locale"],
        {
          env,
          timeout: 25_000,
        },
      );
      await start();
      pool = new pg.Pool({ connectionString: connection, password: "", ssl: false, max: 2 });
      const identity = (
        await pool.query(`
      SELECT current_setting('data_directory') AS directory,
        system_identifier::text AS identifier, inet_server_addr() AS host,
        current_setting('fsync') AS fsync,
        current_setting('full_page_writes') AS full_page_writes,
        current_setting('synchronous_commit') AS synchronous_commit
      FROM pg_control_system()
    `)
      ).rows[0];
      assert.equal(identity.directory, directory);
      assert.equal(identity.host, null);
      for (const key of ["fsync", "full_page_writes", "synchronous_commit"])
        assert.equal(identity[key], "on");
      systemIdentifier = identity.identifier;
      // Minimal ledger schema only, not an RLS/erasure/schema-migration fixture.
      await pool.query(`
      CREATE TABLE fixture_owner(token text PRIMARY KEY);
      CREATE TABLE fixture_provider_effects(recipient_id text NOT NULL);
      CREATE TABLE audit_logs(
        id text PRIMARY KEY, tenant_id text, actor_type text NOT NULL,
        actor_id text, actor_label text, subject_type text, subject_id text,
        subject_label text, channel text NOT NULL, direction text NOT NULL,
        action text NOT NULL, title text, body text, metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
      await pool.query("INSERT INTO fixture_owner VALUES ($1)", [token]);
      await pool.end();
      pool = null;

      await t.test("stage and combined source fences serialize concurrent changes", async () => {
        assert.deepEqual(await run(snapshot(), "authority"), {
          barrier: {
            cases: 11,
            checks: 22,
            actualRequestRole: false,
            liveProvider: false,
          },
          combined: {
            cases: 9,
            checks: 18,
            unchangedControl: true,
            actualRequestRole: false,
          },
        });
      });

      await t.test(
        "killed uncommitted preparation rolls back and can be prepared again",
        async () => {
          const s = snapshot();
          await killAt(s, "uncommitted", "uncommitted");
          assert.deepEqual(await run(s, "inspect"), { states: [], effects: 0, sequence: 0 });
          await run(s, "prepare");
          assert.deepEqual((await run(s, "inspect")).states, ["approved"]);
        },
      );

      for (const point of ["claimed", "effect", "provider_accepted"]) {
        await t.test(`SIGKILL after ${point}: recovery observes without resending`, async () => {
          const s = snapshot();
          const prepared = await run(s, "prepare");
          await killAt(s, "execute", point);
          const expectedEffects = point === "claimed" ? 0 : 1;
          const before = await run(s, "inspect");
          assert.equal(before.effects, expectedEffects);
          assert.deepEqual(before.states, [point === "provider_accepted" ? point : "claimed"]);
          const retry = await run(s, "execute");
          assert.equal(retry.state, before.states[0]);
          const recovered = await run(s, "recover", { attemptId: prepared.id });
          assert.equal(recovered.state, expectedEffects ? "observed_target" : "observed_other");
          assert.equal((await run(s, "execute")).state, recovered.state);
          assert.equal((await run(s, "inspect")).effects, expectedEffects);
        });
      }

      await t.test("competing processes acquire exactly one committed claim", async () => {
        const s = snapshot();
        await run(s, "prepare");
        const outcomes = await Promise.all([run(s, "claim"), run(s, "claim")]);
        assert.equal(outcomes.filter((r) => r.acquired).length, 1);
        assert.deepEqual(await run(s, "inspect"), { states: ["claimed"], effects: 0, sequence: 3 });
      });

      await t.test(
        "verified receipt and uncertain claim survive PostgreSQL immediate stop/recovery",
        async () => {
          const verified = snapshot();
          const uncertain = snapshot();
          await run(verified, "prepare");
          await run(uncertain, "prepare");
          assert.equal((await run(verified, "execute")).state, "verified");
          await killAt(uncertain, "execute", "effect");
          await ctl(["-m", "immediate", "stop"]);
          started = false;
          await start();
          assert.equal((await run(verified, "execute")).state, "verified");
          assert.equal((await run(verified, "inspect")).effects, 1);
          assert.equal((await run(uncertain, "execute")).state, "claimed");
          assert.equal((await run(uncertain, "inspect")).effects, 1);
        },
      );
    } finally {
      for (const child of children) child.kill("SIGKILL");
      if (pool) await pool.end();
      // Only the cluster created by this invocation, never an application's server.
      // If shutdown fails, preserve its directory for inspection rather than delete.
      if (started) await ctl(["-m", "immediate", "stop"]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
