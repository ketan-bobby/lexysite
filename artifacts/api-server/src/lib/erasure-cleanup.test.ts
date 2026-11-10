import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { controlDb, deletionRequestsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  stageErasureCleanup,
  processErasureCleanup,
  serializeErasureRequest,
  type CleanupReceipt,
} from "./erasure-cleanup";

const ids: string[] = [];
async function fixture(paths = ["/objects/resumes/fixture.pdf"], notify = true) {
  await controlDb.transaction(async (tx) => {
    await stageErasureCleanup(tx, {
      candidateId: `cleanup-fixture-${randomUUID()}`,
      paths,
      origin: "fixture",
      requestId: undefined,
      notify,
      email: notify ? "fixture@example.invalid" : null,
    }).then((id) => {
      ids.push(id);
    });
  });
  return ids.at(-1)!;
}
async function read(id: string) {
  const [row] = await controlDb
    .select()
    .from(deletionRequestsTable)
    .where(eq(deletionRequestsTable.id, id));
  assert.ok(row);
  return row;
}
after(async () => {
  if (ids.length)
    await controlDb.delete(deletionRequestsTable).where(inArray(deletionRequestsTable.id, ids));
});

test("receipt staging rolls back with erasure and makes no external request", async () => {
  let id = "";
  await assert.rejects(
    controlDb.transaction(async (tx) => {
      id = await stageErasureCleanup(tx, {
        candidateId: `cleanup-fixture-${randomUUID()}`,
        paths: ["/objects/private.pdf"],
        origin: "fixture",
      });
      throw new Error("rollback-fixture");
    }),
    /rollback-fixture/,
  );
  assert.equal(
    (await controlDb.select().from(deletionRequestsTable).where(eq(deletionRequestsTable.id, id)))
      .length,
    0,
  );
});

test("a second request cannot replace an unfinished subject's file receipt", async () => {
  const candidateId = `cleanup-fixture-${randomUUID()}`;
  const first = await controlDb.transaction((tx) =>
    stageErasureCleanup(tx, {
      candidateId,
      paths: ["/objects/private-first.pdf"],
      origin: "fixture",
    }),
  );
  ids.push(first);
  await assert.rejects(
    controlDb.transaction((tx) =>
      stageErasureCleanup(tx, {
        candidateId,
        paths: [],
        origin: "fixture",
      }),
    ),
    /Existing file-cleanup receipt/,
  );
  assert.equal(
    ((await read(first)).storageCleanup as CleanupReceipt).targets[0]!.path,
    "/objects/private-first.pdf",
  );
});

