import { HyperliquidInfoClient, WeightBudget } from '@remora/sdk';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { BooksModule } from '../books/books.module';
import type { ServerConfig } from '../config';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { MarketDataService } from '../market/marketData.service';
import { MarketModule } from '../market/market.module';
import { ExecutionService, LIVE_EXECUTOR } from './execution.service';
import { LiveExecutor, readAgentKey } from './liveExecutor';
import { OrdersService } from './orders.service';
import { PaperBookReader } from './paperBookReader';
import { PaperExecutor } from './paperExecutor';

async function createLiveExecutor(
  config: ConfigService<ServerConfig, true>,
  info: HyperliquidInfoClient,
  budget: WeightBudget,
  market: MarketDataService,
): Promise<LiveExecutor | null> {
  if (config.getOrThrow('EXECUTION_MODE', { infer: true }) !== 'live') {
    return null;
  }
  const agent = privateKeyToAccount(
    readAgentKey(
      config.getOrThrow('HYPERLIQUID_AGENT_KEY_FILE', { infer: true }),
    ),
  );
  const orderExpiryMs = config.getOrThrow('ORDER_EXPIRY_MS', { infer: true });
  const exchange = new ExchangeClient({
    transport: new HttpTransport({
      isTestnet:
        config.getOrThrow('HYPERLIQUID_NETWORK', { infer: true }) === 'testnet',
      apiUrl: config.getOrThrow('HYPERLIQUID_API_URL', { infer: true }),
    }),
    wallet: agent,
    defaultExpiresAfter: () => Date.now() + orderExpiryMs,
  });
  const executor = new LiveExecutor(exchange, info, budget, market, {
    accountAddress: config.getOrThrow('HYPERLIQUID_ACCOUNT_ADDRESS', {
      infer: true,
    }),
    agentAddress: agent.address.toLowerCase(),
    orderExpiryMs,
    takerFeeBps: config.getOrThrow('TAKER_FEE_BPS', { infer: true }),
    maxExchangeLeverage: config.getOrThrow('MAX_EXCHANGE_LEVERAGE', {
      infer: true,
    }),
  });
  await executor.verifyAccount();
  return executor;
}

@Module({
  imports: [HyperliquidModule, MarketModule, BooksModule],
  providers: [
    PaperBookReader,
    PaperExecutor,
    {
      provide: LIVE_EXECUTOR,
      inject: [
        ConfigService,
        HyperliquidInfoClient,
        WeightBudget,
        MarketDataService,
      ],
      useFactory: createLiveExecutor,
    },
    OrdersService,
    ExecutionService,
  ],
  exports: [ExecutionService, OrdersService, PaperExecutor, LIVE_EXECUTOR],
})
export class ExecutionModule {}
