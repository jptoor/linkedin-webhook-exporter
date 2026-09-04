/** A tiny async mutex. Every read-modify-write of extension storage goes
 *  through `withLock` so concurrent captures, flushes, and export commits
 *  cannot interleave (audit BG-01). MV3 workers are single-threaded, but
 *  every `await` is a yield point, which is enough to lose writes. */
let chain: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
