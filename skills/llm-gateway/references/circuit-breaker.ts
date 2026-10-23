// A circuit breaker with a real half-open state. Vendored into each skill that imports it: edit
// shared/circuit-breaker.ts, then run `npm run sync:shared`. `npm run validate` fails if a copy drifts.
//
//   closed ── `threshold` failures in a row ──► open ── `cooldownMs` ──► half-open: one probe call goes out
//     ▲                                                                     │
//     └──────────────── probe succeeds ◄──────── probe fails: open again ◄──┘
//
// Without the half-open state, every request waiting when the cooldown ends goes to a dependency that may still be
// dead, and each of them waits out its full timeout.

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  threshold: number;
  /** How long the circuit stays open before one probe may go out; also how long a silent probe holds its slot. */
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  #failures = 0;
  #openedAt = 0;
  #probeSince: number | null = null;

  constructor(o: CircuitBreakerOptions) {
    if (!Number.isInteger(o.threshold) || o.threshold < 1) throw new RangeError('circuit breaker: threshold must be a positive integer');
    if (!Number.isFinite(o.cooldownMs) || o.cooldownMs < 0) throw new RangeError('circuit breaker: cooldownMs must be a non-negative number');
    this.#threshold = o.threshold;
    this.#cooldownMs = o.cooldownMs;
    this.#now = o.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.#failures < this.#threshold) return 'closed';
    const now = this.#now();
    // A wall clock stepped back (NTP correcting a drifted host, a VM resumed) would keep the circuit open for the whole
    // step, an hour of fallback for an hour's correction. The cooldown restarts from the time the step is seen instead.
    if (now < this.#openedAt) this.#openedAt = now;
    return now - this.#openedAt >= this.#cooldownMs ? 'half-open' : 'open';
  }

  /**
   * May a call go out now? Closed: yes. Open: no. Half-open: yes for one caller, the probe, until it reports
   * success() or failure(). A probe that never reports gives up its slot after `cooldownMs`.
   */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const now = this.#now();
    if (this.#probeSince !== null && now < this.#probeSince) this.#probeSince = now; // the clock stepped back
    if (this.#probeSince !== null && now - this.#probeSince < this.#cooldownMs) return false;
    this.#probeSince = now;
    return true;
  }

  success(): void {
    this.#failures = 0;
    this.#probeSince = null;
  }

  failure(): void {
    this.#probeSince = null;
    this.#failures++;
    if (this.#failures >= this.#threshold) this.#openedAt = this.#now();
  }
}
