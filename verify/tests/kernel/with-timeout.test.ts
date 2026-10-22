// shared/with-timeout.ts: a deadline for any promise, which never leaves a timer or an unhandled rejection behind.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../../../shared/with-timeout.ts';
import { sleep } from '../support/wait.ts';

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('kernel: withTimeout', () => {
  it('settles like the promise when it is in time, and leaves no timer behind', async () => {
    const before = timers();
    assert.equal(await withTimeout(Promise.resolve('answer'), 1000, () => new Error('late')), 'answer');
    await assert.rejects(withTimeout(Promise.reject(new Error('refused')), 1000, () => new Error('late')), /refused/);
    assert.equal(timers(), before);
  });

  it('rejects with onTimeout() once the deadline passes', async () => {
    const started = performance.now();
    await assert.rejects(withTimeout(new Promise(() => {}), 30, () => new Error('redis timeout after 30 ms')), /redis timeout/);
    assert.ok(performance.now() - started < 500);
  });

  it("the losing promise's late rejection is no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const late = sleep(40).then(() => Promise.reject(new Error('the call failed after the deadline')));
      await assert.rejects(withTimeout(late, 10, () => new Error('deadline')), /deadline/);
      await sleep(60);
    } finally {
      process.off('unhandledRejection', listener);
    }
    assert.deepEqual(unhandled, []);
  });
});
