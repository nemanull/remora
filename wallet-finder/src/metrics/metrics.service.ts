import { Injectable } from '@nestjs/common';
import { WeightBudget } from '@remora/sdk';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

export const PROCESS_LABEL = 'wallet-finder';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private reportedWeight = 0;

  readonly discoveryRunDurationSeconds = new Histogram({
    name: 'remora_discovery_run_duration_seconds',
    help: 'Duration of discovery runs',
    labelNames: ['outcome'] as const,
    buckets: [60, 300, 900, 1_800, 3_600, 5_400, 7_200, 10_800],
    registers: [this.registry],
  });

  readonly discoveryWalletsScoredTotal = new Counter({
    name: 'remora_discovery_wallets_scored_total',
    help: 'Wallets scored by discovery runs, per stage',
    labelNames: ['stage'] as const,
    registers: [this.registry],
  });

  readonly hyperliquidWeightUsedTotal = new Counter({
    name: 'remora_hyperliquid_weight_used_total',
    help: 'Hyperliquid REST weight spent',
    labelNames: ['process'] as const,
    registers: [this.registry],
    collect: () => this.reportWeightUsed(),
  });

  readonly hyperliquidRateLimitedTotal = new Counter({
    name: 'remora_hyperliquid_rate_limited_total',
    help: 'Hyperliquid REST calls answered with 429',
    labelNames: ['process'] as const,
    registers: [this.registry],
  });

  constructor(private readonly budget: WeightBudget) {
    collectDefaultMetrics({ register: this.registry });
  }

  private reportWeightUsed(): void {
    const used = this.budget.readUsedTotal();
    this.hyperliquidWeightUsedTotal.inc(
      { process: PROCESS_LABEL },
      used - this.reportedWeight,
    );
    this.reportedWeight = used;
  }
}
