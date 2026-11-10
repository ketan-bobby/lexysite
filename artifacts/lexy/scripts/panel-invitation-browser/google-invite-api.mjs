import assert from "node:assert/strict";

export const MEET = "https://meet.google.com/abc-defg-hij";
const clone = (v) => structuredClone(v);
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** Synthetic fake of the two candidate-only Google invitation endpoints. */
export function createInviteApi(schedule, ttlMs = 600_000) {
  const base = () => ({
    provider: "google",
    scheduleId: schedule.id,
    version: schedule.version,
    scheduledAt: schedule.scheduledAt,
    durationMinutes: schedule.durationMinutes,
    jobTitle: "Backend Engineer",
    recipientEmail: "candidate@example.invalid",
    organizerEmail: "organizer@example.invalid",
    connectionRevision: "rev-1",
    status: "ready",
    reason: null,
    approvalToken: "approval-token-1",
    reviewExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
    acceptedAt: null,
    meetUrl: null,
    conferenceStatus: "not_requested",
    deliveryConfirmed: false,
  });
  const s = {
    current: base(),
    gets: 0,
    posts: [],
    rotate: false, // each GET issues a fresh proof
    failGet: null, // status code for next GET
    failPost: null, // status code for next POST
    postPatch: null, // object merged over the accepted receipt
    postReceipt: null, // full replacement receipt
    gate: null,
    unexpected: [],
  };
  const accepted = () => ({
    ...s.current,
    status: "accepted",
    approvalToken: null,
    reviewExpiresAt: null,
    acceptedAt: "2035-10-01T09:00:00.000Z",
    conferenceStatus: "ready",
    meetUrl: MEET,
  });
  async function handle(url, request, reply) {
    assert.equal(
      url.pathname,
      `/api/google-calendar/schedules/${schedule.id}/invitation`,
      "Unexpected Google invitation API request",
    );
    if (request.method() === "GET") {
      s.gets++;
      if (s.failGet) {
        const c = s.failGet;
        s.failGet = null;
        return reply({ error: "Synthetic read failure." }, c);
      }
      const out = clone(s.current);
      const first = s.gets === 1;
      if (s.rotate && s.gets > 1 && out.status === "ready") {
        out.approvalToken = `approval-token-fresh-${s.gets}`;
        out.reviewExpiresAt = new Date(Date.now() + ttlMs + 60_000 * s.gets).toISOString();
      }
      if (first) s.firstGet = clone(out);
      return reply(out);
    }
    assert.equal(request.method(), "POST");
    const body = JSON.parse(request.postData() ?? "{}");
    assert.deepEqual(Object.keys(body).sort(), [
      "confirm",
      "expectedApprovalToken",
      "expectedVersion",
      "reviewExpiresAt",
    ]);
    assert.equal(body.confirm, true);
    s.posts.push(body);
    if (s.gate) {
      s.gate.started.resolve();
      await s.gate.promise;
    }
    if (s.failPost) {
      const c = s.failPost;
      s.failPost = null;
      return reply({ error: "Synthetic send failure." }, c);
    }
    const receipt = s.postReceipt ?? { ...accepted(), ...(s.postPatch ?? {}) };
    if (!s.postReceipt) s.current = clone(receipt);
    return reply(clone(receipt));
  }
  return {
    state: s,
    handle,
    base,
    hold() {
      s.gate = deferred();
      s.gate.started = deferred();
      const g = s.gate;
      return { started: g.started.promise, release: () => g.resolve() };
    },
  };
}
