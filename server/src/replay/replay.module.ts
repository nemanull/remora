import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateServerConfig } from '../config';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ReplayRun } from './replayRun';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateServerConfig }),
    MetricsModule,
    HyperliquidModule,
  ],
  providers: [ReplayRun],
})
export class ReplayModule {}
