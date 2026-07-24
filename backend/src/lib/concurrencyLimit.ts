/**
 * Minimal concurrency limiter — no new dependency (avoids repeating the
 * Prisma-install network headaches we've hit before in this repo's sandbox).
 *
 * Returns a `run` function: callers pass an async task, and it resolves
 * once the task is allowed to start (i.e. once a "slot" is free), not once
 * the task finishes. That's the shape fire-and-forget callers need — they
 * can still `.catch()` the result without awaiting it, but the underlying
 * work is now queued instead of firing immediately.
 */
export function createLimiter(maxConcurrent: number) {
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
