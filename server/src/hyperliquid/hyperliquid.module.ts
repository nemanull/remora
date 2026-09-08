import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HyperliquidInfoClient, WeightBudget } from '@remora/sdk';
import type { ServerConfig } from '../config';
import { MetricsService } from '../metrics/metrics.service';

const WEIGHT_METRIC_INTERVAL_MS = 10_000;
const PROCESS_LABEL = 'server';

@Module({
  providers: [
    {
      provide: WeightBudget,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerConfig, true>) =>
        new WeightBudget(
          config.getOrThrow('HYPERLIQUID_WEIGHT_PER_MINUTE', { infer: true }),
        ),
    },
    {
      provide: HyperliquidInfoClient,
      inject: [ConfigService, WeightBudget],
      useFactory: (
        config: ConfigService<ServerConfig, true>,
        budget: WeightBudget,
      ) =>
        new HyperliquidInfoClient(
          config.getOrThrow('HYPERLIQUID_API_URL', { infer: true }),
          budget,
        ),
    },
  ],
  exports: [WeightBudget, HyperliquidInfoClient],
})
export class HyperliquidModule implements OnModuleInit, OnModuleDestroy {
  private recordedWeight = 0;
  private metricTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly budget: WeightBudget,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.metricTimer = setInterval(
      () => this.recordWeightUsed(),
      WEIGHT_METRIC_INTERVAL_MS,
    );
    this.metricTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.metricTimer);
    this.recordWeightUsed();
  }

  private recordWeightUsed(): void {
    const used = this.budget.readUsedTotal();
    if (used > this.recordedWeight) {
      this.metrics.hyperliquidWeightUsedTotal.inc(
        { process: PROCESS_LABEL },
        used - this.recordedWeight,
      );
      this.recordedWeight = used;
    }
  }
}
