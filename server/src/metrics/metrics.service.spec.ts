import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service';

const EXPECTED_METRICS = [
  'remora_collector_online',
  'remora_collector_wallets',
  'remora_collector_last_event_age_seconds',
  'remora_collector_upstream_reconnects_total',
  'remora_collector_clock_offset_ms',
  'remora_collector_event_loop_delay_p99_ms',
  'remora_fill_latency_ms',
  'remora_decision_latency_ms',
  'remora_order_latency_ms',
  'remora_decisions_total',
  'remora_book_equity_usd',
  'remora_kill_switch_active',
  'remora_hyperliquid_weight_used_total',
  'remora_hyperliquid_rate_limited_total',
  'remora_job_duration_seconds',
  'remora_job_failures_total',
];

describe('MetricsService', () => {
  it('registers the collector, latency, decision, book, weight and job metrics', async () => {
    const metrics = new MetricsService();

    const names = (await metrics.registry.getMetricsAsJSON()).map(
      (metric) => metric.name,
    );

    expect(names).toEqual(expect.arrayContaining(EXPECTED_METRICS));
  });

  it('exposes the event loop delay for the scale lab', async () => {
    const metrics = new MetricsService();

    expect(await metrics.registry.metrics()).toContain(
      'nodejs_eventloop_lag_p99_seconds',
    );
  });

  it('keeps each instance on its own registry', async () => {
    const first = new MetricsService();
    const second = new MetricsService();

    first.decisionsTotal.inc({
      book: 'MAIN',
      verdict: 'SKIP',
      reason: 'stale_signal',
    });

    expect(await first.registry.metrics()).toContain(
      'remora_decisions_total{book="MAIN",verdict="SKIP",reason="stale_signal"} 1',
    );
    expect(await second.registry.metrics()).not.toContain('stale_signal');
  });
});
