// SLOs as code: each definition becomes Prometheus recording rules and multi-window, multi-burn-rate alerts
// (the scheme from Google's SRE workbook), plus the same alert logic as a pure function for tests and dashboards.
// Prometheus rule files are YAML, and JSON is valid YAML: the output can be written as-is with JSON.stringify.

export interface Slo {
  /** Stable id, e.g. 'checkout-availability'. */
  name: string;
  service: string;
  /** Target success ratio over the SLO period, e.g. 0.999. */
  objective: number;
  /**
   * PromQL for the error ratio over a range; `{{window}}` marks where the range goes, e.g.
   * sum(rate(http_requests_total{job="api",code=~"5.."}[{{window}}])) / sum(rate(http_requests_total{job="api"}[{{window}}]))
   * For a latency SLO, the bad events are the requests slower than the threshold (histogram buckets).
   */
  errorRatio: string;
  /** Linked from every alert: what to check first. */
  runbookUrl?: string;
}

/**
 * Page when the budget burns fast (2% of a 30-day budget in an hour, 5% in six hours), open a ticket when it
 * burns steadily (10% in three days). The short window makes an alert stop soon after the burn stops.
 */
export const BURN_ALERTS = [
  { severity: 'page', long: '1h', short: '5m', factor: 14.4, for: '2m' },
  { severity: 'page', long: '6h', short: '30m', factor: 6, for: '2m' },
  { severity: 'ticket', long: '3d', short: '6h', factor: 1, for: '10m' },
] as const;

export const WINDOWS = ['5m', '30m', '1h', '6h', '3d'] as const;
export type Window = (typeof WINDOWS)[number];

const recordName = (w: Window) => `slo:error_ratio:rate${w}`;

const checkObjective = (objective: number) => {
  // A common slip is the percentage: 99.9 instead of 0.999. Its budget would be negative and no alert could fire.
  if (!(objective > 0 && objective < 1)) throw new RangeError(`slo: objective must be a ratio between 0 and 1 (0.999 for 99.9%), got ${objective}`);
};

/**
 * Refuses definitions that would produce rules which load fine and never work: an objective written as a
 * percentage, an objective so low that a burn alert could never fire, an error ratio without {{window}} (all five
 * windows would be the same), a name that would break out of the `slo="…"` label matcher.
 */
export function assertSlo(s: Slo): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(s.name)) throw new Error(`slo: name "${s.name}" must be letters, digits and _.:- (it goes into a label matcher)`);
  if (!s.service) throw new Error(`slo ${s.name}: service is required`);
  checkObjective(s.objective);
  // A burn of 14.4× a 10% budget is an error ratio of 1.44: more than every request failing.
  const fastest = Math.max(...BURN_ALERTS.map((a) => a.factor));
  if (fastest * (1 - s.objective) > 1) {
    throw new Error(
      `slo ${s.name}: at objective ${s.objective} the ${fastest}x burn alert could never fire, even with every request failing. ` +
        `Use an objective of at least ${Math.ceil((1 - 1 / fastest) * 1000) / 1000}, or alert on the error ratio directly.`,
    );
  }
  if (!s.errorRatio.includes('{{window}}')) throw new Error(`slo ${s.name}: errorRatio must contain {{window}} where each window's range goes`);
}

export function prometheusRules(slos: Slo[]) {
  slos.forEach(assertSlo);
  return {
    groups: slos.map((s) => ({
      name: `slo:${s.name}`,
      rules: [
        ...WINDOWS.map((w) => ({
          record: recordName(w),
          expr: s.errorRatio.replaceAll('{{window}}', w),
          labels: { slo: s.name, service: s.service },
        })),
        ...BURN_ALERTS.map((a) => {
          const threshold = `(${a.factor} * ${round(1 - s.objective)})`;
          return {
            alert: 'SLOErrorBudgetBurn',
            expr: `${recordName(a.long)}{slo="${s.name}"} > ${threshold} and ${recordName(a.short)}{slo="${s.name}"} > ${threshold}`,
            for: a.for,
            labels: { severity: a.severity, long_window: a.long },
            annotations: {
              summary: `${s.name}: error budget burning over ${a.factor}x the sustainable rate for ${a.long}`,
              ...(s.runbookUrl ? { runbook_url: s.runbookUrl } : {}),
            },
          };
        }),
      ],
    })),
  };
}

const round = (x: number) => Math.round(x * 1e9) / 1e9;

/** Which alerts the error ratios would fire (ignoring `for`): the rules above as plain arithmetic. */
export function burnAlerts(objective: number, ratios: Record<Window, number>) {
  checkObjective(objective);
  const budget = 1 - objective;
  return BURN_ALERTS.map((a) => ({
    severity: a.severity,
    long: a.long,
    burnLong: ratios[a.long] / budget,
    burnShort: ratios[a.short] / budget,
    firing: ratios[a.long] > a.factor * budget && ratios[a.short] > a.factor * budget,
  }));
}

const MINUTES: Record<Window, number> = { '5m': 5, '30m': 30, '1h': 60, '6h': 360, '3d': 4320 };

/**
 * Replay per-minute traffic and report when each alert would first fire (minutes from the start, `for` ignored).
 * Use it to check what an incident of a given size and length would do before it happens.
 */
export function simulate(objective: number, minutes: Array<{ total: number; errors: number }>) {
  const firstFiring: Record<string, number | null> = Object.fromEntries(BURN_ALERTS.map((a) => [`${a.severity}:${a.long}`, null]));
  const prefixTotal = [0];
  const prefixErrors = [0];
  for (const m of minutes) {
    prefixTotal.push(prefixTotal.at(-1)! + m.total);
    prefixErrors.push(prefixErrors.at(-1)! + m.errors);
  }
  for (let t = 1; t <= minutes.length; t++) {
    const ratio = (w: Window) => {
      const from = Math.max(0, t - MINUTES[w]);
      const total = prefixTotal[t] - prefixTotal[from];
      return total === 0 ? 0 : (prefixErrors[t] - prefixErrors[from]) / total;
    };
    const ratios = Object.fromEntries(WINDOWS.map((w) => [w, ratio(w)])) as Record<Window, number>;
    for (const a of burnAlerts(objective, ratios)) {
      const key = `${a.severity}:${a.long}`;
      if (a.firing && firstFiring[key] === null) firstFiring[key] = t;
    }
  }
  return firstFiring;
}
