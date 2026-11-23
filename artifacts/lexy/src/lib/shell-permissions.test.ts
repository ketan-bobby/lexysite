import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canReadAgentStatus, canReadImpersonation } from "./shell-permissions";

test("only authorized staff request recruiting-agent activity", () => {
  for (const role of ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"])
    assert.equal(canReadAgentStatus(role), true, role);
  for (const role of [undefined, null, "", "candidate", "interviewer", "unknown"])
    assert.equal(canReadAgentStatus(role), false, String(role));
});

test("only platform administrators request impersonation state", () => {
  assert.equal(canReadImpersonation("platform_admin"), true);
  for (const role of [undefined, null, "candidate", "recruiter", "tenant_admin", "recruiter_admin", "hiring_manager", "interviewer"])
    assert.equal(canReadImpersonation(role), false, String(role));
});

test("shared shell waits for authentication and scopes agent caches to the viewer", () => {
  const source = readFileSync(new URL("../components/layout/AppLayout.tsx", import.meta.url), "utf8");
  assert.match(source, /canLoadAgentStatus = !isLoading && !!user && canReadAgentStatus\(user.role\)/);
  assert.match(source, /enabled: canLoadAgentStatus/);
  assert.match(source, /queryKey: \["agent-status-pill", user\?\.id, user\?\.tenantId, user\?\.role\]/);
  assert.match(source, /canLoadAgentStatus && \(/);
});

test("impersonation polling is guarded and late results are discarded", () => {
  const source = readFileSync(new URL("../components/ImpersonationBanner.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!canLoad\) return/);
  assert.match(source, /if \(!cancelled\) setSession/);
  assert.match(source, /session\?\.viewerId === user\?\.id/);
  assert.match(source, /\[canLoad, user\?\.id\]/);
});
