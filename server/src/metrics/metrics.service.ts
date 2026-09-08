import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly collectorOnline = new Gauge({
    name: 'remora_collector_online',
    help: 'Whether the cluster has a live collector session',
    labelNames: ['cluster'] as const,
    registers: [this.registry],
  });

  readonly collectorWallets = new Gauge({
    name: 'remora_collector_wallets',
    help: 'Wallets assigned to the cluster',
    labelNames: ['cluster'] as const,
    registers: [this.registry],
  });

  readonly collectorLastEventAgeSeconds = new Gauge({
    name: 'remora_collector_last_event_age_seconds',
    help: 'Seconds since the collector last received an event for the wallet',
    labelNames: ['cluster', 'wallet'] as const,
    registers: [this.registry],
  });

  readonly collectorUpstreamReconnectsTotal = new Counter({
    name: 'remora_collector_upstream_reconnects_total',
    help: 'Upstream socket reconnects reported by the collector',
    labelNames: ['cluster'] as const,
    registers: [this.registry],
  });

  readonly collectorClockOffsetMs = new Gauge({
    name: 'remora_collector_clock_offset_ms',
    help: 'Clock offset of the collector against the core from its last heartbeat',
    labelNames: ['cluster'] as const,
    registers: [this.registry],
  });

  readonly collectorEventLoopDelayP99Ms = new Gauge({
    name: 'remora_collector_event_loop_delay_p99_ms',
    help: 'Event loop delay p99 reported by the collector',
    labelNames: ['cluster'] as const,
    registers: [this.registry],
  });

  readonly fillLatencyMs = new Histogram({
    name: 'remora_fill_latency_ms',
    help: 'Collector receive time minus leader fill time',
    buckets: [50, 100, 150, 200, 250, 300, 400, 500, 750, 1_000, 2_000, 5_000],
    registers: [this.registry],
  });

  readonly decisionLatencyMs = new Histogram({
    name: 'remora_decision_latency_ms',
    help: 'Decision time minus leader fill time',
    buckets: [100, 200, 300, 400, 500, 750, 1_000, 2_000, 5_000, 15_000],
    registers: [this.registry],
  });

  readonly orderLatencyMs = new Histogram({
    name: 'remora_order_latency_ms',
    help: 'Order acknowledgement time minus submission time',
    buckets: [
      100, 250, 500, 750, 900, 1_000, 1_250, 1_500, 2_000, 3_000, 5_000,
    ],
    registers: [this.registry],
  });

  readonly decisionsTotal = new Counter({
    name: 'remora_decisions_total',
    help: 'Stored copy decisions',
    labelNames: ['book', 'verdict', 'reason'] as const,
    registers: [this.registry],
  });

  readonly bookEquityUsd = new Gauge({
    name: 'remora_book_equity_usd',
    help: 'Book equity marked at the mids',
    labelNames: ['book'] as const,
    registers: [this.registry],
  });

  readonly killSwitchActive = new Gauge({
    name: 'remora_kill_switch_active',
    help: 'Whether the kill switch blocks entries on the book',
    labelNames: ['book'] as const,
    registers: [this.registry],
  });

  readonly hyperliquidWeightUsedTotal = new Counter({
    name: 'remora_hyperliquid_weight_used_total',
    help: 'Hyperliquid REST weight spent',
    labelNames: ['process'] as const,
    registers: [this.registry],
  });

  readonly hyperliquidRateLimitedTotal = new Counter({
    name: 'remora_hyperliquid_rate_limited_total',
    help: 'Hyperliquid REST calls answered with 429',
    labelNames: ['process'] as const,
    registers: [this.registry],
  });

  readonly jobDurationSeconds = new Histogram({
    name: 'remora_job_duration_seconds',
    help: 'Duration of background jobs',
    labelNames: ['queue', 'job'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 1_800],
    registers: [this.registry],
  });

  readonly jobFailuresTotal = new Counter({
    name: 'remora_job_failures_total',
    help: 'Background jobs that failed',
    labelNames: ['queue', 'job'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
