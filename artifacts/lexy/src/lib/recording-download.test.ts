import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { downloadRecording } from "./recording-download";

test("recording download saves authenticated bytes without navigating to the stream", async () => {
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    window: globalThis.window,
  };
  const create = mock.method(URL, "createObjectURL", () => "blob:local-recording");
  const revoke = mock.method(URL, "revokeObjectURL", () => {});
  const link = { href: "", download: "", click: mock.fn(), remove: mock.fn() };
  const append = mock.fn();
  let cleanup: (() => void) | undefined;
  try {
    globalThis.document = { createElement: () => link, body: { append } } as unknown as Document;
    globalThis.window = {
      setTimeout: (fn: () => void) => {
        cleanup = fn;
        return 1;
      },
    } as unknown as Window & typeof globalThis;
    for (const [type, extension] of [
      ["video/webm", "webm"],
      ["video/mp4", "mp4"],
    ]) {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, "/api/storage/objects/private-recording");
        assert.equal(options?.credentials, "include");
        assert.deepEqual(options?.headers, { Authorization: "Bearer test-only" });
        return new Response(new Blob(["video"], { type }));
      };
      await downloadRecording("/api/storage/objects/private-recording", "session", {
        Authorization: "Bearer test-only",
      });
      assert.equal(link.href, "blob:local-recording");
      assert.equal(link.download, `interview-session.${extension}`);
      assert.equal(revoke.mock.callCount(), extension === "webm" ? 0 : 1);
      cleanup?.();
    }
    assert.equal(link.click.mock.callCount(), 2);
    assert.equal(link.remove.mock.callCount(), 2);
    assert.equal(append.mock.callCount(), 2);
    assert.equal(create.mock.callCount(), 2);
    for (const response of [new Response("denied", { status: 403 }), new Response("")]) {
      globalThis.fetch = async () => response;
      await assert.rejects(
        downloadRecording("/api/storage/objects/private-recording", "session", {}),
      );
    }
    assert.equal(link.click.mock.callCount(), 2, "failed responses must not download");
  } finally {
    Object.assign(globalThis, original);
    create.mock.restore();
    revoke.mock.restore();
  }
});
