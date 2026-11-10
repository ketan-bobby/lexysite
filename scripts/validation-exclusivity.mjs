import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const childFlag = "--lexy-validation-lock-child";
export const validationBusyExitCode = 75;

/**
 * Hold a kernel lock for a complete validation run, including its descendants.
 * A duplicate must fail explicitly before it can seed or clean shared fixtures.
 * The empty lock file may remain: the kernel releases ownership on exit.
 */
export function runValidationExclusively({ workspaceRoot, entryPath, name }) {
  if (process.argv[2] === childFlag) {
    process.argv.splice(2, 1);
    return;
  }
  const identity = createHash("sha256")
    .update(`${realpathSync(workspaceRoot)}\0${name}`)
    .digest("hex");
  const lockPath = path.join(tmpdir(), `lexy-validation-${identity}.lock`);
  const result = spawnSync(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      String(validationBusyExitCode),
      lockPath,
      process.execPath,
      ...process.execArgv,
      entryPath,
      childFlag,
      ...process.argv.slice(2),
    ],
    { cwd: workspaceRoot, stdio: "inherit", env: process.env },
  );
  if (result.status === validationBusyExitCode) {
    console.error(
      `${name} is already running for this workspace. No duplicate checks were started; this invocation is not a passing validation.`,
    );
  } else if (result.error || result.signal) {
    console.error(`${name} validation launcher failed: ${result.error?.message ?? result.signal}`);
  }
  process.exit(result.status ?? 1);
}
