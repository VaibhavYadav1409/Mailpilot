/**
 * Minimal concurrency limiter — no new dependency (avoids repeating the
 * Prisma-install network headaches we've hit before in this repo's sandbox).
 *
 * Returns a `run` function: callers pass an async task, and it resolves
 * once the task is allowed to start (i.e. once a "slot" is free), not once
 * the task finishes. That's the shape fire-and-forget callers need — they
 * can still `.catch()` the result without awaiting it, but the underlying
 * work is now queued instead of firing immediately.
 *
 * `maxQueue` caps how many tasks may wait in the backlog. This matters for
 * the fire-and-forget AI calls fired during a sync: the sync loop persists
 * messages far faster than the LLM drains them, so without a cap the queue
 * grows to hold one closure PER email (each capturing that email's bodyText
 * string) simultaneously — on a large first sync that backlog alone can be
 * tens of MB and was contributing to the 512MB OOM. When the backlog is
 * full, new tasks are rejected with QUEUE_FULL instead of being buffered;
 * callers treat that as "skip for now" (the sync's self-healing pass
 * re-attempts uncategorized/unscored emails on a later run, so nothing is
 * permanently lost). 0 or a negative value means unbounded (previous
 * behaviour).
 */
export const QUEUE_FULL = Symbol("QUEUE_FULL");

export function createLimiter(maxConcurrent: number, maxQueue = 0) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (active >= maxConcurrent) return;
    const resume = queue.shift();
    if (!resume) return;
    active++;
    resume();
  }

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (maxQueue > 0 && queue.length >= maxQueue) {
        reject(QUEUE_FULL);
        return;
      }
      const attempt = () => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(attempt);
      next();
    });
  };
}
