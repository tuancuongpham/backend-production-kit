// shared/worker-loop.ts: independent poll loops that go again at once after work, pause when idle or after an
// error, and stop when the signal aborts, even in the middle of a pause.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runLoops } from '../../../shared/worker-loop.ts';
import { sleep, waitFor } from '../support/wait.ts';

describe('kernel: runLoops', () => {
  it('goes again at once while there is work, and pauses for idleMs when there is none', async () => {
    let backlog = 5;
    const ticks: number[] = [];
    const ac = new AbortController();
    const running = runLoops({
      tick: async () => {
        ticks.push(performance.now());
        return backlog-- > 0;
      },
      signal: ac.signal,
      idleMs: 200,
    });
    await waitFor(() => ticks.length >= 6, 'the backlog to drain');
    await sleep(50);
    ac.abort();
    await running;
    assert.equal(ticks.length, 6, 'five ticks with work, then one idle tick, then a pause');
    assert.ok(ticks[5] - ticks[0] < 150, 'no pause between ticks that found work');
  });

  it('runs `loops` ticks at the same time', async () => {
    let concurrent = 0;
    let peak = 0;
    const ac = new AbortController();
    const running = runLoops({
      tick: async () => {
        peak = Math.max(peak, ++concurrent);
        await sleep(20);
        concurrent--;
        return true;
      },
      signal: ac.signal,
      loops: 4,
    });
    await waitFor(() => peak === 4, 'four ticks at once');
    ac.abort();
    await running;
  });

  it('an error is reported, paused on, and the loop keeps going', async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const ac = new AbortController();
    const running = runLoops({
      tick: async () => {
        ticks++;
        throw new Error('database unreachable');
      },
      signal: ac.signal,
      idleMs: 5,
      onError: (err) => errors.push(err),
    });
    await waitFor(() => ticks >= 3, 'three ticks');
    ac.abort();
    await running;
    assert.ok(errors.length >= 3);
  });

  it('aborting ends a pause at once: stopping does not wait out idleMs', async () => {
    const ac = new AbortController();
    const running = runLoops({ tick: async () => false, signal: ac.signal, idleMs: 60_000 });
    await sleep(20);
    const started = performance.now();
    ac.abort();
    await running;
    assert.ok(performance.now() - started < 500);
  });
});
