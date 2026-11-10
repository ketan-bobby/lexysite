import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  journalOwnerIsAlive,
  offerSessionIdentity,
  offerSessionOwnership,
  OfferSessionJournalStore,
} from "./offer-session-journal";
import { offerSessionOptions } from "./offer-session-options";

async function sandbox(run: (store: OfferSessionJournalStore) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "offer-journal-"));
  try {
    await run(new OfferSessionJournalStore(path.join(dir, "private")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const fixture = () => ({ prefix: `offer_session_${randomUUID()}`, ownershipTag: randomUUID() });
const fingerprint = "a".repeat(32);

test("valid CLI modes retain explicit target proof", () => {
  const proof = `--development-fingerprint=${fingerprint}`;
  assert.deepEqual(offerSessionOptions([proof]), {
    fingerprint,
    cleanup: undefined,
    scenario: undefined,
    prepareOnly: false,
  });
  assert.equal(offerSessionOptions([proof, "--scenario=role-change"]).scenario, "role-change");
  assert.equal(offerSessionOptions([proof, "--cleanup=record.json"]).cleanup, "record.json");
  assert.equal(offerSessionOptions([proof, "--prepare-only"]).prepareOnly, true);
  assert.equal(offerSessionOptions([proof], true).fingerprint, fingerprint);
});

test("mistyped cleanup, unknown/duplicate flags and conflicting modes cannot create fixtures", () => {
  for (const args of [
    ["--cleanup"],
    ["--cleanup="],
    ["--scenario="],
    ["--other=value"],
    ["--scenario=unknown"],
    ["--prepare-only", "--prepare-only"],
    ["--development-fingerprint=a", "--development-fingerprint=b"],
    ["--cleanup=record.json", "--prepare-only"],
    ["--cleanup=record.json", "--scenario=suspension"],
    ["--prepare-only", "--scenario=role-change"],
  ])
    assert.throws(() => offerSessionOptions(args));
  assert.throws(() => offerSessionOptions(["--cleanup=record.json"], true));
});

test("private journal contains only canonical non-secret fixture identity", () =>
  sandbox(async (store) => {
    const f = fixture();
    const { name, journal } = await store.create(f, fingerprint);
    assert.deepEqual(await store.read(name), journal);
    assert.deepEqual(journal.staffIds, offerSessionIdentity(f.prefix).staffIds);
    assert.equal(journal.candidateIds.length, 26);
    assert.equal((await fs.stat(path.join(store.directory, name))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
    for (const key of ["password", "passwordHash", "token", "connectionString"])
      assert.ok(!(key in journal));
    assert.equal(await journalOwnerIsAlive(journal.owner), true);
  }));

test("process start identity prevents PID reuse from claiming an active owner", () =>
  sandbox(async (store) => {
    const { journal } = await store.create(fixture(), fingerprint);
    assert.equal(
      await journalOwnerIsAlive({
        ...journal.owner,
        startTime: `${BigInt(journal.owner.startTime) + 1n}`,
      }),
      false,
    );
  }));

test("ownership digest binds process and target metadata but excludes cleanup state", () =>
  sandbox(async (store) => {
    const { journal } = await store.create(fixture(), fingerprint);
    assert.equal(
      offerSessionOwnership(journal),
      offerSessionOwnership({ ...journal, state: "cleaned" }),
    );
    assert.notEqual(
      offerSessionOwnership(journal),
      offerSessionOwnership({ ...journal, fingerprint: "b".repeat(32) }),
    );
    assert.notEqual(
      offerSessionOwnership(journal),
      offerSessionOwnership({ ...journal, owner: { ...journal.owner, startTime: "1" } }),
    );
  }));

test("foreign record IDs and unknown journal fields are rejected", () =>
  sandbox(async (store) => {
    const { name, journal } = await store.create(fixture(), fingerprint);
    const file = path.join(store.directory, name);
    await fs.writeFile(file, JSON.stringify({ ...journal, tenantId: "unrelated-employer" }));
    await assert.rejects(store.read(name), /identity mismatch/);
    await fs.writeFile(file, JSON.stringify({ ...journal, password: "invalid-test-field" }));
    await assert.rejects(store.read(name), /Unexpected journal fields/);
    await fs.writeFile(
      file,
      JSON.stringify({ ...journal, owner: { ...journal.owner, startTime: 123 } }),
    );
    await assert.rejects(store.read(name), /Invalid process identity/);
  }));

test("path traversal and absolute paths are rejected before opening a file", () =>
  sandbox(async (store) => {
    await assert.rejects(store.read("../another.json"), /namespace/);
    await assert.rejects(store.read("/tmp/another.json"), /namespace/);
  }));

test("symlink journal files cannot redirect reads", () =>
  sandbox(async (store) => {
    const { name } = await store.create(fixture(), fingerprint);
    const link = `${fixture().prefix}.json`;
    await fs.symlink(path.join(store.directory, name), path.join(store.directory, link));
    await assert.rejects(store.read(link), /ELOOP/);
  }));

test("non-private journals and oversized payloads fail closed", () =>
  sandbox(async (store) => {
    const { name } = await store.create(fixture(), fingerprint);
    const file = path.join(store.directory, name);
    await fs.chmod(file, 0o644);
    await assert.rejects(store.read(name), /private regular file/);
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, " ".repeat(32769));
    await assert.rejects(store.read(name), /bounded private/);
  }));

test("directory symlinks are rejected", () =>
  sandbox(async (store) => {
    const alias = `${store.directory}-alias`;
    await fs.mkdir(store.directory, { mode: 0o700 });
    await fs.symlink(store.directory, alias);
    await assert.rejects(
      new OfferSessionJournalStore(alias).create(fixture(), fingerprint),
      /symlink/,
    );
  }));

test("cleaned journals remain valid for repeat recovery and preserve ownership", () =>
  sandbox(async (store) => {
    const { name, journal } = await store.create(fixture(), fingerprint);
    await store.markCleaned(name, journal);
    await store.markCleaned(name, journal);
    const cleaned = await store.read(name);
    assert.equal(cleaned.state, "cleaned");
    assert.equal(offerSessionOwnership(cleaned), offerSessionOwnership(journal));
  }));

test("changed process ownership cannot silently overwrite the journal", () =>
  sandbox(async (store) => {
    const { name, journal } = await store.create(fixture(), fingerprint);
    await fs.writeFile(
      path.join(store.directory, name),
      JSON.stringify({
        ...journal,
        owner: { ...journal.owner, startTime: "1" },
      }),
    );
    await assert.rejects(store.markCleaned(name, journal), /changed during cleanup/);
  }));
