import assert from "node:assert/strict";
import test from "node:test";
import { offerInboxPages, refreshOfferInboxPages } from "./offer-inbox-pages";

const entry = (workflowId: string) => ({ workflowId, candidateName: `PRIVATE_${workflowId}` });
const page = (...ids: string[]) => ({
  isError: false,
  data: { items: ids.map(entry), nextCursor: "next" as string | null },
});

test("successful pages preserve ordering, deduplicate workflows and retain the final cursor", () => {
  const view = offerInboxPages(page("a", "b"), [page("b", "c")]);
  assert.deepEqual(
    view.rows.map((r) => r.workflowId),
    ["a", "b", "c"],
  );
  assert.equal(view.nextCursor, "next");
  assert.equal(view.canShowDetail, true);
});

test("a failed first refresh hides all cached rows and details", () => {
  const view = offerInboxPages({ ...page("a"), isError: true }, [page("b")]);
  assert.deepEqual(view.rows, []);
  assert.equal(view.nextCursor, null);
  assert.equal(view.canShowDetail, false);
});

test("a failed additional refresh hides its cached rows but keeps successful peers", () => {
  const view = offerInboxPages(page("a"), [
    { ...page("b"), isError: true, error: { status: 500 } },
    page("c"),
  ]);
  assert.deepEqual(
    view.rows.map((r) => r.workflowId),
    ["a", "c"],
  );
  assert.equal(view.nextCursor, null);
  assert.equal(view.canShowDetail, true);
});

for (const status of [401, 403]) {
  test(`${status} hides cached rows immediately while an automatic retry is pending`, () => {
    const view = offerInboxPages(page("a"), [{ ...page("private"), failureReason: { status } }]);
    assert.deepEqual(view.rows, []);
    assert.equal(view.nextCursor, null);
    assert.equal(view.canShowDetail, false);
    assert.equal(view.accessDenied, true);
  });
  for (const position of ["first", "additional"]) {
    test(`${status} on ${position} page hides the entire inbox and selected detail`, () => {
      const denied = { ...page("denied"), isError: true, error: { status } };
      const view = offerInboxPages(position === "first" ? denied : page("a"), [
        position === "additional" ? denied : page("b"),
      ]);
      assert.deepEqual(view.rows, []);
      assert.equal(view.nextCursor, null);
      assert.equal(view.canShowDetail, false);
      assert.equal(view.accessDenied, true);
      assert.equal((view.accessError as { status: number }).status, status);
    });
  }
}

test("without a successful first page, cached additional pages cannot become the inbox", () => {
  const view = offerInboxPages({ isError: false }, [page("private")]);
  assert.deepEqual(view.rows, []);
  assert.equal(view.canShowDetail, false);
  assert.equal(view.nextCursor, null);
});

test("an unfinished additional page blocks further pagination, not valid first-page rows", () => {
  const view = offerInboxPages(page("a"), [{ isError: false }]);
  assert.deepEqual(view.rows, [entry("a")]);
  assert.equal(view.nextCursor, null);
});

test("successful recovery uses new rows and the new cursor, never failed cached entries", () => {
  const extra = { ...page("old"), isError: true };
  assert.deepEqual(offerInboxPages(page("a"), [extra]).rows, [entry("a")]);
  const recovered = { ...page("new"), data: { items: [entry("new")], nextCursor: null } };
  const view = offerInboxPages(page("a"), [recovered]);
  assert.deepEqual(view.rows, [entry("a"), entry("new")]);
  assert.equal(view.nextCursor, null);
});

test("retry does not discard denied pages before the first-page request succeeds", async () => {
  let finish!: (result: { isError: boolean; isFetching: boolean; dataUpdatedAt: number }) => void;
  let resets = 0;
  const request = refreshOfferInboxPages(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => {
      resets++;
    },
    1,
  );
  assert.equal(resets, 0);
  finish({ isError: false, isFetching: false, dataUpdatedAt: 2 });
  await request;
  assert.equal(resets, 1);
});

test("a failed retry preserves denial evidence and does not clear loaded pages", async () => {
  let resets = 0;
  await refreshOfferInboxPages(
    async () => ({ isError: true, isFetching: false, dataUpdatedAt: 1 }),
    () => {
      resets++;
    },
    1,
  );
  assert.equal(resets, 0);
});

test("an unexpected retry rejection cannot clear denial evidence", async () => {
  let resets = 0;
  await assert.rejects(
    refreshOfferInboxPages(
      async () => {
        throw new Error("retry refused");
      },
      () => {
        resets++;
      },
      1,
    ),
    /retry refused/,
  );
  assert.equal(resets, 0);
});

test("cancelled or still-pending refetches cannot expose cached pages as a successful recovery", async () => {
  let resets = 0;
  for (const result of [
    { isError: false, isFetching: false, dataUpdatedAt: 1 },
    { isError: false, isFetching: true, dataUpdatedAt: 2 },
  ]) {
    await refreshOfferInboxPages(
      async () => result,
      () => {
        resets++;
      },
      1,
    );
  }
  assert.equal(resets, 0);
});

