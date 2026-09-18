import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  DISCOVERY_QUEUE,
  HyperliquidInfoClient,
  SCORING_RESULTS_QUEUE,
  WeightBudget,
} from '@remora/sdk';
import { validateWalletFinderConfig, type WalletFinderConfig } from './config';
import { DiscoveryProcessor } from './discovery/discovery.processor';
import { ScoringResults } from './discovery/scoringResults';
import { StatsDataFiles } from './discovery/statsDataFiles';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { WalletScorer } from './scoring/walletScorer';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateWalletFinderConfig,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<WalletFinderConfig, true>) => ({
        connection: { url: config.getOrThrow('REDIS_URL', { infer: true }) },
      }),
    }),
    BullModule.registerQueue(
      { name: DISCOVERY_QUEUE },
      { name: SCORING_RESULTS_QUEUE },
    ),
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    {
      provide: WeightBudget,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WalletFinderConfig, true>) =>
        new WeightBudget(
          config.getOrThrow('HYPERLIQUID_WEIGHT_PER_MINUTE', { infer: true }),
        ),
    },
    {
      provide: HyperliquidInfoClient,
      inject: [ConfigService, WeightBudget],
      useFactory: (
        config: ConfigService<WalletFinderConfig, true>,
        budget: WeightBudget,
      ) =>
        new HyperliquidInfoClient(
          config.getOrThrow('HYPERLIQUID_API_URL', { infer: true }),
          budget,
        ),
    },
    MetricsService,
    StatsDataFiles,
    WalletScorer,
    ScoringResults,
    DiscoveryProcessor,
  ],
})
export class AppModule {}
