/**
 * Runs `worker` over `items` with at most `limit` in flight. Uploading everything at
 * once saturates the connection pool and invites throttling; throttled replies often
 * lack CORS headers and then surface in the browser as an opaque "Failed to fetch".
 * The first failure rejects the whole run.
 */
export const runWithConcurrency = async <T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> => {
  let nextIndex = 0;

  const runNext = async (): Promise<void> => {
    for (let index = nextIndex++; index < items.length; index = nextIndex++) {
      // The index is bounded by the loop condition; noUncheckedIndexedAccess cannot see that.
      await worker(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, runNext));
};
