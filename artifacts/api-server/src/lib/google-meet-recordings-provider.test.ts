import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  googleMeetRecordingsProvider,
  GoogleMeetRecordingError,
  GOOGLE_MEET_RECORDING_SCOPES,
  meetRecordingFingerprint,
} from "./google-meet-recordings-provider";
import { GOOGLE_STAFF_SCOPES, GOOGLE_INVITATION_SCOPE } from "./google-staff-config";
import { MAX_MEETING_BYTES } from "./meeting-notes-core";

const window = {
  meetingCode: "abc-defg-hij",
  windowStart: "2026-11-04T10:00:00Z",
  windowEnd: "2026-11-04T11:00:00Z",
};
const conference = {
  name: "conferenceRecords/fixture-instance",
  space: "spaces/fixture-space",
  startTime: "2026-11-04T10:01:00Z",
  endTime: "2026-11-04T10:03:00Z",
};
const recording = {
  name: `${conference.name}/recordings/fixture-recording`,
  state: "FILE_GENERATED",
  startTime: "2026-11-04T10:01:00Z",
  endTime: "2026-11-04T10:02:00Z",
  driveDestination: {
    file: "fixture-file",
    exportUri: "https://attacker.test/not-used",
  },
};
const metadata = () => ({
  id: "fixture-file",
  size: "4",
  mimeType: "video/mp4",
  version: "12",
  md5Checksum: createHash("md5").update("data").digest("hex"),
  modifiedTime: "2026-11-04T10:04:00Z",
  trashed: false,
  capabilities: { canDownload: true },
  videoMediaMetadata: { durationMillis: "60000" },
});
function fixture(override?: (url: URL, call: number) => Response | undefined) {
  const calls: URL[] = [];
  const request: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw));
    calls.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-token");
    assert.equal(init.body, undefined);
    assert.ok(init.signal);
    const custom = override?.(url, calls.length);
    if (custom) return custom;
    if (url.hostname === "meet.googleapis.com") {
      if (url.pathname === `/v2/spaces/${window.meetingCode}`)
        return Response.json({ name: conference.space, meetingCode: window.meetingCode });
      if (url.pathname === "/v2/conferenceRecords")
        return Response.json({ conferenceRecords: [conference] });
      if (url.pathname === `/v2/${conference.name}`) return Response.json(conference);
      if (url.pathname === `/v2/${conference.name}/recordings`)
        return Response.json({ recordings: [recording] });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/fixture-file") {
      if (url.searchParams.get("alt") === "media") return new Response("data");
      assert.match(url.searchParams.get("fields")!, /capabilities\(canDownload\)/);
      return Response.json(metadata());
    }
    assert.fail(`Unexpected provider request: ${url.origin}${url.pathname}`);
  };
  return { calls, provider: googleMeetRecordingsProvider(request) };
}
const preview = (f: ReturnType<typeof fixture>) =>
  f.provider.preview("synthetic-token", window, conference.name);
const failure = (status: number) => (error: unknown) =>
  error instanceof GoogleMeetRecordingError && error.status === status;

