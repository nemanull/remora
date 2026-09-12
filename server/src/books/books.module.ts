import { Module } from '@nestjs/common';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { MarketModule } from '../market/market.module';
import { BookChains } from './bookChains';
import { BookStateService } from './bookState.service';
import { CopyPositionsService } from './copyPositions.service';
import { KillSwitchService } from './killSwitch.service';
import { LiveAccountService } from './liveAccount.service';
import { PaperStopsService } from './paperStops.service';

@Module({
  imports: [HyperliquidModule, MarketModule],
  providers: [
    BookChains,
    LiveAccountService,
    BookStateService,
    KillSwitchService,
    CopyPositionsService,
    PaperStopsService,
  ],
  exports: [
    BookChains,
    LiveAccountService,
    BookStateService,
    KillSwitchService,
    CopyPositionsService,
    PaperStopsService,
  ],
})
export class BooksModule {}
