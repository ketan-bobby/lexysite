import assert from "node:assert/strict";

/** Fail closed on ambiguous/empty flags: a mistyped cleanup must never start a new test. */
export function offerSessionOptions(args: string[], recoveryCheck = false) {
  const options = new Map<string, string | boolean>();
  const valued = recoveryCheck
    ? ["--development-fingerprint"]
    : ["--development-fingerprint", "--cleanup", "--scenario"];
  for (const arg of args) {
    const split = arg.indexOf("=");
    const key = split === -1 ? arg : arg.slice(0, split);
    assert.ok(!options.has(key), "Duplicate fixture option.");
    if (!recoveryCheck && arg === "--prepare-only") options.set(key, true);
    else {
      assert.ok(
        valued.includes(key) && split !== -1 && split < arg.length - 1,
        "Unknown or empty fixture option.",
      );
      options.set(key, arg.slice(split + 1));
    }
  }
  const fingerprint = options.get("--development-fingerprint") as string | undefined;
  const cleanup = options.get("--cleanup") as string | undefined;
  const scenario = options.get("--scenario") as "suspension" | "role-change" | undefined;
  const prepareOnly = options.has("--prepare-only");
  assert.ok(!scenario || ["suspension", "role-change"].includes(scenario), "Unknown scenario.");
  assert.ok(
    !(cleanup && (prepareOnly || scenario)) && !(prepareOnly && scenario),
    "Fixture modes cannot be combined.",
  );
  return { fingerprint, cleanup, scenario, prepareOnly };
}
