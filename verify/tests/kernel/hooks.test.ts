// shared/hooks.ts: a hook the app passes in observes the work and can't change its outcome.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callHook } from '../../../shared/hooks.ts';
import { sleep } from '../support/wait.ts';

/** The promise rejections nobody handled while `fn` ran: each one would end a real process. */
async function unhandledDuring(fn: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => void seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    fn();
    await sleep(20);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('kernel: callHook', () => {
  it('calls the hook with the arguments, and does nothing without one', () => {
    const calls: unknown[][] = [];
    callHook((...args: unknown[]) => calls.push(args), 'evt_1', new Error('handler failed'));
    callHook(undefined, 'ignored');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'evt_1');
  });

  it('a hook that throws changes nothing for the caller', () => {
    assert.doesNotThrow(() =>
      callHook(() => {
        throw new Error('the alert hook is broken');
      }),
    );
  });

  it('an async hook that rejects (Slack is down) is no unhandled rejection', async () => {
    assert.deepEqual(await unhandledDuring(() => callHook(async () => Promise.reject(new Error('slack is down')))), []);
  });

  it('a thenable that is not a Promise is handled too', async () => {
    const thenable = { then: (_resolve: unknown, reject: (e: Error) => void) => reject(new Error('custom promise library')) };
    assert.deepEqual(await unhandledDuring(() => callHook(() => thenable)), []);
  });
});