const cursorPage = (ids: string[], nextCursor: string | null) => ({
  isError: false,
  data: { items: ids.map(entry), nextCursor },
});
const ids = (view: ReturnType<typeof offerInboxPages>) => view.rows.map((row) => row.workflowId);

test("unchanged cursor boundaries preserve all loaded pages without a reset", () => {
  const view = offerInboxPages(
    cursorPage(["a", "b"], "b"),
    [cursorPage(["c", "d"], "d"), cursorPage(["e", "f"], null)],
    ["b", "d"],
  );
  assert.deepEqual(ids(view), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(view.paginationChanged, false);
  assert.equal(view.paginationLoop, false);
  assert.equal(view.retainedCursorCount, 2);
  assert.equal(view.nextCursor, null);
});

for (const promoted of ["new", "f"]) {
  test(`a ${promoted === "new" ? "new" : "previously later"} offer moving to page one cannot silently skip its displaced offer`, () => {
    const first = cursorPage([promoted, "a"], "a");
    const stale = offerInboxPages(
      first,
      [cursorPage(["c", "d"], "d"), cursorPage(["e", "f"], null)],
      ["b", "d"],
    );
    assert.deepEqual(ids(stale), [promoted, "a"]);
    assert.equal(stale.paginationChanged, true);
    assert.equal(stale.retainedCursorCount, 0);
    assert.equal(stale.nextCursor, "a");
    const reloaded = offerInboxPages(first, [cursorPage(["b", "c"], "c")], ["a"]);
    assert.deepEqual(ids(reloaded), [promoted, "a", "b", "c"]);
    assert.equal(reloaded.paginationChanged, false);
    assert.equal(reloaded.nextCursor, "c");
  });
}

test("a changed middle-page boundary retains its valid prefix and rediscovers the displaced offer", () => {
  const first = cursorPage(["a", "b"], "b");
  const middle = cursorPage(["x", "c"], "c");
  const stale = offerInboxPages(first, [middle, cursorPage(["e", "f"], null)], ["b", "d"]);
  assert.deepEqual(ids(stale), ["a", "b", "x", "c"]);
  assert.equal(stale.paginationChanged, true);
  assert.equal(stale.retainedCursorCount, 1);
  assert.equal(stale.nextCursor, "c");
  const recovered = offerInboxPages(first, [middle, cursorPage(["d", "e"], null)], ["b", "c"]);
  assert.deepEqual(ids(recovered), ["a", "b", "x", "c", "d", "e"]);
  assert.equal(recovered.paginationChanged, false);
});

test("a new end-of-list discards obsolete later pages rather than presenting stale offers", () => {
  const view = offerInboxPages(cursorPage(["a"], null), [cursorPage(["stale"], null)], ["old"]);
  assert.deepEqual(ids(view), ["a"]);
  assert.equal(view.paginationChanged, true);
  assert.equal(view.retainedCursorCount, 0);
  assert.equal(view.nextCursor, null);
});

test("pending parent data does not reset cursors or expose cached descendants", () => {
  const view = offerInboxPages(
    cursorPage(["a"], "a"),
    [{ isError: false }, cursorPage(["unconfirmed"], null)],
    ["a", "b"],
  );
  assert.deepEqual(ids(view), ["a"]);
  assert.equal(view.paginationChanged, false);
  assert.equal(view.nextCursor, null);
});

for (const status of [401, 403]) {
  test(`a ${status} on an obsolete suffix remains authoritative over a fresh cursor chain`, () => {
    const view = offerInboxPages(
      cursorPage(["private-first"], "new"),
      [{ ...cursorPage(["private-old"], null), failureReason: { status } }],
      ["old"],
    );
    assert.deepEqual(view.rows, []);
    assert.equal(view.accessDenied, true);
    assert.equal(view.canShowDetail, false);
    assert.equal(view.nextCursor, null);
    assert.equal(view.paginationChanged, true);
  });
}

test("a filtered-empty page with a continuation can still reach later offers", () => {
  const first = cursorPage([], "after-filtered");
  const view = offerInboxPages(first, [], []);
  assert.deepEqual(view.rows, []);
  assert.equal(view.nextCursor, "after-filtered");
  const more = offerInboxPages(first, [cursorPage(["available"], null)], ["after-filtered"]);
  assert.deepEqual(ids(more), ["available"]);
  assert.equal(more.paginationChanged, false);
});

test("repeating an earlier cursor stops pagination without claiming the inbox is complete", () => {
  const view = offerInboxPages(cursorPage(["a"], "a"), [cursorPage(["b"], "a")], ["a"]);
  assert.deepEqual(ids(view), ["a", "b"]);
  assert.equal(view.paginationLoop, true);
  assert.equal(view.nextCursor, null);
});

test("a late old-boundary response cannot replace the currently linked page", () => {
  const first = cursorPage(["new"], "new-boundary");
  const old = offerInboxPages(first, [cursorPage(["late-old"], null)], ["old-boundary"]);
  assert.deepEqual(ids(old), ["new"]);
  assert.equal(old.paginationChanged, true);
  const current = offerInboxPages(first, [cursorPage(["current"], null)], ["new-boundary"]);
  assert.deepEqual(ids(current), ["new", "current"]);
  assert.equal(current.paginationChanged, false);
});
