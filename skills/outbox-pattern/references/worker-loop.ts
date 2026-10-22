// Polling loops for background workers. Vendored into each skill that imports it: edit shared/worker-loop.ts,
// then run `npm run sync:shared`. `npm run validate` fails if a copy drifts.
import { setTimeout as sleep } from 'node:timers/promises';
import { callHook } from './hooks.ts';

export interface LoopOptions {
  /** One unit of work. Resolves true when it found work (the loop goes again at once), false when idle. */
  tick: () => Promise<boolean>;
  /** Abort to stop: each loop finishes the tick it is in, then the returned promise resolves. */
  signal: AbortSignal;
  /** Independent loops calling `tick` concurrently (default 1). */
  loops?: number;
  /** Pause after an idle tick or an error, ms (default 1000). Aborting ends the pause at once. */
  idleMs?: number;
  /** A tick that threw. The loop pauses for `idleMs` and keeps going. */
  onError?: (err: unknown) => unknown;
}

export async function runLoops(o: LoopOptions): Promise<void> {
  const loops = o.loops ?? 1;
  const idleMs = o.idleMs ?? 1000;
  // A number read from an unset environment variable is NaN: `loops` would start no loop at all, and `idleMs` would
  // poll every millisecond. Refuse it before anything runs.
  if (!Number.isInteger(loops) || loops < 1) throw new RangeError(`worker loop: loops must be a positive integer, got ${loops}`);
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new RangeError(`worker loop: idleMs must be a number of ms, 0 or more, got ${idleMs}`);
  const pause = () => sleep(idleMs, undefined, { signal: o.signal }).catch(() => {});
  const loop = async () => {
    while (!o.signal.aborted) {
      let worked = false;
      try {
        worked = await o.tick();
      } catch (err) {
        callHook(o.onError, err); // a logger that throws must not stop the worker
      }
      if (!worked) await pause();
    }
  };
  await Promise.all(Array.from({ length: loops }, loop));
}
