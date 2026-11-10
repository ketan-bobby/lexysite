import { test } from "node:test";
import assert from "node:assert/strict";
import { requestOptionalScreenShare } from "./optional-screen-share";

test("available optional capture is returned immediately", async () => {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  assert.equal(await requestOptionalScreenShare(async () => stream), stream);
});
test("denied optional capture does not block start", async () => {
  assert.equal(
    await requestOptionalScreenShare(async () => {
      throw new Error("denied");
    }),
    null,
  );
});
test("unanswered picker times out and stops any late stream", async () => {
  let accept!: (stream: MediaStream) => void;
  let stopped = 0;
  const pending = new Promise<MediaStream>((resolve) => {
    accept = resolve;
  });
  assert.equal(await requestOptionalScreenShare(() => pending, 5), null);
  accept({
    getTracks: () => [
      {
        stop: () => {
          stopped++;
        },
      },
    ],
  } as unknown as MediaStream);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, 1);
});
