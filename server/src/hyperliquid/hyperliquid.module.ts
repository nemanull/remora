import { Inject, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HyperliquidInfoClient, WeightBudget } from '@remora/sdk';
import type { ServerConfig } from '../config';
import { MetricsService } from '../metrics/metrics.service';

const WEIGHT_METRIC_INTERVAL_MS = 10_000;
const PROCESS_LABEL = 'server';

export const PAPER_BOOK_BUDGET = 'PAPER_BOOK_BUDGET';
export const PAPER_BOOK_INFO_CLIENT = 'PAPER_BOOK_INFO_CLIENT';

@Module({
  providers: [
    {
      provide: WeightBudget,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerConfig, true>) =>
        new WeightBudget(
          config.getOrThrow('HYPERLIQUID_WEIGHT_PER_MINUTE', { infer: true }) -
            config.getOrThrow('PAPER_BOOK_WEIGHT_PER_MINUTE', { infer: true }),
        ),
    },
    {
      provide: PAPER_BOOK_BUDGET,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerConfig, true>) =>
        new WeightBudget(
          config.getOrThrow('PAPER_BOOK_WEIGHT_PER_MINUTE', { infer: true }),
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
    {
      provide: PAPER_BOOK_INFO_CLIENT,
      inject: [ConfigService, PAPER_BOOK_BUDGET],
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
  exports: [
    WeightBudget,
    HyperliquidInfoClient,
    PAPER_BOOK_BUDGET,
    PAPER_BOOK_INFO_CLIENT,
  ],
})
export class HyperliquidModule implements OnModuleInit, OnModuleDestroy {
  private recordedWeight = 0;
  private metricTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly budget: WeightBudget,
    @Inject(PAPER_BOOK_BUDGET) private readonly paperBookBudget: WeightBudget,
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
    const used =
      this.budget.readUsedTotal() + this.paperBookBudget.readUsedTotal();
    if (used > this.recordedWeight) {
      this.metrics.hyperliquidWeightUsedTotal.inc(
        { process: PROCESS_LABEL },
        used - this.recordedWeight,
      );
      this.recordedWeight = used;
    }
  }
}