test("Meet grants are separate and recording-only Drive access does not expand calendar defaults", () => {
  assert.deepEqual(GOOGLE_MEET_RECORDING_SCOPES, [
    "https://www.googleapis.com/auth/meetings.space.readonly",
    "https://www.googleapis.com/auth/drive.meet.readonly",
  ]);
  assert.ok(
    ![...GOOGLE_STAFF_SCOPES, GOOGLE_INVITATION_SCOPE].some((scope) =>
      (GOOGLE_MEET_RECORDING_SCOPES as readonly string[]).includes(scope),
    ),
  );
});
test("discovery reads only the specified space and time window, not account calendars or Drive", async () => {
  const f = fixture();
  assert.deepEqual(await f.provider.conferences("synthetic-token", window), [conference]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].searchParams.get("pageSize"), "100");
  assert.equal(
    f.calls[1].searchParams.get("filter"),
    `space.name = "${conference.space}" AND start_time >= "${window.windowStart}" AND start_time < "${window.windowEnd}"`,
  );
});
test("invalid time windows, meeting codes and path/filter injection never trigger egress", async () => {
  for (const raw of [
    { ...window, meetingCode: 'abc-defg-hij" OR true' },
    { ...window, meetingCode: "https://127.0.0.1" },
    { ...window, windowEnd: window.windowStart },
    { ...window, windowEnd: "2026-11-06T10:00:00Z" },
    { ...window, windowStart: "not-a-date" },
  ]) {
    const f = fixture();
    await assert.rejects(f.provider.conferences("synthetic-token", raw), failure(400));
    assert.equal(f.calls.length, 0);
  }
  for (const name of [
    "conferenceRecords/../secrets",
    "https://attacker.test/recording",
    "conferenceRecords/a?token=private",
  ]) {
    const f = fixture();
    await assert.rejects(f.provider.preview("synthetic-token", window, name), failure(409));
    assert.equal(f.calls.length, 0);
  }
});
test("discovery rejects foreign spaces, wrong windows, duplicate instances and incomplete pagination", async () => {
  for (const body of [
    { conferenceRecords: [{ ...conference, space: "spaces/foreign" }] },
    { conferenceRecords: [{ ...conference, startTime: window.windowEnd }] },
    { conferenceRecords: [{ ...conference, startTime: "2026-11-03T10:01:00Z" }] },
    { conferenceRecords: [{ ...conference, endTime: conference.startTime }] },
    { conferenceRecords: [conference, conference] },
    { conferenceRecords: [conference], nextPageToken: "do-not-silently-truncate" },
  ]) {
    const f = fixture((url) =>
      url.pathname === "/v2/conferenceRecords" ? Response.json(body) : undefined,
    );
    await assert.rejects(
      f.provider.conferences("synthetic-token", window),
      GoogleMeetRecordingError,
    );
  }
});
test("active instances are not represented as completed recordings", async () => {
  const f = fixture((url) =>
    url.pathname === "/v2/conferenceRecords"
      ? Response.json({ conferenceRecords: [{ ...conference, endTime: undefined }] })
      : undefined,
  );
  assert.deepEqual(await f.provider.conferences("synthetic-token", window), []);
});
test("preview pins the actual conference, ready recording and exact Drive object, never playback URLs", async () => {
  const f = fixture();
  const result = await preview(f);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].eligible, true);
  assert.equal(result.files[0].spaceName, conference.space);
  assert.equal(result.files[0].fileId, metadata().id);
  assert.equal(result.files[0].version, "12");
  assert.ok(!JSON.stringify(result).includes("attacker"));
  assert.equal(f.calls.length, 4);
});
test("preview rejects wrong conference identity, recycled space aliases, unfinished instances and foreign recordings", async () => {
  for (const replacement of [
    { ...conference, name: "conferenceRecords/foreign" },
    { ...conference, space: "spaces/foreign" },
    { ...conference, endTime: undefined },
  ]) {
    const f = fixture((url) =>
      url.pathname === `/v2/${conference.name}` ? Response.json(replacement) : undefined,
    );
    await assert.rejects(preview(f), failure(409));
    assert.equal(f.calls.length, 2);
  }
  const f = fixture((url) =>
    url.pathname.endsWith("/recordings")
      ? Response.json({
          recordings: [{ ...recording, name: "conferenceRecords/foreign/recordings/other" }],
        })
      : undefined,
  );
  await assert.rejects(preview(f), failure(409));
});
test("space resolution requires the exact meeting alias returned by Google", async () => {
  const f = fixture(() => Response.json({ name: conference.space, meetingCode: "zzz-zzzz-zzz" }));
  await assert.rejects(preview(f), failure(409));
  assert.equal(f.calls.length, 1);
});
test("not-yet-generated recordings do not read Drive or become importable files", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/recordings")
      ? Response.json({
          recordings: [{ ...recording, state: "ENDED", driveDestination: undefined }],
        })
      : undefined,
  );
  assert.equal((await preview(f)).files.length, 0);
  assert.equal(f.calls.length, 3);
});
test("duplicates, truncated recording lists, missing file IDs and impossible recording timing fail closed", async () => {
  for (const body of [
    { recordings: [recording, recording] },
    { recordings: [recording], nextPageToken: "more" },
    {
      recordings: Array.from({ length: 21 }, (_, i) => ({
        ...recording,
        name: `${conference.name}/recordings/fixture-${i}`,
      })),
    },
    { recordings: [{ ...recording, driveDestination: undefined }] },
    { recordings: [{ ...recording, endTime: recording.startTime }] },
    { recordings: [{ ...recording, startTime: window.windowStart }] },
    { recordings: [{ ...recording, endTime: "2026-11-04T10:04:00Z" }] },
    { recordings: [{ ...recording, driveDestination: { file: "../private" } }] },
  ]) {
    const f = fixture((url) =>
      url.pathname.endsWith("/recordings") ? Response.json(body) : undefined,
    );
    await assert.rejects(preview(f), GoogleMeetRecordingError);
  }
});
test("Drive shortcuts, trashed/inaccessible files, mismatched IDs and incomplete metadata cannot be imported", async () => {
  for (const replacement of [
    { ...metadata(), id: "foreign-file" },
    { ...metadata(), trashed: true },
    { ...metadata(), capabilities: { canDownload: false } },
    { ...metadata(), mimeType: "application/vnd.google-apps.shortcut" },
    { ...metadata(), md5Checksum: undefined },
    { ...metadata(), version: undefined },
    { ...metadata(), size: "0" },
    { ...metadata(), size: "9999999999999999" },
    { ...metadata(), videoMediaMetadata: undefined },
  ]) {
    const f = fixture((url) =>
      url.hostname === "www.googleapis.com" ? Response.json(replacement) : undefined,
    );
    await assert.rejects(preview(f), GoogleMeetRecordingError);
  }
});
test("existing media bounds are explicit preview eligibility, not a paid-access restriction", async () => {
  for (const replacement of [
    { ...metadata(), size: String(MAX_MEETING_BYTES + 1) },
    { ...metadata(), videoMediaMetadata: { durationMillis: "3600001" } },
  ]) {
    const f = fixture((url) =>
      url.hostname === "www.googleapis.com" ? Response.json(replacement) : undefined,
    );
    const selected = (await preview(f)).files[0];
    assert.equal(selected.eligible, false);
    assert.match(selected.unavailableReason!, /100 MB \/ 60-minute/);
    const callsBefore = f.calls.length;
    await assert.rejects(f.provider.download("synthetic-token", selected), failure(409));
    assert.equal(f.calls.length, callsBefore);
  }
});
test("download checks the reviewed revision before and after and verifies full bytes/checksum", async () => {
  const f = fixture();
  const selected = (await preview(f)).files[0];
  const bytes = await f.provider.download("synthetic-token", selected);
  assert.equal(bytes.toString(), "data");
  assert.equal(f.calls.length, 7);
  assert.deepEqual(
    f.calls.slice(4).map((url) => url.searchParams.get("alt")),
    [null, "media", null],
  );
});
test("changed Drive evidence is rejected before media download", async () => {
  for (const patch of [
    { version: "13" },
    { md5Checksum: "0".repeat(32) },
    { size: "5" },
    { modifiedTime: "2026-11-04T10:05:00Z" },
    { videoMediaMetadata: { durationMillis: "60001" } },
  ]) {
    const f = fixture((url, call) =>
      call > 4 && url.hostname === "www.googleapis.com"
        ? Response.json({ ...metadata(), ...patch })
        : undefined,
    );
    const selected = (await preview(f)).files[0];
    await assert.rejects(f.provider.download("synthetic-token", selected), failure(409));
    assert.equal(f.calls.length, 5);
  }
});
test("post-download revision changes and missing permissions discard the result", async () => {
  for (const response of [
    () => Response.json({ ...metadata(), version: "13" }),
    () => new Response("", { status: 403 }),
  ]) {
    const f = fixture((_url, call) => (call === 7 ? response() : undefined));
    const selected = (await preview(f)).files[0];
    await assert.rejects(f.provider.download("synthetic-token", selected), failure(409));
  }
});
test("truncated or same-length wrong content never becomes accepted recording bytes", async () => {
  for (const content of ["dat", "xxxx"]) {
    const f = fixture((url) =>
      url.searchParams.get("alt") === "media" ? new Response(content) : undefined,
    );
    const selected = (await preview(f)).files[0];
    await assert.rejects(f.provider.download("synthetic-token", selected), failure(409));
    assert.equal(f.calls.length, 6);
  }
});
test("media size checks bound both announced and chunked responses", async () => {
  for (const response of [
    () => new Response("data", { headers: { "content-length": String(MAX_MEETING_BYTES + 1) } }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_MEETING_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      ),
  ]) {
    const f = fixture((url) => (url.searchParams.get("alt") === "media" ? response() : undefined));
    const selected = (await preview(f)).files[0];
    await assert.rejects(f.provider.download("synthetic-token", selected), failure(413));
  }
});
test("Google errors, redirects and malformed responses are sanitized without retry", async () => {
  for (const [status, expected] of [
    [401, 409],
    [403, 409],
    [404, 404],
    [429, 503],
    [500, 503],
    [206, 503],
    [302, 503],
  ]) {
    const f = fixture(
      () =>
        new Response("sensitive-provider-body", {
          status,
          headers: { location: "https://attacker.test/redirect" },
        }),
    );
    await assert.rejects(
      preview(f),
      (error: unknown) =>
        failure(expected)(error) &&
        !String(error).includes("sensitive-provider-body") &&
        !String(error).includes("synthetic-token"),
    );
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => new Response("{bad-json"));
  await assert.rejects(preview(f), failure(503));
  assert.equal(f.calls.length, 1);
});
test("transport failures cannot leak provider text or credentials", async () => {
  let calls = 0;
  const provider = googleMeetRecordingsProvider(async () => {
    calls++;
    throw new Error("sensitive synthetic-token");
  });
  await assert.rejects(
    provider.preview("synthetic-token", window, conference.name),
    (error: unknown) => failure(503)(error) && !String(error).includes("synthetic-token"),
  );
  assert.equal(calls, 1);
});
test("preview fingerprint pins conference, space, file revision and content evidence", async () => {
  const selected = (await preview(fixture())).files[0];
  const hash = meetRecordingFingerprint(selected);
  assert.equal(hash, meetRecordingFingerprint({ ...selected }));
  for (const patch of [
    { spaceName: "spaces/other" },
    { conferenceName: "conferenceRecords/other" },
    { fileId: "other-file" },
    { version: "13" },
    { md5Checksum: "0".repeat(32) },
    { start: window.windowStart },
    { durationMillis: 60001 },
  ])
    assert.notEqual(hash, meetRecordingFingerprint({ ...selected, ...patch }));
});
