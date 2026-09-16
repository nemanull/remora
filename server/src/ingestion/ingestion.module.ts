import { Module } from '@nestjs/common';
import { CopyModule } from '../copy/copy.module';
import { SignalBuilder } from '../copy/signalBuilder';
import { MarketModule } from '../market/market.module';
import { FillIngestionService } from './fillIngestion.service';
import { LeaderStateService } from './leaderState.service';
import { SyncStateService } from './syncState.service';

@Module({
  imports: [MarketModule, CopyModule],
  providers: [
    SignalBuilder,
    SyncStateService,
    FillIngestionService,
    LeaderStateService,
  ],
  exports: [
    SignalBuilder,
    SyncStateService,
    FillIngestionService,
    LeaderStateService,
  ],
})
export class IngestionModule {}
