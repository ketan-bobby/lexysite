import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "qor-test-"));
const data = join(root, "data");
const socket = join(root, "socket");
const port = 5432; // Separate socket directory; no network listener.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", TZ: "UTC" };
const run = (command, args) => exec(command, args, { cwd, env, timeout: 30000 });
try {
  await mkdir(socket, { mode: 0o700 });
  await run("initdb", [
    "-D",
    data,
    "-U",
    "qor_fixture",
    "--auth=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  await run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(root, "postgres.log"),
    "-o",
    `-k ${socket} -p ${port} -c listen_addresses=''`,
    "-w",
    "start",
  ]);
  const connection = new URL("postgresql://qor_fixture@localhost/postgres");
  connection.searchParams.set("host", socket);
  connection.searchParams.set("port", String(port));
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = await exec(
    process.execPath,
    [
      "--import",
      "../../scripts/test-egress-guard.mjs",
      "--import",
      tsx,
      "--test",
      "src/routes/qor-interviews.sandbox.test.ts",
    ],
    {
      cwd,
      timeout: 60000,
      env: {
        ...env,
        DATABASE_URL: connection.toString(),
        QOR_FIXTURE_DATA_DIRECTORY: data,
        SESSION_SECRET: randomBytes(48).toString("hex"),
        // The SDK is constructed at import time. No real key or network is allowed.
        OPENAI_API_KEY: "qor-sandbox-inert-placeholder",
      },
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  // Test assertions never include credentials. Don't print env or spawn details.
  process.stdout.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? "");
  process.stderr.write("The isolated QOR sandbox did not pass.\n");
  process.exitCode = 1;
} finally {
  await run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
