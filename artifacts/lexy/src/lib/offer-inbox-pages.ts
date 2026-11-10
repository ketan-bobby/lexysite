type InboxPage<T> = {
  data?: { items: T[]; nextCursor?: string | null };
  isError: boolean;
  error?: unknown;
  failureReason?: unknown;
};

/** A failed refresh is not permission to keep presenting its cached offer rows. */
export function offerInboxPages<T extends { workflowId: string }>(
  first: InboxPage<T>,
  additional: InboxPage<T>[],
  requestedCursors?: readonly string[],
) {
  const pages = [first, ...additional];
  const denied = pages.find((page) => {
    const status = ((page.error ?? page.failureReason) as { status?: number } | null)?.status;
    // Authorization failure must hide cached rows even during automatic retries.
    return status === 401 || status === 403;
  });
  const unavailable = !!denied || first.isError || !first.data;
  // Only stitch together pages fetched from the currently returned boundaries.
  // Check denials above against ALL queries, including a now-disconnected suffix.
  const linked = [first];
  const acceptedCursors: string[] = [];
  let paginationChanged = false;
  if (requestedCursors) {
    for (let i = 0; i < additional.length; i++) {
      const parent = linked[linked.length - 1];
      if (!parent.data) break;
      const expected = parent.data.nextCursor;
      if (!expected || requestedCursors[i] !== expected || acceptedCursors.includes(expected)) {
        paginationChanged = true;
        break;
      }
      acceptedCursors.push(expected);
      linked.push(additional[i]);
    }
  } else {
    linked.push(...additional);
  }
  const lastCursor = linked[linked.length - 1].data?.nextCursor ?? null;
  const paginationLoop = !!lastCursor && acceptedCursors.includes(lastCursor);
  const seen = new Set<string>();
  const rows: T[] = [];
  if (!unavailable) {
    for (const page of linked) {
      if (page.isError) continue;
      for (const row of page.data?.items ?? []) {
        if (seen.has(row.workflowId)) continue;
        seen.add(row.workflowId);
        rows.push(row);
      }
    }
  }
  return {
    rows,
    accessDenied: !!denied,
    accessError: denied?.error ?? denied?.failureReason,
    canShowDetail: !unavailable,
    paginationChanged,
    paginationLoop,
    retainedCursorCount: acceptedCursors.length,
    nextCursor:
      !unavailable && !paginationLoop && linked.every((page) => !page.isError && page.data)
        ? lastCursor
        : null,
  };
}

/** Keep denial evidence mounted until a new first-page request succeeds. */
export async function refreshOfferInboxPages(
  refetch: () => Promise<{ isError: boolean; isFetching: boolean; dataUpdatedAt: number }>,
  resetPages: () => void,
  previousUpdatedAt: number,
) {
  const result = await refetch();
  if (!result.isError && !result.isFetching && result.dataUpdatedAt > previousUpdatedAt)
    resetPages();
}
