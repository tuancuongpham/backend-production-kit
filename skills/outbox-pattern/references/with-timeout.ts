// A deadline for any promise. Vendored into each skill that imports it: edit shared/with-timeout.ts, then run
// `npm run sync:shared`. `npm run validate` fails if a copy drifts.

/**
 * Settles like `promise`, or rejects with `onTimeout()` after `ms`. The losing promise's late rejection is handled
 * here: left unhandled, Node reports an unhandledRejection, which ends the process by default.
 * This bounds the wait, not the work: also pass an AbortSignal to calls that accept one.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
