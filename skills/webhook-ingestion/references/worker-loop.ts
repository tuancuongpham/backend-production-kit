// Polling loops for background workers. Vendored into each skill that imports it: edit shared/worker-loop.ts,
// then run `npm run sync:shared`. `npm run validate` fails if a copy drifts.
import { setTimeout as sleep } from 'node:timers/promises';

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
  onError?: (err: unknown) => void;
}

export async function runLoops(o: LoopOptions): Promise<void> {
  const pause = () => sleep(o.idleMs ?? 1000, undefined, { signal: o.signal }).catch(() => {});
  const loop = async () => {
    while (!o.signal.aborted) {
      let worked = false;
      try {
        worked = await o.tick();
      } catch (err) {
        o.onError?.(err);
      }
      if (!worked) await pause();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.loops ?? 1) }, loop));
}
