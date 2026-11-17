/**
 * Opt-in only. Real commits and crashes in a newly initialized socket-only
 * PostgreSQL cluster. Never uses the application's DATABASE_URL or PG* variables.
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
const loader = createRequire(import.meta.url).resolve("tsx");
const worker = fileURLToPath(
  new URL(
    "../src/lib/ats-connectors/fixtures/greenhouse-offer-durability.worker.ts",
    import.meta.url,
  ),
);
const guard = fileURLToPath(new URL("../../../scripts/test-egress-guard.mjs", import.meta.url));
const scope = () =>
  Object.fromEntries(
    ["workflowId", "tenantId", "ownerId", "reviewerId", "submitterId", "connectionRevision"].map(
      (key) => [key, randomUUID()],
    ),
  );

test(
  "committed Greenhouse offer claims survive isolated process and PostgreSQL crashes",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp("/tmp/lexy-offer-durability-");
    const directory = `${root}/data`;
    const socket = `${root}/socket`;
    const token = randomUUID();
    const env = { PATH: process.env.PATH, HOME: root, LANG: "C", TZ: "UTC" };
    const children = new Map();
    let started = false;
    let pool;
    let systemIdentifier;
    const ctl = (args) =>
      exec("pg_ctl", ["-D", directory, "-w", "-t", "15", ...args], { env, timeout: 25_000 });
    const start = async () => {
      started = true; // A timed-out pg_ctl may still have launched the server.
      await ctl([
        "-l",
        `${root}/postgres.log`,
        "-o",
        `-k ${socket} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=20`,
        "start",
      ]);
    };
    const connection = `postgresql://offer_fixture@localhost/postgres?host=${encodeURIComponent(socket)}`;
    function launch(s, mode, extra = {}) {
      const child = spawn(process.execPath, ["--import", guard, "--import", loader, worker], {
        cwd,
        env: { ...env, NODE_ENV: "test", DATABASE_URL: connection },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4000);
      });
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => {
          children.delete(child);
          resolve({ code, signal });
        }),
      );
      children.set(child, exited);
      const message = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Isolated offer checkpoint timed out"));
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
          reject(new Error(`Worker exited before checkpoint (${code}/${signal}): ${stderr}`));
        });
      });
      child.send({
        directory,
        systemIdentifier,
        token,
        scope: s,
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
      const job = launch(s, mode, mode === "uncommitted" ? {} : { pauseAt: point });
      assert.deepEqual(await job.message, { kind: "checkpoint", point });
      job.child.kill("SIGKILL");
      assert.deepEqual(await job.exited, { code: null, signal: "SIGKILL" });
    }
    try {
      await mkdir(socket, { mode: 0o700 });
      await exec(
        "initdb",
        ["-D", directory, "-U", "offer_fixture", "--auth=trust", "--no-locale"],
        { env, timeout: 25_000 },
      );
      await start();
      pool = new pg.Pool({ connectionString: connection, password: "", ssl: false, max: 2 });
      const identity = (
        await pool.query(`
        SELECT current_setting('data_directory') AS directory, system_identifier::text AS identifier,
          inet_server_addr() AS host, current_setting('fsync') AS fsync,
          current_setting('full_page_writes') AS full_page_writes,
          current_setting('synchronous_commit') AS synchronous_commit FROM pg_control_system()
      `)
      ).rows[0];
      assert.equal(identity.directory, directory);
      assert.equal(identity.host, null);
      for (const key of ["fsync", "full_page_writes", "synchronous_commit"])
        assert.equal(identity[key], "on");
      systemIdentifier = identity.identifier;
      await pool.query(`
        CREATE TABLE fixture_owner(token text PRIMARY KEY);
        CREATE TABLE fixture_provider_effects(workflow_id text NOT NULL);
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

      await t.test(
        "killed uncommitted preparation rolls back without an orphaned intent",
        async () => {
          const s = scope();
          await killAt(s, "uncommitted", "uncommitted");
          assert.deepEqual(await run(s, "inspect"), { state: null, effects: 0, sequence: 0 });
          assert.equal((await run(s, "prepare")).state, "approved");
          assert.deepEqual(await run(s, "inspect"), { state: "approved", effects: 0, sequence: 2 });
        },
      );
      await t.test(
        "independent workers replay preparation and acquire only one claim",
        async () => {
          const s = scope();
          const requestId = randomUUID();
          const prepared = await Promise.all([
            run(s, "prepare", { requestId }),
            run(s, "prepare", { requestId }),
          ]);
          assert.equal(prepared[0].id, prepared[1].id);
          const claimed = await Promise.all([run(s, "claim"), run(s, "claim")]);
          assert.equal(claimed.filter((r) => r.acquired).length, 1);
          assert.deepEqual(await run(s, "inspect"), { state: "claimed", effects: 0, sequence: 3 });
        },
      );
      await t.test(
        "concurrent human submission requests produce exactly one simulated effect",
        async () => {
          const s = scope();
          await run(s, "prepare");
          const submitted = await Promise.all([run(s, "submit"), run(s, "submit")]);
          assert(submitted.some((r) => r.state === "verified_submission"));
          assert.deepEqual(await run(s, "inspect"), {
            state: "verified_submission",
            effects: 1,
            sequence: 6,
          });
          assert.equal((await run(s, "submit")).state, "verified_submission");
          assert.equal((await run(s, "inspect")).effects, 1);
        },
      );
      for (const point of ["claimed", "effect", "draft_created", "provider_accepted"]) {
        await t.test(
          `SIGKILL after ${point} preserves a hold; recovery never resubmits`,
          async () => {
            const s = scope();
            await run(s, "prepare");
            await killAt(s, "submit", point);
            const effects = point === "claimed" ? 0 : 1;
            const expected = ["draft_created", "provider_accepted"].includes(point)
              ? point
              : "claimed";
            assert.equal((await run(s, "inspect")).state, expected);
            assert.equal((await run(s, "submit")).state, expected);
            const recovered = await run(s, "recover");
            assert.equal(recovered.state, effects ? "observed_match" : "observed_other");
            assert.equal((await run(s, "submit")).state, recovered.state);
            assert.equal((await run(s, "inspect")).effects, effects);
          },
        );
      }
      await t.test(
        "receipts and uncertain claims survive immediate PostgreSQL shutdown and WAL recovery",
        async () => {
          const verified = scope();
          const uncertain = scope();
          const draft = scope();
          await run(verified, "prepare");
          await run(uncertain, "prepare");
          await run(draft, "prepare");
          assert.equal((await run(verified, "submit")).state, "verified_submission");
          await killAt(uncertain, "submit", "effect");
          await killAt(draft, "submit", "draft_created");
          await ctl(["-m", "immediate", "stop"]);
          started = false;
          await start();
          assert.deepEqual(await run(verified, "inspect"), {
            state: "verified_submission",
            effects: 1,
            sequence: 6,
          });
          assert.equal((await run(verified, "submit")).state, "verified_submission");
          assert.deepEqual(await run(uncertain, "inspect"), {
            state: "claimed",
            effects: 1,
            sequence: 3,
          });
          assert.equal((await run(uncertain, "recover")).state, "observed_match");
          assert.equal((await run(uncertain, "submit")).state, "observed_match");
          assert.equal((await run(uncertain, "inspect")).effects, 1);
          assert.equal((await run(verified, "inspect")).effects, 1);
          assert.deepEqual(await run(draft, "inspect"), {
            state: "draft_created",
            effects: 1,
            sequence: 4,
          });
          assert.equal((await run(draft, "submit")).state, "draft_created");
          assert.equal((await run(draft, "recover")).state, "observed_match");
          assert.equal((await run(draft, "inspect")).effects, 1);
        },
      );
    } finally {
      const exits = [...children.values()];
      for (const child of children.keys()) child.kill("SIGKILL");
      await Promise.all(exits);
      if (pool) await pool.end();
      // Never stop another cluster; preserve files on failed shutdown for inspection.
      if (started) await ctl(["-m", "immediate", "stop"]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
