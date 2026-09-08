import { Module } from '@nestjs/common';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { MarketDataService } from './marketData.service';

@Module({
  imports: [HyperliquidModule],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketModule {}
