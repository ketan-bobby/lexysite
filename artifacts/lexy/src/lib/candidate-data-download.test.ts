import assert from "node:assert/strict";
import { test } from "node:test";
import { readCandidateDataDownload, saveCandidateDataDownload } from "./candidate-data-download";

const payload = {
  schemaVersion: 1,
  candidateId: "candidate-fixture",
  exportedAt: "2026-10-11T00:00:00.000Z",
  candidate: { id: "candidate-fixture" },
  applications: [],
  interviewSessions: [],
  interviewSchedules: [{ id: "schedule-fixture", feedbackRating: null }],
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });

test("valid export becomes a named JSON file without changing redacted data", async () => {
  const file = await readCandidateDataDownload(json(payload));
  assert.equal(file.filename, "lexy-data-export-candidat.json");
  assert.deepEqual(JSON.parse(await file.blob.text()), payload);
  assert.match(file.blob.type, /application\/json/);
});

test("failed requests cannot become downloaded error bodies", async () => {
  for (const status of [401, 403, 410, 500]) {
    await assert.rejects(
      readCandidateDataDownload(new Response('{"detail":"PRIVATE_ERROR"}', { status })),
      (err: Error) => !err.message.includes("PRIVATE_ERROR"),
    );
  }
});

test("HTML, malformed JSON, partial exports and mismatched candidate identity fail visibly", async () => {
  const invalid = [
    new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    json(null),
    json({ ok: true }),
    json({ ...payload, interviewSchedules: undefined }),
    json({ ...payload, candidate: { id: "other-candidate" } }),
  ];
  for (const response of invalid) {
    await assert.rejects(readCandidateDataDownload(response), /incomplete or invalid/);
  }
});

test("a server-controlled candidate ID cannot inject a path into the filename", async () => {
  const candidateId = "../bad\\x";
  const file = await readCandidateDataDownload(
    json({
      ...payload,
      candidateId,
      candidate: { id: candidateId },
    }),
  );
  assert.match(file.filename, /^lexy-data-export-[a-zA-Z0-9_-]+\.json$/);
});

test("browser download clicks the named link and cleans up its temporary resources", () => {
  for (const failClick of [false, true]) {
    let appended = false;
    let clicked = false;
    let removed = false;
    let revoked = false;
    let cleanup: (() => void) | undefined;
    const link = {
      href: "",
      download: "",
      click() {
        clicked = true;
        if (failClick) throw new Error("Download blocked");
      },
      remove() {
        removed = true;
      },
    } as HTMLAnchorElement;
    const save = () =>
      saveCandidateDataDownload(
        { blob: new Blob(["{}"]), filename: "lexy-data-export-fixture.json" },
        {
          createUrl: () => "blob:fixture",
          revokeUrl: (url) => {
            assert.equal(url, "blob:fixture");
            revoked = true;
          },
          createLink: () => link,
          appendLink: (value) => {
            assert.equal(value, link);
            appended = true;
          },
          delayCleanup: (callback) => {
            cleanup = callback;
          },
        },
      );
    if (failClick) assert.throws(save, /Download blocked/);
    else save();
    assert.equal(link.download, "lexy-data-export-fixture.json");
    assert.equal(link.href, "blob:fixture");
    assert.ok(appended && clicked && removed);
    assert.equal(revoked, false);
    cleanup!();
    assert.equal(revoked, true);
  }
});