test("an obsolete worker cannot acknowledge deletion or send confirmation after losing its lease", async () => {
  const id = await fixture();
  let release!: () => void,
    entered!: () => void,
    emails = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const operation = processErasureCleanup(id, {
    storage: {
      deleteObjectByPath: async () => {
        entered();
        await gate;
        return { ok: true };
      },
      deleteObjectsUnderPrefix: async () => ({ deleted: 0 }),
    },
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  await started;
  const row = await read(id);
  const receipt = row.storageCleanup as CleanupReceipt;
  receipt.leaseToken = "replacement-owner";
  await controlDb
    .update(deletionRequestsTable)
    .set({ storageCleanup: receipt })
    .where(eq(deletionRequestsTable.id, id));
  const rejection = assert.rejects(operation, /Cleanup lease lost/);
  release();
  await rejection;
  assert.equal(emails, 0);
  assert.equal(((await read(id)).storageCleanup as CleanupReceipt).targets[0]!.state, "pending");
});

test("constructor failure is durable; partial success retries only unresolved targets and confirms once", async () => {
  const id = await fixture();
  let emails = 0,
    objects = 0,
    prefixes = 0;
  await processErasureCleanup(id, {
    createStorage: async () => {
      throw new Error("constructor-fixture");
    },
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal((await read(id)).status, "in_progress");
  assert.equal(
    ((await read(id)).storageCleanup as CleanupReceipt).targets[0]!.path,
    "/objects/resumes/fixture.pdf",
  );
  assert.equal(emails, 0);
  const partial = {
    deleteObjectByPath: async () => {
      objects++;
      return { ok: false };
    },
    deleteObjectsUnderPrefix: async () => {
      prefixes++;
      return { deleted: 2 };
    },
  };
  await processErasureCleanup(id, {
    storage: partial,
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal(emails, 0);
  assert.equal(prefixes, 1);
  await processErasureCleanup(id, {
    storage: {
      ...partial,
      deleteObjectByPath: async () => {
        objects++;
        return { ok: true };
      },
    },
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal(prefixes, 1);
  assert.equal(objects, 2);
  assert.equal(emails, 1);
  const complete = await read(id);
  assert.equal(complete.status, "fulfilled");
  assert.equal((complete.storageCleanup as CleanupReceipt).confirmation, "sent");
  assert.ok(
    (complete.storageCleanup as CleanupReceipt).targets.every((item) => item.path === null),
  );
  await processErasureCleanup(id, {
    createStorage: async () => {
      throw new Error("must not run");
    },
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal(emails, 1);
});

test("worker and manual retry compete for one fenced owner", async () => {
  const id = await fixture();
  let release!: () => void,
    started!: () => void,
    objects = 0,
    emails = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const storage = {
    deleteObjectByPath: async () => {
      objects++;
      started();
      await gate;
      return { ok: true };
    },
    deleteObjectsUnderPrefix: async () => ({ deleted: 1 }),
  };
  const first = processErasureCleanup(id, {
    storage,
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  await entered;
  const second = await processErasureCleanup(id, {
    storage,
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal(second.cleanupPending, true);
  assert.equal(objects, 1);
  release();
  await first;
  assert.equal(objects, 1);
  assert.equal(emails, 1);
});

test("expired dispatch lease recovers without duplicating a possibly accepted email", async () => {
  const id = await fixture();
  const row = await read(id);
  const receipt = row.storageCleanup as CleanupReceipt;
  receipt.state = "running";
  receipt.confirmation = "sending";
  receipt.leaseUntil = new Date(0).toISOString();
  receipt.leaseToken = "crashed-owner";
  receipt.targets.forEach((item) => {
    item.state = "done";
    item.path = null;
  });
  await controlDb
    .update(deletionRequestsTable)
    .set({ storageCleanup: receipt })
    .where(eq(deletionRequestsTable.id, id));
  let emails = 0;
  await processErasureCleanup(id, {
    createStorage: async () => {
      throw new Error("no storage needed");
    },
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal(emails, 0);
  assert.equal((await read(id)).status, "fulfilled");
  assert.equal(((await read(id)).storageCleanup as CleanupReceipt).confirmation, "uncertain");
});

test("unsupported references cannot cause remote deletion or a premature confirmation; serializers hide paths", async () => {
  const id = await fixture([
    "https://invalid.example/private?signature=fixture",
    "/objects/../foreign",
    "/objects/recording-segments/",
  ]);
  let objects = 0,
    prefixes = 0,
    emails = 0;
  const result = await processErasureCleanup(id, {
    storage: {
      deleteObjectByPath: async () => {
        objects++;
        return { ok: true };
      },
      deleteObjectsUnderPrefix: async () => {
        prefixes++;
        return { deleted: 0 };
      },
    },
    sendConfirmation: async () => {
      emails++;
      return true;
    },
  });
  assert.equal(objects, 0);
  assert.equal(prefixes, 1);
  assert.equal(emails, 0);
  assert.equal(result.cleanup?.state, "needs_review");
  const row = await read(id);
  assert.equal(row.status, "in_progress");
  assert.ok(!JSON.stringify(row.storageCleanup).includes("signature"));
  assert.ok(!JSON.stringify(serializeErasureRequest(row)).includes("storageCleanup"));
  assert.ok(!JSON.stringify(serializeErasureRequest(row)).includes("/objects/"));
});
