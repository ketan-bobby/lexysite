import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { recoverBeforeListening } from "./startup-recovery";

test("HTTP cannot listen until delayed recovery has completed", async () => {
  const server = createServer((_req, res) => res.end("fixture only"));
  let release!: () => void;
  const recovery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = recoverBeforeListening({
    recover: () => recovery,
    listen: () => server.listen(0, "127.0.0.1"),
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.listening, false);
    release();
    await started;
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once("listening", resolve);
    });
    assert.equal(server.listening, true);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("recovery failure preserves the error and never starts HTTP/workers", async () => {
  const error = new Error("fixture recovery failed");
  let listening = false;
  await assert.rejects(
    recoverBeforeListening({
      recover: async () => {
        throw error;
      },
      listen: () => {
        listening = true;
      },
    }),
    (caught) => caught === error,
  );
  assert.equal(listening, false);
});

test("timeout remains closed even when recovery later completes", async () => {
  let release!: () => void;
  let listens = 0;
  const recovery = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    recoverBeforeListening({
      recover: () => recovery,
      listen: () => {
        listens++;
      },
      timeoutMs: 15,
    }),
    /Startup recovery timed out/,
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listens, 0);
});

test("synchronous failure and invalid deadlines also fail closed", async () => {
  let listens = 0;
  await assert.rejects(
    recoverBeforeListening({
      recover: () => {
        throw new Error("fixture sync failure");
      },
      listen: () => {
        listens++;
      },
    }),
    /fixture sync failure/,
  );
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(
      recoverBeforeListening({
        recover: async () => {},
        listen: () => {
          listens++;
        },
        timeoutMs,
      }),
      /positive finite timeout/,
    );
  }
  assert.equal(listens, 0);
});

test("entrypoint gates recovery before HTTP and keeps workers in listening callback", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const callback = source.slice(
    source.indexOf('server.on("listening"'),
    source.indexOf('server.on("error"'),
  );
  assert.ok(callback.includes("startAiWorker()"));
  assert.ok(!callback.includes("reconcileStaleAgentRuns("));
  assert.ok(!callback.includes("reconcileStalePipelineRuns("));
  assert.ok(source.includes("await reconcileStaleAgentRuns(processStartedAt)"));
  assert.ok(source.includes("await reconcileStalePipelineRuns({ strict: true })"));
  assert.ok(source.includes("listen: startListening"));
  assert.ok(source.includes("new Date(performance.timeOrigin)"));
  assert.equal(source.match(/^\s*startListening\(\);/gm)?.length ?? 0, 0);
});
