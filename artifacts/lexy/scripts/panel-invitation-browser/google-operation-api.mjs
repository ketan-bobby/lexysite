import assert from "node:assert/strict";

const clone = (v) => structuredClone(v);
export const tok = (c) => `gc_${c.repeat(64)}`;
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** Synthetic fake of the Google reschedule/cancel review + apply endpoints. */
export function createOperationApi(schedule, ttlMs = 600_000) {
  const base = (kind = "reschedule") => ({
    provider: "google",
    scheduleId: schedule.id,
    version: schedule.version,
    kind,
    status: "ready",
    recipientEmail: "candidate@example.invalid",
    organizerEmail: "organizer@example.invalid",
    previousStart: "2035-10-31T09:00:00.123Z",
    previousEnd: "2035-10-31T10:00:00.123Z",
    targetStart: kind === "cancel" ? null : schedule.scheduledAt,
    targetEnd: kind === "cancel" ? null : "2035-11-01T11:00:00.000Z",
    sourceEtag: "etag-1",
    approvalToken: tok("a"),
    reviewExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
    operationId: null,
    acceptedAt: null,
    meetUrl: null,
    deliveryConfirmed: false,
  });
  const s = {
    current: base(),
    gets: 0,
    posts: [],
    rotate: false,
    failGet: null,
    failPost: null,
    postReceipt: null,
    postPatch: null,
    gate: null,
    firstGet: null,
  };
  async function handle(url, request, reply) {
    assert.equal(
      url.pathname,
      `/api/google-calendar/schedules/${schedule.id}/invitation/operation`,
      "Unexpected Google operation API request",
    );
    if (request.method() === "GET") {
      s.gets++;
      if (s.failGet) {
        const c = s.failGet;
        s.failGet = null;
        return reply({ error: "Synthetic read failure." }, c);
      }
      if (s.getGate) {
        const g = s.getGate;
        s.getGate = null;
        const snapshot = clone(s.current);
        g.started.resolve();
        await g.promise;
        return reply(snapshot);
      }
      const out = clone(s.current);
      if (s.rotate && s.gets > 1 && out.status === "ready") {
        out.approvalToken = tok(String(s.gets % 10));
        out.reviewExpiresAt = new Date(Date.now() + ttlMs + 60_000 * s.gets).toISOString();
      }
      if (s.gets === 1) s.firstGet = clone(out);
      return reply(out);
    }
    assert.equal(request.method(), "POST");
    const body = JSON.parse(request.postData() ?? "{}");
    assert.deepEqual(Object.keys(body).sort(), [
      "confirm",
      "expectedApprovalToken",
      "expectedVersion",
      "kind",
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
      return reply({ error: "Synthetic write failure." }, c);
    }
    const receipt = s.postReceipt ?? {
      ...s.current,
      status: "accepted",
      approvalToken: null,
      reviewExpiresAt: null,
      operationId: "op-1",
      acceptedAt: "2035-10-01T09:00:00.000Z",
      ...(s.postPatch ?? {}),
    };
    if (!s.postReceipt) s.current = clone(receipt);
    return reply(clone(receipt));
  }
  const hold = (key) => {
    const g = deferred();
    g.started = deferred();
    s[key] = g;
    return { started: g.started.promise, release: () => g.resolve() };
  };
  return {
    state: s,
    handle,
    base,
    hold: () => hold("gate"),
    holdGet: () => hold("getGate"),
  };
}
