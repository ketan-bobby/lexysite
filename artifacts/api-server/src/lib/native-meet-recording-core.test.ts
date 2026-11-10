import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeMeetRecordings, type NativeMeetContext } from "./native-meet-recording-core";
import type { MeetRecordingFile } from "./google-meet-recordings-provider";
import { GoogleMeetRecordingError } from "./google-meet-recordings-provider";
import {
  readMeetRecordingReview,
  signMeetRecordingReview,
  meetRecordingSourceKey,
} from "./native-meet-recording-review";
import { nativeZoomImportInput, readRecordingReview } from "./native-recording-review";
import { digest } from "./google-staff-config";

process.env.SESSION_SECRET = "synthetic-native-meet-core-key-only";
const scope = {
  actorId: "staff-fixture",
  tenantId: "employer-fixture",
  jobId: "job-fixture",
  candidateId: "candidate-fixture",
};
const file: MeetRecordingFile = {
  name: "conferenceRecords/conf1/recordings/rec1",
  conferenceName: "conferenceRecords/conf1",
  spaceName: "spaces/space1",
  fileId: "drive-fixture",
  start: "2035-01-01T10:00:00Z",
  end: "2035-01-01T10:05:00Z",
  bytes: 128,
  durationMillis: 300_000,
  version: "1",
  md5Checksum: "0".repeat(32),
  modifiedTime: "2035-01-01T11:00:00Z",
  eligible: true,
  unavailableReason: null,
};
function fixture() {
  let context: NativeMeetContext = {
    scheduleId: "schedule-fixture",
    binding: "binding-fixture",
    accountRevision: "revision-fixture",
    subjectHash: digest("subject-fixture"),
    window: {
      meetingCode: "abc-defg-hij",
      windowStart: "2035-01-01T09:30:00Z",
      windowEnd: "2035-01-01T11:00:00Z",
    },
  };
  let selected = structuredClone(file),
    subject = "subject-fixture",
    active = true,
    exists = false;
  let instant = Date.parse("2035-01-01T12:00:00Z");
  let afterPreview = async () => {},
    afterDownload = async () => {},
    beforePersist = async () => {};
  let malformed = false;
  const calls = {
    context: 0,
    access: 0,
    conferences: 0,
    preview: 0,
    download: 0,
    validated: 0,
    saved: 0,
    cleaned: 0,
  };
  const saved = { id: "private-note-fixture" };
  const service = nativeMeetRecordings({
    now: () => instant,
    context: async (current, scheduleId) => {
      calls.context++;
      assert.deepEqual(current, scope);
      assert.equal(scheduleId, context.scheduleId);
      if (!active) throw new GoogleMeetRecordingError(403, "Access revoked.");
      return structuredClone(context);
    },
    access: async () => {
      calls.access++;
      return { accessToken: "synthetic-token", subject };
    },
    existing: async () => (exists ? saved : undefined),
    provider: {
      conferences: async () => {
        calls.conferences++;
        await afterPreview();
        return [
          {
            name: file.conferenceName,
            space: file.spaceName,
            startTime: file.start,
            endTime: file.end,
          },
        ];
      },
      preview: async (_token, _window, name) => {
        calls.preview++;
        assert.equal(name, file.conferenceName);
        const preview = {
          conference: { name, space: selected.spaceName, startTime: file.start, endTime: file.end },
          files: [structuredClone(selected)],
        };
        await afterPreview();
        return preview;
      },
      download: async () => {
        calls.download++;
        await afterDownload();
        return Buffer.alloc(128);
      },
    },
    validateMedia: async () => {
      calls.validated++;
      if (malformed) throw new Error("Invalid MP4");
    },
    save: async (_scope, _input, _bytes, _file, _key, recheck) => {
      await beforePersist();
      try {
        await recheck();
      } catch (error) {
        calls.cleaned++;
        throw error;
      }
      calls.saved++;
      exists = true;
      return saved;
    },
  });
  const preview = () => service.preview(scope, context.scheduleId, file.conferenceName);
  const input = async () => ({
    reviewToken: (await preview()).files[0]!.reviewToken!,
    consent: true as const,
    title: "Synthetic consented interview",
    language: "en",
    consentStatement: "All participants agreed; I verified this exact interview source.",
    plannedQuestions: "",
  });
  return {
    service,
    calls,
    preview,
    input,
    saved,
    change: (patch: Partial<NativeMeetContext>) => {
      context = { ...context, ...patch };
    },
    changeFile: (patch: Partial<MeetRecordingFile>) => {
      selected = { ...selected, ...patch };
    },
    wrongSubject: () => {
      subject = "another-google-subject";
    },
    revoke: () => {
      active = false;
    },
    expire: () => {
      instant += 600_001;
    },
    afterPreview: (fn: () => Promise<void>) => {
      afterPreview = fn;
    },
    afterDownload: (fn: () => Promise<void>) => {
      afterDownload = fn;
    },
    beforePersist: (fn: () => Promise<void>) => {
      beforePersist = fn;
    },
    malformed: () => {
      malformed = true;
    },
  };
}
test("preview is metadata-only, signs exact canonical space/instance/file, and imports one private source", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.conferences(scope, "schedule-fixture"), [
    { name: file.conferenceName, start: file.start, end: file.end },
  ]);
  const input = await f.input();
  assert.equal(f.calls.download, 0);
  const claims = readMeetRecordingReview(input.reviewToken, Date.parse("2035-01-01T12:00:00Z"));
  assert.equal(claims.spaceName, file.spaceName);
  assert.equal(claims.conferenceName, file.conferenceName);
  assert.equal(claims.fileId, file.fileId);
  assert.ok(!input.reviewToken.includes("synthetic-token"));
  assert.deepEqual(await f.service.import(scope, input), f.saved);
  assert.equal(f.calls.saved, 1);
  assert.equal(f.calls.validated, 1);
  assert.equal(f.calls.download, 1);
  await f.service.import(scope, input);
  assert.equal(f.calls.download, 1);
  assert.equal(f.calls.saved, 1);
});
test("recording reviews cannot cross provider-purpose, actor, employer, job or candidate", async () => {
  const f = fixture(),
    input = await f.input();
  assert.throws(() => readRecordingReview(input.reviewToken, Date.parse("2035-01-01T12:00:00Z")));
  for (const property of ["actorId", "tenantId", "jobId", "candidateId"] as const) {
    const before = f.calls.context;
    await assert.rejects(f.service.import({ ...scope, [property]: "foreign" }, input));
    assert.equal(f.calls.context, before);
  }
  assert.equal(f.calls.download, 0);
});
test("changed appointment, recording grant, receipt or subject invalidates the reviewed source", async () => {
  for (const patch of [
    { binding: "changed-receipt" },
    { accountRevision: "new-account-revision" },
    { subjectHash: digest("another-subject") },
  ]) {
    const f = fixture(),
      input = await f.input();
    f.change(patch);
    await assert.rejects(f.service.import(scope, input));
    assert.equal(f.calls.download, 0);
  }
  const f = fixture();
  f.wrongSubject();
  await assert.rejects(f.preview());
  assert.equal(f.calls.preview, 0);
});
test("canonical alias change, recording replacement or lost eligibility prevents download", async () => {
  for (const patch of [
    { spaceName: "spaces/recycled" },
    { version: "2" },
    { bytes: 129 },
    { eligible: false },
    { md5Checksum: "f".repeat(32) },
  ]) {
    const f = fixture(),
      input = await f.input();
    f.changeFile(patch);
    await assert.rejects(f.service.import(scope, input));
    assert.equal(f.calls.download, 0);
  }
});
test("authority changes during discovery/preview discard private provider results", async () => {
  for (const operation of ["conferences", "preview"]) {
    const f = fixture();
    f.afterPreview(async () => f.revoke());
    await assert.rejects(
      operation === "conferences" ? f.service.conferences(scope, "schedule-fixture") : f.preview(),
    );
    assert.equal(f.calls.download, 0);
  }
});
test("revocation after download or while persisting prevents durable source publication", async () => {
  const f = fixture(),
    input = await f.input();
  f.afterDownload(async () => f.revoke());
  await assert.rejects(f.service.import(scope, input));
  assert.equal(f.calls.saved, 0);
  const g = fixture(),
    other = await g.input();
  g.beforePersist(async () => g.revoke());
  await assert.rejects(g.service.import(scope, other));
  assert.equal(g.calls.saved, 0);
  assert.equal(g.calls.cleaned, 1);
});
test("expired/altered tokens, missing consent and malformed media cannot save", async () => {
  const f = fixture(),
    input = await f.input();
  f.expire();
  await assert.rejects(f.service.import(scope, input));
  assert.equal(f.calls.download, 0);
  const g = fixture(),
    valid = await g.input();
  await assert.rejects(
    g.service.import(scope, { ...valid, reviewToken: valid.reviewToken + ".tampered" }),
  );
  await assert.rejects(g.service.import(scope, { ...valid, consent: false as unknown as true }));
  await assert.rejects(g.service.import(scope, { ...valid, consentStatement: "yes" }));
  assert.equal(g.calls.download, 0);
  g.malformed();
  await assert.rejects(g.service.import(scope, valid));
  assert.equal(g.calls.saved, 0);
});
test("ineligible preview files cannot receive review tokens", async () => {
  const f = fixture();
  f.changeFile({ eligible: false, unavailableReason: "Too large" });
  assert.equal((await f.preview()).files[0]!.reviewToken, null);
});
test("source identity is provider-separated and stable across reconnects without bypassing current authority", async () => {
  const f = fixture(),
    input = await f.input();
  const claims = readMeetRecordingReview(input.reviewToken, Date.parse("2035-01-01T12:00:00Z"));
  assert.equal(
    meetRecordingSourceKey(claims),
    meetRecordingSourceKey({ ...claims, accountRevision: "new-grant" }),
  );
  assert.notEqual(
    meetRecordingSourceKey(claims),
    meetRecordingSourceKey({ ...claims, conferenceName: "conferenceRecords/other" }),
  );
  await f.service.import(scope, input);
  f.revoke();
  await assert.rejects(f.service.import(scope, input));
});
test("import parsing keeps consent literal, source token required and identity fields server-owned", () => {
  const valid = {
    reviewToken: "fixture",
    title: "Interview",
    consent: true,
    consentStatement: "All participants gave consent.",
  };
  assert.equal(nativeZoomImportInput.safeParse(valid).success, true);
  for (const patch of [
    { consent: false },
    { fileId: "arbitrary" },
    { reviewToken: "" },
    { tenantId: "foreign" },
    { downloadUrl: "https://example.invalid" },
  ])
    assert.equal(nativeZoomImportInput.safeParse({ ...valid, ...patch }).success, false);
});
test("a different signing secret, malformed signature and overlong lifetime fail closed", async () => {
  const f = fixture(),
    input = await f.input(),
    now = Date.parse("2035-01-01T12:00:00Z");
  const claims = readMeetRecordingReview(input.reviewToken, now);
  assert.throws(() => readMeetRecordingReview(signMeetRecordingReview(claims, "different"), now));
  assert.throws(() =>
    readMeetRecordingReview(signMeetRecordingReview({ ...claims, expires: now + 700_000 }), now),
  );
});
