// Waiting in tests. Prefer waitFor on the condition that matters over a sleep of a guessed length: a guess is either
// too short on a slow CI runner (a flaky test) or longer than needed everywhere else (a slow suite).

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `condition` until it holds; fails with "timed out waiting for <what>" after `ms`. */
export async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
