/**
 * Bounded-concurrency map that keeps fail-closed semantics.
 *
 * The blob helpers used to await one network call per item inside a for loop:
 * ~958 sequential round-trips for de/B1, which reads as a hang — no output, no
 * timeout, nothing to tell you it is still working. This runs `limit` of them at
 * a time and reports progress, without changing what happens on failure.
 *
 * Failure behaviour, which is the part that matters for a fail-closed verifier:
 *   - the first rejection (by ITEM ORDER, not by whichever settles first) is the
 *     one thrown, so the error is deterministic and matches what the sequential
 *     loop would have reported;
 *   - once anything rejects, no further work is scheduled;
 *   - every in-flight promise is awaited before throwing, so nothing lands as an
 *     unhandled rejection after the caller has moved on.
 */

/**
 * @param {Array} items
 * @param {number} limit concurrent workers
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {{ onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Array>} results in the same order as `items`
 */
export async function mapWithConcurrency(items, limit, worker, { onProgress } = {}) {
  const list = Array.from(items);
  const total = list.length;
  const results = new Array(total);
  if (!total) return results;

  const width = Math.max(1, Math.min(Number(limit) || 1, total));
  let next = 0;
  let done = 0;
  /** @type {{ index: number, error: any } | null} */
  let firstFailure = null;

  async function run() {
    for (;;) {
      if (firstFailure !== null) return; // stop scheduling once something failed
      const index = next++;
      if (index >= total) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        // Keep the earliest item's error, so the message does not depend on timing.
        if (firstFailure === null || index < firstFailure.index) firstFailure = { index, error };
        return;
      }
      done++;
      if (onProgress) onProgress(done, total);
    }
  }

  // allSettled, not all: every worker must finish before we throw, or a later
  // rejection surfaces as an unhandled rejection after the caller has bailed out.
  await Promise.allSettled(Array.from({ length: width }, () => run()));

  if (firstFailure !== null) throw firstFailure.error;
  return results;
}

/** A progress line that overwrites itself, for a TTY; silent otherwise. */
export function progressWriter(label, stream = process.stdout) {
  const tty = Boolean(stream.isTTY);
  let last = 0;
  return (doneCount, total) => {
    if (!tty) return;
    const now = Date.now();
    if (doneCount < total && now - last < 120) return; // don't repaint on every item
    last = now;
    stream.write(`\r${label} ${doneCount}/${total}`);
    if (doneCount === total) stream.write('\n');
  };
}
