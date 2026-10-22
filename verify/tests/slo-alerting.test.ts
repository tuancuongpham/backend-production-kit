import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { burnAlerts, prometheusRules, simulate, type Slo } from '../../skills/slo-alerting/references/slo.ts';

const checkout: Slo = {
  name: 'checkout-availability',
  service: 'checkout',
  objective: 0.999,
  errorRatio:
    'sum(rate(http_requests_total{job="checkout",code=~"5.."}[{{window}}])) / sum(rate(http_requests_total{job="checkout"}[{{window}}]))',
};

/** Three quiet days at 1,000 requests a minute, then `minutes` at the given error ratio. */
const traffic = (errorRatio: number, minutes: number) => [
  ...Array.from({ length: 4320 }, () => ({ total: 1000, errors: 0 })),
  ...Array.from({ length: minutes }, () => ({ total: 1000, errors: 1000 * errorRatio })),
];
const QUIET = 4320;

const PROMETHEUS_IMAGE = 'prom/prometheus:v2.55.1';
const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
const hasDocker = docker.status === 0;

describe('slo-alerting', () => {
  it('a 10% error rate on a 99.9% SLO pages within 9 minutes; the steady-burn ticket follows', () => {
    const first = simulate(0.999, traffic(0.1, 120));
    assert.deepEqual(
      { 'page:1h': first['page:1h']! - QUIET, 'page:6h': first['page:6h']! - QUIET, 'ticket:3d': first['ticket:3d']! - QUIET },
      { 'page:1h': 9, 'page:6h': 22, 'ticket:3d': 44 },
    );
  });

  it('a slow burn (0.2% errors, twice the sustainable rate) never pages, and opens a ticket after 36 hours', () => {
    const first = simulate(0.999, traffic(0.002, 2 * 24 * 60));
    assert.equal(first['page:1h'], null);
    assert.equal(first['page:6h'], null);
    assert.equal(first['ticket:3d']! - QUIET, 36 * 60 + 1);
  });

  it('normal noise (0.05% errors) never alerts', () => {
    assert.deepEqual(simulate(0.999, traffic(0.0005, 3 * 24 * 60)), { 'page:1h': null, 'page:6h': null, 'ticket:3d': null });
  });

  it('burn rates are reported per window, for dashboards', () => {
    const alerts = burnAlerts(0.999, { '5m': 0.02, '30m': 0.01, '1h': 0.015, '6h': 0.004, '3d': 0.0005 });
    assert.deepEqual(
      alerts.map((a) => [a.severity, a.long, Math.round(a.burnLong * 10) / 10, a.firing]),
      [
        ['page', '1h', 15, true],
        ['page', '6h', 4, false],
        ['ticket', '3d', 0.5, false],
      ],
    );
  });

  it('the generated rules pass promtool, and Prometheus itself fires, holds and resolves them as designed', { skip: hasDocker ? false : 'docker is not available' }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kit-slo-'));
    chmodSync(dir, 0o755); // mkdtemp makes it 0700, and the Prometheus image runs as `nobody` (Linux CI)
    writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(prometheusRules([checkout]), null, 2));
    const page = (long: string, factor: number) => ({
      exp_labels: { severity: 'page', long_window: long, slo: 'checkout-availability', service: 'checkout' },
      exp_annotations: { summary: `checkout-availability: error budget burning over ${factor}x the sustainable rate for ${long}` },
    });
    const ticket = {
      exp_labels: { severity: 'ticket', long_window: '3d', slo: 'checkout-availability', service: 'checkout' },
      exp_annotations: { summary: 'checkout-availability: error budget burning over 1x the sustainable rate for 3d' },
    };
    const series = (ok: string, failed: string) => [
      { series: 'http_requests_total{job="checkout",code="200"}', values: ok },
      { series: 'http_requests_total{job="checkout",code="500"}', values: failed },
    ];
    const alertsAt = (eval_time: string, exp_alerts: unknown[]) => ({ eval_time, alertname: 'SLOErrorBudgetBurn', exp_alerts });
    writeFileSync(
      path.join(dir, 'tests.json'),
      JSON.stringify({
        rule_files: ['rules.json'],
        evaluation_interval: '1m',
        tests: [
          // 10% of checkout requests fail for 20 minutes, then the fix ships.
          {
            interval: '1m',
            input_series: series('0+900x60', '0+100x20 2000+0x40'),
            alert_rule_test: [
              alertsAt('5m', [page('1h', 14.4), page('6h', 6)]),
              alertsAt('15m', [page('1h', 14.4), page('6h', 6), ticket]),
              // Each alert resolves once its short window is clean: the 1h page 5 minutes after the fix, the 6h page
              // after 30. The ticket (6h short window) stays open for the follow-up.
              alertsAt('35m', [page('6h', 6), ticket]),
              alertsAt('55m', [ticket]),
            ],
          },
          // A healthy hour.
          { interval: '1m', input_series: series('0+999x60', '0+1x60'), alert_rule_test: [alertsAt('60m', [])] },
        ],
      }),
    );
    const promtool = (...args: string[]) =>
      spawnSync('docker', ['run', '--rm', '-v', `${dir}:/work`, '-w', '/work', '--entrypoint', 'promtool', PROMETHEUS_IMAGE, ...args], {
        encoding: 'utf8',
        timeout: 300_000,
      });
    const check = promtool('check', 'rules', 'rules.json');
    assert.equal(check.status, 0, check.stdout + check.stderr);
    const test = promtool('test', 'rules', 'tests.json');
    assert.equal(test.status, 0, test.stdout + test.stderr);
  });
});
