import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeSerpRequest,
  parseNativeSerpResults,
  nativeSerpBound,
} from "./sourcing-live-adapters";

test("native search accepts only one bounded discovery payload", () => {
  assert.ok(NativeSerpRequest.safeParse({ q: "site:linkedin.com/in engineer", num: 10 }).success);
  for (const input of [
    { q: "engineer", num: 11 },
    { q: "", num: 1 },
    { q: "engineer", num: 1, retry: true },
    { q: "engineer", num: 1, api_key: "forbidden" },
  ])
    assert.equal(NativeSerpRequest.safeParse(input).success, false);
  assert.equal(nativeSerpBound(), undefined);
});

test("native profiles are bounded, deduplicated, sanitized references, never fabricated candidates", () => {
  const rows = [
    {
      title: "Synthetic fixture",
      link: "https://linkedin.com/in/controlled-fixture?tracking=1",
      snippet: "x".repeat(400),
    },
    { title: "duplicate", link: "https://www.linkedin.com/in/controlled-fixture/" },
    { title: "foreign host", link: "https://linkedin.com.evil.invalid/in/profile" },
    { title: "unsafe", link: "javascript:alert(1)" },
    { title: "credential URL", link: "https://user:pass@www.linkedin.com/in/profile" },
    { title: "other page", link: "https://www.linkedin.com/company/fixture" },
    { title: "Second fixture", link: "https://www.linkedin.com/in/controlled-second" },
  ];
  const result = parseNativeSerpResults(
    { search_metadata: { status: "Success" }, organic_results: rows },
    1,
  );
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].url, "https://www.linkedin.com/in/controlled-fixture");
  assert.equal(result.profiles[0].snippet.length, 300);
  for (const response of [
    {},
    { search_metadata: { status: "Processing" } },
    { search_metadata: { status: "Success" }, error: "provider failed" },
  ])
    assert.throws(() => parseNativeSerpResults(response, 1));
});
