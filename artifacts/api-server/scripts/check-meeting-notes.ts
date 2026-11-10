/** Opt-in development HTTP/storage/processing integration fixture. No provider I/O. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { mock } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { benchmarkScopedReads } from "./meeting-notes-read-benchmark";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  meetingNotesTable,
  interviewSchedulesTable,
  interviewZoomMeetingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { setupMeetImportFixture, checkMeetImportFixture } from "./meeting-notes-meet-fixture";
import { issueToken } from "../src/lib/auth-token";
import {
  meetingProcessingInput,
  meetingSpeakerReviewInput,
  meetingSpeakerLabels,
  MeetingSpeakerReviewError,
} from "../src/lib/meeting-speakers";

assert.notEqual(process.env.NODE_ENV, "production");
const target = await pool.query(
  "SELECT md5(current_database() || ':' || coalesce(inet_server_addr()::text,'local')) AS hash",
);
assert.ok(
  process.env.MEETING_NOTES_TEST_DB_CONFIRM,
  "Explicit development target confirmation required.",
);
assert.equal(
  target.rows[0].hash,
  process.env.MEETING_NOTES_TEST_DB_CONFIRM,
  "Target does not match confirmed development database.",
);
const objects = new Map<string, Buffer>();
const nativeBytes = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypM4A "),
  Buffer.alloc(48),
]);
let nativeLists = 0,
  nativeDownloads = 0,
  nativeSizeDrift = 0;
let nativeDownloadHook: (() => Promise<void>) | null = null;
const nativeAccountRevision = randomUUID();
const { NativeRecordingError, boundedRecordingBody } =
  await import("../src/lib/zoom-recordings-provider");
mock.module("../src/lib/zoom-staff-account.ts", {
  namedExports: {
    zoomStaffActor: async (id: string) => ({ id, tenantId: tenant! }),
    zoomStaffAccountService: () => ({
      status: async () => ({ configured: true, connected: true, revision: nativeAccountRevision }),
      access: async () => ({ accessToken: "synthetic-native-token", zoomUserId: "synthetic-host" }),
    }),
  },
});
mock.module("../src/lib/zoom-recordings-provider.ts", {
  namedExports: {
    NativeRecordingError,
    boundedRecordingBody,
    zoomRecordingsProvider: () => ({
      list: async (_token: string, identity: string, meetingId: string, hostId: string) => {
        nativeLists++;
        assert.ok(["12345678901", "synthetic-instance=="].includes(identity));
        assert.equal(meetingId, "12345678901");
        assert.equal(hostId, "synthetic-host");
        return {
          meetingId,
          uuid: "synthetic-instance==",
          hostId,
          recordedAt: "2026-11-04T10:00:00Z",
          files: [
            {
              id: "synthetic-file",
              format: "M4A",
              kind: "audio_only",
              bytes: nativeBytes.length + nativeSizeDrift,
              start: "2026-11-04T10:00:00Z",
              end: "2026-11-04T10:01:00Z",
              downloadUrl: "https://zoom.us/rec/download/synthetic-only",
              eligible: true,
              unavailableReason: null,
            },
          ],
        };
      },
      download: async () => {
        nativeDownloads++;
        await nativeDownloadHook?.();
        return nativeBytes;
      },
    }),
  },
});
let transcribes = 0;
let summaries = 0;
let speakerAvailable = true;
let speakerFailure = false;
let speakerCalls = 0;
let hold: Promise<void> | null = null;
let entered: (() => void) | null = null;
mock.module("../src/lib/objectStorage.ts", {
  namedExports: {
    ObjectStorageService: class {
      async uploadFile(path: string, size: number, type: string, folder: string) {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const bytes = await readFile(path);
        assert.equal(bytes.length, size);
        return this.uploadBuffer(bytes, type, folder);
      }
      async uploadBuffer(buffer: Buffer, _type: string, folder: string) {
        const path = `/objects/${folder}/${randomUUID()}`;
        objects.set(path, buffer);
        return path;
      }
      async getObjectEntityFile(path: string) {
        return path;
      }
      async downloadObject(path: string) {
        assert.ok(objects.has(path));
        return new Response(new Uint8Array(objects.get(path)!));
      }
      async deleteObjectByPath(path: string) {
        objects.delete(path);
        return { ok: true };
      }
    },
  },
});
mock.module("../src/lib/meeting-notes-media.ts", {
  namedExports: {
    withMeetingAudio: async (
      _bytes: Buffer,
      run: (paths: string[], read: () => Promise<Buffer>) => Promise<string>,
    ) => run(["fixture"], async () => Buffer.from("fixture speech")),
  },
});
mock.module("../src/lib/transcribe.ts", {
  namedExports: {
    DEEPGRAM_STT_MODEL: "nova-2",
    deepgramConfigured: () => speakerAvailable,
    deepgramLanguageFor: (language: string) => (language === "ar" ? undefined : "en"),
    transcribeAudio: async () => {
      transcribes++;
      entered?.();
      await hold;
      return {
        transcript: "We discussed how to test an API and record unresolved questions.",
        provider: "fixture",
      };
    },
  },
});
mock.module("../src/lib/meeting-speakers.ts", {
  namedExports: {
    meetingProcessingInput,
    meetingSpeakerReviewInput,
    meetingSpeakerLabels,
    MeetingSpeakerReviewError,
    transcribeMeetingSpeakers: async () => {
      speakerCalls++;
      if (speakerFailure) throw new Error("Synthetic provider refusal");
      return {
        transcript: "Synthetic interviewer prompt.\n\nSynthetic candidate response.",
        evidence: {
          revision: randomUUID(),
          generatedAt: new Date().toISOString(),
          provider: "deepgram",
          model: "nova-2",
          diarizerModel: "v1",
          diarizerBuild: "11111111-1111-4111-8111-111111111111",
          segments: [
            { speaker: 0, start: 0, end: 1, text: "Synthetic interviewer prompt." },
            { speaker: 1, start: 1, end: 2, text: "Synthetic candidate response." },
          ],
        },
      };
    },
  },
});
mock.module("../src/lib/ai.ts", {
  namedExports: {
    generateWithAI: async (_prompt: string, system: string) => {
      summaries++;
      assert.match(system, /Do not score/);
      return "Draft: API testing was discussed. Unresolved questions remain.";
    },
  },
});
const meetFingerprint = await setupMeetImportFixture();
const { default: router } = await import("../src/routes/meeting-notes");
const { isCandidateErased } = await import("../src/lib/candidate-erasure-barrier");
const ids = Array.from({ length: 12 }, () => randomUUID());
const [
  tenant,
  foreignTenant,
  admin,
  candidateUser,
  recruiter,
  job,
  otherJob,
  foreignJob,
  candidate,
  otherCandidate,
] = ids as string[];
let server: Server | undefined;
let origin = "";
const token = (id = admin!) =>
  issueToken({
    userId: id,
    role: id === candidateUser ? "candidate" : id === recruiter ? "recruiter" : "tenant_admin",
    tenantId: tenant!,
  });
const base = `/jobs/${job}/candidates/${candidate}/meeting-notes`;
const nativeSchedule = randomUUID(),
  nativeOtherSchedule = randomUUID(),
  nativeApp = randomUUID();
let checks = 0;
function pass() {
  checks++;
}
async function request(
  path: string,
  method = "GET",
  body?: BodyInit,
  actor = admin!,
  signal?: AbortSignal,
) {
  const headers: Record<string, string> = actor ? { Authorization: `Bearer ${token(actor)}` } : {};
  if (typeof body === "string") headers["Content-Type"] = "application/json";
  return fetch(origin + path, { method, headers, body, signal });
}
function upload(consent = true, extra = false) {
  const form = new FormData();
  form.set("file", new Blob(["RIFF1234WAVEfixture-audio"], { type: "audio/wav" }), "fixture.wav");
  form.set("title", "Synthetic human interview");
  form.set("language", "en");
  form.set("consent", String(consent));
  form.set(
    "consentStatement",
    "All participants explicitly consented to recording and AI processing.",
  );
  form.set("plannedQuestions", "How do you test an API?");
  if (extra) form.set("objectPath", "/objects/foreign");
  return form;
}
async function poll(id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(`${base}/${id}`);
    const body = await response.json();
    if (body.status === status) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not reach ${status}`);
}
try {
  const barriers = await pool.query(`
    SELECT t.tgname, t.tgtype, t.tgenabled, encode(t.tgargs, 'hex') AS args_hex,
      p.proname, pn.nspname AS function_schema
    FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid
    JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname='public' AND c.relname='meeting_notes' AND NOT t.tgisinternal
  `);
  const sharedBarrier = barriers.rows.find((row) => row.tgname === "lexy_erasure_write_barrier");
  assert.ok(sharedBarrier, "Apply meeting-notes shared-erasure migration before testing.");
  assert.equal(sharedBarrier.tgtype, 23); // BEFORE INSERT OR UPDATE, FOR EACH ROW.
  assert.equal(sharedBarrier.tgenabled, "O");
  assert.equal(sharedBarrier.proname, "lexy_erasure_write_barrier");
  assert.equal(sharedBarrier.function_schema, "public");
  assert.equal(sharedBarrier.args_hex, Buffer.from("candidate_id\0").toString("hex"));
  assert.ok(
    barriers.rows.some(
      (row) =>
        row.tgname === "meeting_notes_live_candidate" &&
        row.proname === "lexy_meeting_notes_live_candidate" &&
        row.tgenabled === "O" &&
        row.tgtype === 23,
    ),
    "The original recording-specific candidate-lock guard must remain enabled.",
  );
  pass();
  await dbAdmin.insert(tenantsTable).values([
    { id: tenant!, name: "Meeting fixture", slug: tenant!, plan: "enterprise" },
    { id: foreignTenant!, name: "Foreign fixture", slug: foreignTenant!, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: admin!,
      tenantId: tenant!,
      email: `${admin}@example.test`,
      name: "Fixture admin",
      role: "tenant_admin",
      status: "active",
      passwordHash: "fixture",
    },
    {
      id: candidateUser!,
      tenantId: tenant!,
      email: `${candidateUser}@example.test`,
      name: "Fixture candidate",
      role: "candidate",
      status: "active",
      passwordHash: "fixture",
    },
    {
      id: recruiter!,
      tenantId: tenant!,
      email: `${recruiter}@example.test`,
      name: "Unassigned recruiter",
      role: "recruiter",
      status: "active",
      passwordHash: "fixture",
    },
  ]);
  await dbAdmin.insert(jobsTable).values([
    {
      id: job!,
      tenantId: tenant!,
      title: "Fixture role",
      description: "Fixture",
      status: "active",
    },
    {
      id: otherJob!,
      tenantId: tenant!,
      title: "Other role",
      description: "Fixture",
      status: "active",
    },
    {
      id: foreignJob!,
      tenantId: foreignTenant!,
      title: "Foreign role",
      description: "Fixture",
      status: "active",
    },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    {
      id: candidate!,
      tenantId: tenant!,
      firstName: "Synthetic",
      lastName: "Meeting",
      email: `${candidate}@example.test`,
    },
    {
      id: otherCandidate!,
      tenantId: foreignTenant!,
      firstName: "Foreign",
      lastName: "Meeting",
      email: `${otherCandidate}@example.test`,
    },
  ]);
  await dbAdmin.insert(applicationsTable).values([
    { id: nativeApp, tenantId: tenant!, candidateId: candidate!, jobId: job! },
    {
      id: randomUUID(),
      tenantId: foreignTenant!,
      candidateId: otherCandidate!,
      jobId: foreignJob!,
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(
    (
      error: { status?: number; statusCode?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(error.statusCode ?? error.status ?? 500)
        .json({ error: "Fixture request rejected" });
    },
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.on("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  // Real scoped routes / real development DB, but no Zoom, storage, media or AI egress.
  await dbAdmin.insert(interviewSchedulesTable).values([
    {
      id: nativeSchedule,
      tenantId: tenant!,
      applicationId: nativeApp,
      scheduledAt: new Date("2026-11-04T10:00:00Z"),
      type: "video",
    },
    {
      id: nativeOtherSchedule,
      tenantId: tenant!,
      applicationId: nativeApp,
      scheduledAt: new Date("2026-11-04T11:00:00Z"),
      type: "video",
    },
  ]);
  await dbAdmin.insert(interviewZoomMeetingsTable).values(
    [nativeSchedule, nativeOtherSchedule].map((id, index) => ({
      scheduleId: id,
      tenantId: tenant!,
      candidateId: candidate!,
      hostUserId: index ? recruiter! : admin!,
      hostZoomId: "synthetic-host",
      operationId: randomUUID(),
      status: "confirmed",
      action: "create",
      meetingId: "12345678901",
      joinUrl: "https://zoom.us/j/12345678901",
      snapshotHash: "a".repeat(64),
      approvedAt: new Date(),
      acceptedAt: new Date(),
    })),
  );
  const nativeBase = `${base}/native-zoom`;
  assert.equal((await request(`${nativeBase}/appointments`, "GET", undefined, "")).status, 401);
  assert.ok(
    [401, 403].includes(
      (await request(`${nativeBase}/appointments`, "GET", undefined, candidateUser!)).status,
    ),
  );
  assert.equal(
    (await request(`${nativeBase}/appointments`, "GET", undefined, recruiter!)).status,
    404,
  );
  assert.equal(nativeLists, 0);
  assert.equal(nativeDownloads, 0);
  pass();
  const appointments = await (await request(`${nativeBase}/appointments`)).json();
  assert.deepEqual(
    appointments.map((row: { scheduleId: string }) => row.scheduleId),
    [nativeSchedule],
  );
  assert.equal(nativeLists, 0);
  pass();
  assert.equal(
    (
      await request(
        `${nativeBase}/preview`,
        "POST",
        JSON.stringify({ scheduleId: nativeOtherSchedule }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/jobs/${foreignJob}/candidates/${otherCandidate}/meeting-notes/native-zoom/preview`,
        "POST",
        JSON.stringify({ scheduleId: nativeSchedule }),
      )
    ).status,
    404,
  );
  assert.equal(nativeLists, 0);
  pass();
  const nativePreview = async () => {
    const response = await request(
      `${nativeBase}/preview`,
      "POST",
      JSON.stringify({ scheduleId: nativeSchedule }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes("downloadUrl"));
    assert.ok(!JSON.stringify(body).includes("https://"));
    assert.ok(body.files[0].reviewToken);
    return body.files[0].reviewToken as string;
  };
  let sourceReview = await nativePreview();
  assert.equal(nativeLists, 1);
  assert.equal(nativeDownloads, 0);
  pass();
  const nativeInput = (reviewToken = sourceReview) => ({
    reviewToken,
    title: "Synthetic native recording",
    language: "en",
    plannedQuestions: "",
    consent: true,
    consentStatement:
      "All participants consented; staff confirmed the right candidate and recording instance.",
  });
  assert.equal(
    (
      await request(
        `${nativeBase}/import`,
        "POST",
        JSON.stringify({ ...nativeInput(), consent: false }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `${nativeBase}/import`,
        "POST",
        JSON.stringify({ ...nativeInput(), downloadUrl: "https://zoom.us/rec/attacker" }),
      )
    ).status,
    400,
  );
  assert.equal(nativeDownloads, 0);
  pass();
  const imported = await request(`${nativeBase}/import`, "POST", JSON.stringify(nativeInput()));
  assert.equal(imported.status, 201);
  const nativeNote = await imported.json();
  assert.equal(nativeNote.status, "uploaded");
  assert.equal(nativeNote.transcript, null);
  assert.equal(nativeNote.nativeSource.provider, "zoom");
  assert.ok(!("objectPath" in nativeNote));
  assert.ok(!("sourceKey" in nativeNote));
  assert.equal(transcribes, 0);
  assert.equal(summaries, 0);
  assert.equal(nativeDownloads, 1);
  pass();
  const duplicate = await (
    await request(`${nativeBase}/import`, "POST", JSON.stringify(nativeInput()))
  ).json();
  assert.equal(duplicate.id, nativeNote.id);
  assert.equal(nativeDownloads, 1);
  assert.equal(nativeLists, 2);
  pass();
  await dbAdmin
    .update(interviewSchedulesTable)
    .set({ notes: "Staff changed this appointment" })
    .where(eq(interviewSchedulesTable.id, nativeSchedule));
  assert.equal(
    (await request(`${nativeBase}/import`, "POST", JSON.stringify(nativeInput()))).status,
    409,
  );
  assert.equal(nativeDownloads, 1);
  pass();
  assert.equal((await request(`${base}/${nativeNote.id}`, "DELETE")).status, 204);
  assert.equal(objects.size, 0);
  checks += await checkMeetImportFixture({
    tenant: tenant!,
    actor: admin!,
    job: job!,
    candidate: candidate!,
    application: nativeApp,
    candidateActor: candidateUser!,
    unassignedActor: recruiter!,
    fingerprint: meetFingerprint,
    request,
  });
  assert.equal(objects.size, 0);
  sourceReview = await nativePreview();
  nativeSizeDrift = 1;
  assert.equal(
    (await request(`${nativeBase}/import`, "POST", JSON.stringify(nativeInput()))).status,
    409,
  );
  assert.equal(nativeDownloads, 1);
  assert.equal(objects.size, 0);
  nativeSizeDrift = 0;
  pass();
  sourceReview = await nativePreview();
  nativeDownloadHook = async () => {
    await dbAdmin
      .update(interviewSchedulesTable)
      .set({ notes: "Changed during recording download" })
      .where(eq(interviewSchedulesTable.id, nativeSchedule));
  };
  assert.equal(
    (await request(`${nativeBase}/import`, "POST", JSON.stringify(nativeInput()))).status,
    409,
  );
  assert.equal(objects.size, 0);
  nativeDownloadHook = null;
  pass();
  sourceReview = await nativePreview();
  const concurrent = await Promise.all(
    [1, 2].map(() => request(`${nativeBase}/import`, "POST", JSON.stringify(nativeInput()))),
  );
  assert.ok(concurrent.every((response) => response.status === 201));
  const copies = await Promise.all(concurrent.map((response) => response.json()));
  assert.equal(copies[0].id, copies[1].id);
  assert.equal(objects.size, 1);
  assert.equal(transcribes, 0);
  assert.equal(summaries, 0);
  pass();
  assert.equal((await request(`${base}/${copies[0].id}`, "DELETE")).status, 204);
  await dbAdmin
    .delete(interviewZoomMeetingsTable)
    .where(eq(interviewZoomMeetingsTable.tenantId, tenant!));
  await dbAdmin
    .delete(interviewSchedulesTable)
    .where(eq(interviewSchedulesTable.tenantId, tenant!));
  assert.equal(objects.size, 0);
  assert.equal((await request(base, "GET", undefined, "")).status, 401);
  pass();
  assert.ok([401, 403].includes((await request(base, "GET", undefined, candidateUser!)).status));
  pass();
  assert.equal((await request(base, "GET", undefined, recruiter!)).status, 404);
  pass();
  assert.equal(
    (await request(`/jobs/${foreignJob}/candidates/${otherCandidate}/meeting-notes`)).status,
    404,
  );
  pass();
  assert.equal(
    (await request(`/jobs/${otherJob}/candidates/${candidate}/meeting-notes`)).status,
    404,
  );
  pass();
  assert.equal((await request(base, "POST", upload(false))).status, 400);
  pass();
  assert.equal((await request(base, "POST", upload(true, true))).status, 400);
  pass();
  const created = await request(base, "POST", upload());
  assert.equal(created.status, 201);
  const note = await created.json();
  assert.equal(note.status, "uploaded");
  assert.equal(transcribes, 0);
  assert.equal(summaries, 0);
  assert.equal("objectPath" in note, false);
  assert.equal("processingToken" in note, false);
  pass();
  assert.equal(
    (await request(`/jobs/${otherJob}/candidates/${candidate}/meeting-notes/${note.id}`)).status,
    404,
  );
  pass();
  const recording = await request(`${base}/${note.id}/recording`);
  assert.equal(recording.status, 200);
  assert.match(recording.headers.get("content-disposition")!, /^attachment/);
  assert.equal(recording.headers.get("cache-control"), "no-store");
  pass();
  const exportPath = `${base}/${note.id}/notes-export`;
  assert.equal((await request(exportPath)).status, 409);
  pass();
  assert.equal((await request(exportPath, "GET", undefined, "")).status, 401);
  assert.ok(
    [401, 403].includes((await request(exportPath, "GET", undefined, candidateUser!)).status),
  );
  assert.equal((await request(exportPath, "GET", undefined, recruiter!)).status, 404);
  pass();
  assert.equal(
    (
      await request(
        `/jobs/${foreignJob}/candidates/${otherCandidate}/meeting-notes/${note.id}/notes-export`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/jobs/${otherJob}/candidates/${candidate}/meeting-notes/${note.id}/notes-export`,
      )
    ).status,
    404,
  );
  assert.equal((await request(`${base}/missing/notes-export`)).status, 404);
  pass();
  assert.equal((await request(`${base}/${note.id}/process`, "POST", "{}")).status, 202);
  const completed = await poll(note.id, "completed");
  assert.match(completed.transcript, /test an API/);
  assert.match(completed.summary, /^Draft/);
  assert.equal(transcribes, 1);
  assert.equal(summaries, 1);
  pass();
  if (process.argv.includes("--benchmark-reads")) {
    const effectsBefore = {
      transcribes,
      summaries,
      nativeLists,
      nativeDownloads,
      objects: objects.size,
    };
    for (const scenario of [
      { name: "owned-note", path: `${base}/${note.id}`, actor: admin!, statuses: [200] },
      {
        name: "foreign-scope",
        path: `/jobs/${foreignJob}/candidates/${otherCandidate}/meeting-notes/${note.id}`,
        actor: admin!,
        statuses: [404],
      },
      {
        name: "candidate-denied",
        path: `${base}/${note.id}`,
        actor: candidateUser!,
        statuses: [401, 403],
      },
      { name: "unsigned-denied", path: `${base}/${note.id}`, actor: "", statuses: [401] },
    ]) {
      const observedHttpStatuses: Record<number, number> = {};
      const result = await benchmarkScopedReads({
        scenario: scenario.name,
        samples: 20,
        concurrency: 4,
        readAndVerify: async (signal) => {
          const response = await request(scenario.path, "GET", undefined, scenario.actor, signal);
          assert.ok(scenario.statuses.includes(response.status));
          observedHttpStatuses[response.status] = (observedHttpStatuses[response.status] ?? 0) + 1;
          const body = await response.json();
          if (scenario.statuses.includes(200)) {
            assert.equal(body.id, note.id);
            assert.equal(body.transcript, completed.transcript);
            assert.equal(body.summary, completed.summary);
          } else {
            assert.equal(body.transcript, undefined);
            assert.equal(body.summary, undefined);
            assert.equal(JSON.stringify(body).includes(completed.transcript), false);
          }
        },
      });
      process.stdout.write(
        `BENCHMARK ${JSON.stringify({
          ...result,
          expectedHttpStatuses: scenario.statuses,
          observedHttpStatuses,
        })}\n`,
      );
    }
    assert.deepEqual(
      { transcribes, summaries, nativeLists, nativeDownloads, objects: objects.size },
      effectsBefore,
    );
    pass();
  }
  await dbAdmin
    .update(meetingNotesTable)
    .set({ error: "Deletion pending. Synthetic storage failure." })
    .where(eq(meetingNotesTable.id, note.id));
  assert.equal((await request(exportPath)).status, 409);
  await dbAdmin
    .update(meetingNotesTable)
    .set({ error: null })
    .where(eq(meetingNotesTable.id, note.id));
  pass();
  assert.equal((await request(`${base}/${note.id}/process`, "POST", "{}")).status, 409);
  pass();
  const reviewPath = `${base}/${note.id}/question-review`;
  // The opt-in path is isolated from the established default transcription route.
  assert.equal(completed.speakerEvidence, null);
  const speakerNote = await (await request(base, "POST", upload())).json();
  assert.equal(
    (await request(`${base}/${speakerNote.id}/process`, "POST", '{"separateSpeakers":"true"}'))
      .status,
    400,
  );
  pass();
  speakerAvailable = false;
  assert.equal(
    (await request(`${base}/${speakerNote.id}/process`, "POST", '{"separateSpeakers":true}'))
      .status,
    422,
  );
  assert.equal((await (await request(`${base}/${speakerNote.id}`)).json()).status, "uploaded");
  assert.equal(speakerCalls, 0);
  speakerAvailable = true;
  pass();
  const beforeStandardCalls = transcribes;
  assert.equal(
    (await request(`${base}/${speakerNote.id}/process`, "POST", '{"separateSpeakers":true}'))
      .status,
    202,
  );
  const separated = await poll(speakerNote.id, "completed");
  assert.equal(separated.speakerEvidence.segments.length, 2);
  assert.equal(separated.speakerEvidence.provider, "deepgram");
  assert.equal(
    separated.transcript,
    separated.speakerEvidence.segments.map((item: { text: string }) => item.text).join("\n\n"),
  );
  assert.equal(transcribes, beforeStandardCalls);
  assert.equal(speakerCalls, 1);
  pass();
  assert.equal(
    (await request(`/jobs/${otherJob}/candidates/${candidate}/meeting-notes/${speakerNote.id}`))
      .status,
    404,
  );
  assert.ok(
    [401, 403].includes(
      (await request(`${base}/${speakerNote.id}`, "GET", undefined, candidateUser!)).status,
    ),
  );
  pass();
  const speakerReviewPath = `${base}/${speakerNote.id}/speaker-review`;
  const speakerReviewInput = {
    sourceRevision: separated.speakerEvidence.revision,
    previousRevision: null,
    confirm: true,
    labels: [{ speaker: 1, label: "Staff-reviewed applicant", role: "candidate" }],
  };
  const countsBeforeLabels = { transcribes, summaries, speakerCalls };
  for (const confirm of [false, "true", undefined]) {
    assert.equal(
      (await request(speakerReviewPath, "PUT", JSON.stringify({ ...speakerReviewInput, confirm })))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await request(
        speakerReviewPath,
        "PUT",
        JSON.stringify({ ...speakerReviewInput, reviewedBy: recruiter }),
      )
    ).status,
    400,
  );
  pass();
  for (const labels of [
    [{ speaker: 99, label: "Invented voice", role: "unknown" }],
    [...speakerReviewInput.labels, ...speakerReviewInput.labels],
  ])
    assert.equal(
      (await request(speakerReviewPath, "PUT", JSON.stringify({ ...speakerReviewInput, labels })))
        .status,
      422,
    );
  assert.equal(
    (
      await request(
        speakerReviewPath,
        "PUT",
        JSON.stringify({ ...speakerReviewInput, sourceRevision: randomUUID() }),
      )
    ).status,
    409,
  );
  pass();
  assert.equal(
    (await request(speakerReviewPath, "PUT", JSON.stringify(speakerReviewInput), recruiter!))
      .status,
    404,
  );
  assert.ok(
    [401, 403].includes(
      (await request(speakerReviewPath, "PUT", JSON.stringify(speakerReviewInput), candidateUser!))
        .status,
    ),
  );
  assert.equal(
    (
      await request(
        `/jobs/${otherJob}/candidates/${candidate}/meeting-notes/${speakerNote.id}/speaker-review`,
        "PUT",
        JSON.stringify(speakerReviewInput),
      )
    ).status,
    404,
  );
  pass();
  const labelResponse = await request(speakerReviewPath, "PUT", JSON.stringify(speakerReviewInput));
  assert.equal(labelResponse.status, 200);
  assert.equal(labelResponse.headers.get("cache-control"), "no-store");
  const labelled = await labelResponse.json();
  assert.deepEqual(labelled.speakerEvidence.segments, separated.speakerEvidence.segments);
  assert.equal(labelled.speakerEvidence.review.reviewedBy, admin);
  assert.deepEqual(labelled.speakerEvidence.review.labels, speakerReviewInput.labels);
  assert.equal(labelled.transcript, separated.transcript);
  assert.equal(labelled.summary, separated.summary);
  pass();
  assert.equal(
    (await request(speakerReviewPath, "PUT", JSON.stringify(speakerReviewInput))).status,
    409,
  );
  const concurrentLabels = {
    ...speakerReviewInput,
    previousRevision: labelled.speakerEvidence.review.revision,
    labels: [{ speaker: 1, label: "Reviewed source participant", role: "unknown" }],
  };
  const labelRaces = await Promise.all([
    request(speakerReviewPath, "PUT", JSON.stringify(concurrentLabels)),
    request(speakerReviewPath, "PUT", JSON.stringify(concurrentLabels)),
  ]);
  assert.deepEqual(labelRaces.map((response) => response.status).sort(), [200, 409]);
  pass();
  const latestLabels = await (await request(`${base}/${speakerNote.id}`)).json();
  assert.equal(latestLabels.speakerEvidence.review.labels[0].label, "Reviewed source participant");
  const clearedLabels = await request(
    speakerReviewPath,
    "PUT",
    JSON.stringify({
      ...speakerReviewInput,
      previousRevision: latestLabels.speakerEvidence.review.revision,
      labels: [],
    }),
  );
  assert.equal(clearedLabels.status, 200);
  const clearedSpeakerReview = await clearedLabels.json();
  assert.deepEqual(clearedSpeakerReview.speakerEvidence.review.labels, []);
  assert.deepEqual(
    clearedSpeakerReview.speakerEvidence.segments,
    separated.speakerEvidence.segments,
  );
  assert.notEqual(
    clearedSpeakerReview.speakerEvidence.review.revision,
    latestLabels.speakerEvidence.review.revision,
  );
  assert.deepEqual(
    { transcribes, summaries, speakerCalls },
    countsBeforeLabels,
    "Review must not call any model or provider.",
  );
  pass();
  const failureNote = await (await request(base, "POST", upload())).json();
  speakerFailure = true;
  assert.equal(
    (await request(`${base}/${failureNote.id}/process`, "POST", '{"separateSpeakers":true}'))
      .status,
    202,
  );
  const failedSpeakers = await poll(failureNote.id, "failed");
  assert.equal(failedSpeakers.speakerEvidence, null);
  assert.equal(failedSpeakers.transcript, null);
  assert.equal(
    transcribes,
    beforeStandardCalls,
    "A failed opt-in must not silently use another provider.",
  );
  speakerFailure = false;
  pass();
  assert.equal((await request(`${base}/${failureNote.id}/process`, "POST", "{}")).status, 202);
  const standardRetry = await poll(failureNote.id, "completed");
  assert.equal(standardRetry.speakerEvidence, null);
  assert.equal(transcribes, beforeStandardCalls + 1);
  pass();
  assert.equal((await request(`${base}/${speakerNote.id}`, "DELETE")).status, 204);
  assert.equal((await request(`${base}/${failureNote.id}`, "DELETE")).status, 204);
  assert.equal((await request(`${base}/${speakerNote.id}`)).status, 404);
  pass();
  const reviewInput = {
    sourceHash: completed.transcriptHash,
    previousRevision: null,
    entries: [
      {
        questionIndex: 0,
        status: "covered",
        excerpt: completed.transcript,
        note: "Source-only staff annotation.",
      },
    ],
  };
  assert.match(reviewInput.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(completed.questionReview, null);
  assert.ok(
    [401, 403].includes(
      (await request(reviewPath, "PUT", JSON.stringify(reviewInput), candidateUser!)).status,
    ),
  );
  assert.equal(
    (
      await request(
        `/jobs/${foreignJob}/candidates/${otherCandidate}/meeting-notes/${note.id}/question-review`,
        "PUT",
        JSON.stringify(reviewInput),
      )
    ).status,
    404,
  );
  pass();
  assert.equal(
    (await request(reviewPath, "PUT", JSON.stringify({ ...reviewInput, reviewedBy: recruiter })))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        reviewPath,
        "PUT",
        JSON.stringify({ ...reviewInput, sourceHash: "0".repeat(64) }),
      )
    ).status,
    409,
  );
  pass();
  for (const entries of [
    [{ ...reviewInput.entries[0], excerpt: "This never appears in the source." }],
    [{ ...reviewInput.entries[0], questionIndex: 99 }],
    [...reviewInput.entries, ...reviewInput.entries],
    [{ ...reviewInput.entries[0], status: "not_covered" }],
  ]) {
    assert.equal(
      (await request(reviewPath, "PUT", JSON.stringify({ ...reviewInput, entries }))).status,
      422,
    );
    pass();
  }
  const save = await request(reviewPath, "PUT", JSON.stringify(reviewInput));
  assert.equal(save.status, 200);
  assert.equal(save.headers.get("cache-control"), "no-store");
  const reviewed = await save.json();
  assert.equal(reviewed.questionReview.reviewedBy, admin);
  assert.equal(reviewed.questionReview.sourceHash, completed.transcriptHash);
  assert.equal(reviewed.questionReview.entries[0].evidenceStart, 0);
  assert.equal(reviewed.questionReview.entries[0].evidenceEnd, completed.transcript.length);
  assert.equal(reviewed.transcript, completed.transcript);
  assert.equal(reviewed.summary, completed.summary);
  pass();
  const countsBeforeExportRead = { transcribes, summaries };
  const exported = await request(exportPath);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("cache-control"), "no-store");
  assert.equal(exported.headers.get("x-content-type-options"), "nosniff");
  assert.match(exported.headers.get("content-type")!, /^text\/plain; charset=utf-8$/i);
  assert.equal(
    exported.headers.get("content-disposition"),
    `attachment; filename="meeting-notes-${note.id}.txt"`,
  );
  const exportedText = await exported.text();
  assert.ok(exportedText.includes(completed.transcript));
  assert.ok(exportedText.includes(completed.summary));
  assert.ok(exportedText.includes(reviewed.questionReview.revision));
  assert.match(exportedText, /NOT AN APPROVED HIRING ASSESSMENT/);
  assert.match(exportedText, /Staff status: Covered/);
  assert.match(exportedText, /Source-only staff annotation/);
  assert.doesNotMatch(exportedText, /\/objects\/|processingToken|objectPath/);
  assert.equal(transcribes, countsBeforeExportRead.transcribes);
  assert.equal(summaries, countsBeforeExportRead.summaries);
  pass();
  assert.equal((await request(reviewPath, "PUT", JSON.stringify(reviewInput))).status, 409);
  pass();
  const competing = { ...reviewInput, previousRevision: reviewed.questionReview.revision };
  const raced = await Promise.all([
    request(reviewPath, "PUT", JSON.stringify(competing)),
    request(reviewPath, "PUT", JSON.stringify(competing)),
  ]);
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 409]);
  const winner = await raced.find((response) => response.status === 200)!.json();
  const readBack = await (await request(`${base}/${note.id}`)).json();
  assert.equal(readBack.questionReview.revision, winner.questionReview.revision);
  pass();
  const clear = await request(
    reviewPath,
    "PUT",
    JSON.stringify({ ...competing, previousRevision: winner.questionReview.revision, entries: [] }),
  );
  assert.equal(clear.status, 200);
  const cleared = await clear.json();
  assert.deepEqual(cleared.questionReview.entries, []);
  assert.notEqual(cleared.questionReview.revision, winner.questionReview.revision);
  assert.equal((await request(reviewPath, "PUT", JSON.stringify(competing))).status, 409);
  pass();
  // Retry replaces source and invalidates even an empty saved annotation revision.
  await dbAdmin
    .update(meetingNotesTable)
    .set({ status: "failed", error: "Synthetic retry fixture", summary: null })
    .where(eq(meetingNotesTable.id, note.id));
  const failedExport = await request(exportPath);
  assert.equal(failedExport.status, 200);
  assert.match(await failedExport.text(), /No saved summary is available/);
  pass();
  const retry = await request(`${base}/${note.id}/process`, "POST", "{}");
  assert.equal(retry.status, 202);
  const retryNote = await retry.json();
  assert.equal(retryNote.questionReview, null);
  assert.equal(retryNote.transcriptHash, null);
  assert.equal((await poll(note.id, "completed")).questionReview, null);
  pass();
  assert.equal((await request(`${base}/${note.id}`, "DELETE")).status, 204);
  assert.equal(objects.size, 0);
  assert.equal((await request(`${base}/${note.id}`)).status, 404);
  assert.equal((await request(exportPath)).status, 404);
  pass();
  // Erasure while transcription is in flight cannot resurrect source content.
  const summariesBeforeErasure = summaries;
  const pending = await (await request(base, "POST", upload())).json();
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  assert.equal((await request(`${base}/${pending.id}/process`, "POST", "{}")).status, 202);
  await started;
  await dbAdmin
    .update(candidatesTable)
    .set({ dataErasedAt: new Date() })
    .where(eq(candidatesTable.id, candidate!));
  assert.equal(await isCandidateErased(candidate!), true);
  release();
  hold = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [fenced] = await dbAdmin
    .select()
    .from(meetingNotesTable)
    .where(eq(meetingNotesTable.id, pending.id));
  assert.equal(fenced!.transcript, null);
  assert.equal(fenced!.summary, null);
  assert.equal(summaries, summariesBeforeErasure);
  assert.equal((await request(`${base}/${pending.id}`)).status, 404);
  pass();
  // BYPASSRLS workers must not re-parent an erased candidate's private source
  // to an active candidate. The recording-only guard checks NEW; the canonical
  // barrier additionally checks OLD and rejects this attempted reassignment.
  await assert.rejects(
    pool.query("UPDATE public.meeting_notes SET candidate_id=$2 WHERE id=$1", [
      pending.id,
      otherCandidate!,
    ]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "P0001" &&
      error.message === "candidate_erased",
  );
  const retainedOwner = await pool.query(
    "SELECT candidate_id, transcript, summary FROM public.meeting_notes WHERE id=$1",
    [pending.id],
  );
  assert.equal(retainedOwner.rows[0].candidate_id, candidate);
  assert.equal(retainedOwner.rows[0].transcript, null);
  assert.equal(retainedOwner.rows[0].summary, null);
  pass();
  process.stdout.write(
    `PASS ${checks} meeting-notes HTTP/privacy/processing checks (mocked storage and AI).\n`,
  );
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await dbAdmin.delete(meetingNotesTable).where(eq(meetingNotesTable.tenantId, tenant!));
  await dbAdmin
    .delete(interviewZoomMeetingsTable)
    .where(eq(interviewZoomMeetingsTable.tenantId, tenant!));
  await dbAdmin
    .delete(interviewSchedulesTable)
    .where(eq(interviewSchedulesTable.tenantId, tenant!));
  await dbAdmin
    .delete(applicationsTable)
    .where(inArray(applicationsTable.tenantId, [tenant!, foreignTenant!]));
  await dbAdmin
    .delete(candidatesTable)
    .where(inArray(candidatesTable.id, [candidate!, otherCandidate!]));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, [job!, otherJob!, foreignJob!]));
  await dbAdmin
    .delete(usersTable)
    .where(inArray(usersTable.id, [admin!, candidateUser!, recruiter!]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenant!, foreignTenant!]));
  await pool.end();
}
