// Calling the hooks an app passes in: onError, onDead, onOverflow, onUsage. Vendored into each skill that imports it:
// edit shared/hooks.ts, then run `npm run sync:shared`. `npm run validate` fails if a copy drifts.
//
// A hook observes the work: a metric, a log line, an alert. If it throws, or returns a promise that rejects (an async
// alert while Slack is down), the work it observed must stand: a dead event stays dead, the limiter still decides, and
// a refresh running in the background doesn't end the process with an unhandled rejection.

/** Calls `hook`, if there is one. Whatever it throws or rejects with is dropped: there is nowhere left to report it. */
export function callHook<A extends unknown[]>(hook: ((...args: A) => unknown) | undefined, ...args: A): void {
  if (!hook) return;
  try {
    const result = hook(...args);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') Promise.resolve(result).catch(() => {});
  } catch {
    // the hook's own failure
  }
}
