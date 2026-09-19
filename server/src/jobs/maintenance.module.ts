import { Module } from '@nestjs/common';
import { BooksModule } from '../books/books.module';
import { ExecutionModule } from '../execution/execution.module';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { MarketModule } from '../market/market.module';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({
  imports: [HyperliquidModule, MarketModule, BooksModule, ExecutionModule],
  providers: [MaintenanceProcessor],
})
export class MaintenanceModule {}
