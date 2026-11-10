import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NativePdlRequest,
  NativeEnrichRequest,
  nativeEnrichmentEndpoint,
  nativeProfileUrl,
  parseNativePdlResults,
  parseNativeEnrichResult,
  readNativeJson,
} from "./sourcing-native-provider-ports";

test("native PDL accepts a single scoped query, not arbitrary bodies or hidden fan-out", () => {
  assert.ok(NativePdlRequest.safeParse({ title: "Engineer", location: null, size: 8 }).success);
  for (const body of [
    { title: "Engineer", location: null, size: 11 },
    { title: "Engineer", location: null, size: 0 },
    { title: "Engineer", location: null, size: 2, query: { arbitrary: true } },
  ])
    assert.equal(NativePdlRequest.safeParse(body).success, false);
});

test("provider profiles normalize, deduplicate, respect limits and omit contact/raw fields", () => {
  const result = parseNativePdlResults(
    {
      data: [
        {
          full_name: "Fixture Person",
          linkedin_url: "linkedin.com/in/fixture-one",
          job_title: "Engineer",
          work_email: "private@example.invalid",
          personal_emails: ["private"],
        },
        { full_name: "Duplicate", linkedin_url: "https://www.linkedin.com/in/fixture-one/" },
        { full_name: "Foreign", linkedin_url: "https://private.example/in/fixture" },
        { full_name: "Second", linkedin_url: "https://linkedin.com/in/fixture-two" },
      ],
    },
    1,
  );
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].url, "https://www.linkedin.com/in/fixture-one");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.deepEqual(parseNativePdlResults({ data: [] }, 3), { profiles: [] });
  assert.throws(() => parseNativePdlResults({ error: "provider-error" }, 1));
});

test("enrichment accepts only canonical saved-profile-shaped URLs, never arbitrary URLs", () => {
  for (const url of [
    "http://www.linkedin.com/in/fixture",
    "https://evil.example/in/fixture",
    "https://secret@www.linkedin.com/in/fixture",
    "https://www.linkedin.com:8443/in/fixture",
    "https://www.linkedin.com/company/fixture",
    "https://www.linkedin.com/in/fixture?token=secret",
  ])
    assert.equal(NativeEnrichRequest.safeParse({ url }).success, false);
  const url = "https://www.linkedin.com/in/fixture";
  assert.ok(NativeEnrichRequest.safeParse({ url }).success);
  assert.equal(nativeProfileUrl("linkedin.com/in/fixture"), url);
  const result = parseNativeEnrichResult(
    {
      full_name: "Fixture",
      headline: "Engineer",
      email: "private@example.invalid",
      experiences: [{ description: "private-extra" }],
    },
    url,
  );
  assert.equal(result.profiles[0].url, url);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.throws(() => parseNativeEnrichResult({ error: "private-provider-error" }, url));
});

test("bounded response parser preserves valid JSON and rejects oversized provider payloads", async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await readNativeJson(new Response('{"data":[]}'), signal), { data: [] });
  await assert.rejects(readNativeJson(new Response("x".repeat(1_000_001)), signal), /bounded size/);
});

test("native enrichment uses the documented profile_url parameter without optional paid add-ons", () => {
  const url = "https://www.linkedin.com/in/fixture";
  const endpoint = nativeEnrichmentEndpoint(url);
  assert.equal(endpoint.origin, "https://enrichlayer.com");
  assert.equal(endpoint.pathname, "/api/v2/profile");
  assert.deepEqual([...endpoint.searchParams.entries()], [["profile_url", url]]);
  assert.throws(() => nativeEnrichmentEndpoint("https://private.invalid/profile"));
});
