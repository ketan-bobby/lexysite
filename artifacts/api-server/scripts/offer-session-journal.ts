/** Private, non-secret write-ahead identity records. No database or auth imports. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const prefixPattern = new RegExp(`^offer_session_${uuid}$`);
const uuidPattern = new RegExp(`^${uuid}$`);
const root = fileURLToPath(
  new URL("../../../generated-artifacts/offer-session-journals/", import.meta.url),
);

export function offerSessionIdentity(prefix: string) {
  assert.ok(typeof prefix === "string" && prefixPattern.test(prefix), "Invalid fixture namespace.");
  return {
    prefix,
    tenantId: `${prefix}_employer`,
    jobId: `${prefix}_job`,
    journeyId: `${prefix}_journey`,
    staffIds: [`${prefix}_revoked`, `${prefix}_retained`],
    candidateIds: Array.from({ length: 26 }, (_, i) => `${prefix}_candidate_${i}`),
    applicationIds: Array.from({ length: 26 }, (_, i) => `${prefix}_application_${i}`),
    workflowIds: Array.from({ length: 26 }, (_, i) => `${prefix}_workflow_${i}`),
  };
}
export type OfferSessionIdentity = ReturnType<typeof offerSessionIdentity>;
export type FixtureOwner = { pid: number; startTime: string; bootId: string };
export type OfferSessionJournal = OfferSessionIdentity & {
  version: 1;
  fingerprint: string;
  ownershipTag: string;
  createdAt: string;
  owner: FixtureOwner;
  state: "pending" | "cleaned";
};
/** Bind every immutable journal field to the database marker, including process ownership. */
export function offerSessionOwnership(j: OfferSessionJournal) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...offerSessionIdentity(j.prefix),
        version: j.version,
        fingerprint: j.fingerprint,
        ownershipTag: j.ownershipTag,
        createdAt: j.createdAt,
        owner: { pid: j.owner.pid, startTime: j.owner.startTime, bootId: j.owner.bootId },
      }),
    )
    .digest("hex");
}

async function processIdentity(pid: number) {
  const [stat, bootId] = await Promise.all([
    fs.readFile(`/proc/${pid}/stat`, "utf8"),
    fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
  ]);
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  assert.ok(startTime && /^\d+$/.test(startTime), "Cannot establish process identity.");
  return { pid, startTime, bootId: bootId.trim(), zombie: fields[0] === "Z" };
}
export async function journalOwnerIsAlive(owner: FixtureOwner) {
  try {
    const actual = await processIdentity(owner.pid);
    return !actual.zombie && actual.startTime === owner.startTime && actual.bootId === owner.bootId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error; // Unknown process visibility is not permission to delete.
  }
}

function journalName(name: string) {
  assert.ok(typeof name === "string" && name.endsWith(".json"), "A journal basename is required.");
  const prefix = name.slice(0, -5);
  offerSessionIdentity(prefix); // Reject paths, traversal and arbitrary names before filesystem I/O.
  return prefix;
}
function parseJournal(input: unknown, name: string): OfferSessionJournal {
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "Invalid journal.");
  const value = input as OfferSessionJournal;
  const identity = offerSessionIdentity(journalName(name));
  const keys = [
    ...Object.keys(identity),
    "version",
    "fingerprint",
    "ownershipTag",
    "createdAt",
    "owner",
    "state",
  ].sort();
  assert.ok(Object.keys(value).sort().join(",") === keys.join(","), "Unexpected journal fields.");
  for (const key of Object.keys(identity) as (keyof OfferSessionIdentity)[]) {
    assert.ok(
      JSON.stringify(value[key]) === JSON.stringify(identity[key]),
      "Journal identity mismatch.",
    );
  }
  assert.ok(
    value.version === 1 && ["pending", "cleaned"].includes(value.state),
    "Invalid journal version/state.",
  );
  assert.ok(
    typeof value.fingerprint === "string" && /^[a-f0-9]{32}$/.test(value.fingerprint),
    "Invalid target proof.",
  );
  assert.ok(
    typeof value.ownershipTag === "string" && uuidPattern.test(value.ownershipTag),
    "Invalid fixture ownership.",
  );
  assert.ok(
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)),
    "Invalid journal timestamp.",
  );
  const owner = value.owner;
  assert.ok(
    owner &&
      typeof owner === "object" &&
      Object.keys(owner).sort().join(",") === "bootId,pid,startTime",
    "Invalid journal owner.",
  );
  assert.ok(
    Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.startTime === "string" &&
      /^\d+$/.test(owner.startTime) &&
      typeof owner.bootId === "string" &&
      /^[a-f0-9-]{36}$/.test(owner.bootId),
    "Invalid process identity.",
  );
  return value;
}

export class OfferSessionJournalStore {
  constructor(readonly directory = root) {}

  private async checkDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Journal directory must not be a symlink.",
    );
    assert.ok(
      stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
      "Journal directory must be private.",
    );
    assert.ok(
      (await fs.realpath(this.directory)) === path.resolve(this.directory),
      "Journal directory path is not canonical.",
    );
  }

  private async syncDirectory() {
    const dir = await fs.open(this.directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  async create(f: { prefix: string; ownershipTag: string }, fingerprint: string) {
    const identity = offerSessionIdentity(f.prefix);
    const processOwner = await processIdentity(process.pid);
    const owner = {
      pid: processOwner.pid,
      startTime: processOwner.startTime,
      bootId: processOwner.bootId,
    };
    const journal: OfferSessionJournal = {
      ...identity,
      version: 1,
      fingerprint,
      ownershipTag: f.ownershipTag,
      owner,
      createdAt: new Date().toISOString(),
      state: "pending",
    };
    const name = `${f.prefix}.json`;
    parseJournal(journal, name);
    await this.checkDirectory();
    const handle = await fs.open(
      path.join(this.directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(journal));
      await handle.sync(); // Must finish before the fixture transaction starts.
    } finally {
      await handle.close();
    }
    await this.syncDirectory();
    return { name, journal };
  }

  async read(name: string) {
    journalName(name);
    await this.checkDirectory();
    const handle = await fs.open(
      path.join(this.directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      assert.ok(
        stat.isFile() &&
          stat.uid === process.getuid?.() &&
          (stat.mode & 0o077) === 0 &&
          stat.size <= 32768,
        "Journal must be a bounded private regular file.",
      );
      const buffer = Buffer.alloc(32769);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      assert.ok(bytesRead <= 32768, "Journal is too large.");
      let data: unknown;
      try {
        data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch {
        throw new Error("Invalid recovery journal JSON.");
      }
      return parseJournal(data, name);
    } finally {
      await handle.close();
    }
  }

  async markCleaned(name: string, original: OfferSessionJournal) {
    const current = await this.read(name);
    assert.ok(
      offerSessionOwnership(current) === offerSessionOwnership(original),
      "Journal changed during cleanup.",
    );
    const temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ ...current, state: "cleaned" }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, path.join(this.directory, name));
      await this.syncDirectory();
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
