/**
 * s3.test.ts — unit tests for the shared S3 client module.
 *
 * Dummy static credentials are set BEFORE import so the client never falls
 * back to the IMDS/network credential chain. No AWS calls are made.
 * Run: npx tsx --test src/lib/s3.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AWS_REGION = "eu-west-2";
process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTDUMMY000";
process.env.AWS_SECRET_ACCESS_KEY = "unit-test-dummy-secret-not-real";
delete process.env.AWS_SESSION_TOKEN;

const { s3Client, S3_DEFAULT_SSE } = await import("./s3");

test("client picks up AWS_REGION from the environment", async () => {
  const region = await s3Client.config.region();
  assert.equal(region, "eu-west-2");
});

test("client uses explicit static credentials when env vars are present", async () => {
  const creds = await s3Client.config.credentials();
  assert.equal(creds.accessKeyId, "AKIAUNITTESTDUMMY000");
  assert.equal(creds.secretAccessKey, "unit-test-dummy-secret-not-real");
  assert.equal(creds.sessionToken, undefined);
});

test("default server-side encryption is AES256", () => {
  assert.equal(S3_DEFAULT_SSE, "AES256");
});
