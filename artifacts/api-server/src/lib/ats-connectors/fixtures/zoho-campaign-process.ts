/** Owned child-process harness for synthetic campaign crash/restart checks. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

type Message = {
  kind: string;
  phase?: string;
  processed?: boolean;
  sends?: number;
};
export function campaignProcesses(scope: {
  tenantId: string;
  campaignId: string;
  actorId: string;
}) {
  const children = new Set<ChildProcess>();
  function launch(phase: "prepare" | "send" | "complete") {
    const child = fork(
      fileURLToPath(new URL("./zoho-campaign-recovery.worker.ts", import.meta.url)),
      [],
      {
        execArgv: [
          "--import",
          "tsx",
          "--import",
          fileURLToPath(
            new URL("../../../../../../scripts/test-egress-guard.mjs", import.meta.url),
          ),
        ],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    children.add(child);
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors = (errors + String(chunk)).slice(-4000);
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("exit", (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      }),
    );
    const message = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Campaign process checkpoint timed out"));
      }, 45_000);
      const fail = () => {
        clearTimeout(timer);
        reject(Error("Campaign process exited before checkpoint"));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.once("message", (value: Message) => {
        clearTimeout(timer);
        child.removeListener("exit", fail);
        if (value.kind === "error") reject(Error("Campaign fixture failed"));
        else resolve(value);
      });
    });
    // Attach a rejection handler immediately, even while a sibling starts.
    void message.catch(() => {});
    child.send({ ...scope, phase });
    return { child, message, exited, errors: () => errors };
  }
  return {
    async crash(phase: "prepare" | "send") {
      const job = launch(phase);
      assert.deepEqual(await job.message, { kind: "checkpoint", phase });
      job.child.kill("SIGKILL");
      assert.deepEqual(await job.exited, { code: null, signal: "SIGKILL" });
      assert(!job.errors().includes("[test-egress-guard]"));
    },
    async run() {
      const job = launch("complete");
      const message = await job.message;
      assert.equal(message.kind, "result");
      const timeout = setTimeout(() => job.child.kill("SIGKILL"), 10_000);
      try {
        assert.deepEqual(await job.exited, { code: 0, signal: null }, job.errors());
      } finally {
        clearTimeout(timeout);
      }
      assert(!job.errors().includes("[test-egress-guard]"));
      return message;
    },
    async close() {
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise<void>((resolve) => {
              child.once("exit", () => resolve());
              child.kill("SIGKILL");
            }),
        ),
      );
    },
  };
}
