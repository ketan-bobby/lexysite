/**
 * This legacy smoke creates durable business records and has no exact cleanup.
 * Keep it opt-in and loopback-only. Host checks do not prove database isolation:
 * the operator must separately verify the local API's backing services.
 */
export function smokeTarget(env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Legacy mutating smoke is not permitted in production.");
  }
  if (env.SMOKE_ALLOW_MUTATIONS !== "true") {
    throw new Error(
      "Legacy smoke creates records and may trigger email, billing or automation. Explicit SMOKE_ALLOW_MUTATIONS=true is required in isolated development.",
    );
  }
  let target;
  try {
    target = new URL(env.SMOKE_BASE_URL);
  } catch {
    throw new Error("Set an explicit loopback SMOKE_BASE_URL; no default target is used.");
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      "Legacy smoke requires a loopback HTTP(S) origin without credentials, path, query or fragment. External hosts are refused.",
    );
  }
  if (env.SMOKE_CONFIRMED_ORIGIN !== target.origin) {
    throw new Error(
      "SMOKE_CONFIRMED_ORIGIN must exactly match the intended local API origin, including its non-default port.",
    );
  }
  return target.origin;
}
