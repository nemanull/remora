import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { HyperliquidInfoClient, WeightBudget } from '@remora/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateServerConfig } from '../config';
import { MetricsModule } from '../metrics/metrics.module';
import {
  HyperliquidModule,
  PAPER_BOOK_BUDGET,
  PAPER_BOOK_INFO_CLIENT,
} from './hyperliquid.module';

const REQUIRED = {
  DATABASE_URL: 'postgresql://remora:remora@127.0.0.1:55432/remora',
  REDIS_URL: 'redis://127.0.0.1:56379',
  HYPERLIQUID_API_URL: 'http://127.0.0.1:9',
  CLUSTER_TOKEN_HASHES: `1:${'a'.repeat(64)}`,
  HYPERLIQUID_WEIGHT_PER_MINUTE: '400',
  PAPER_BOOK_WEIGHT_PER_MINUTE: '120',
};

function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('HyperliquidModule budgets', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    const config = validateServerConfig(REQUIRED);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [() => config],
        }),
        MetricsModule,
        HyperliquidModule,
      ],
    }).compile();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await moduleRef.close();
  });

  it('splits the process budget into the main bucket and the paper book share', () => {
    const main = moduleRef.get(WeightBudget);
    const paperBooks = moduleRef.get<WeightBudget>(PAPER_BOOK_BUDGET);
    expect(main.weightPerMinute).toBe(280);
    expect(paperBooks.weightPerMinute).toBe(120);
    expect(main.weightPerMinute + paperBooks.weightPerMinute).toBe(400);
  });

  it('charges paper book reads to their own bucket only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ coin: 'ETH', time: 0, levels: [[], []] }),
            {
              status: 200,
            },
          ),
        ),
      ),
    );
    await moduleRef
      .get<HyperliquidInfoClient>(PAPER_BOOK_INFO_CLIENT)
      .l2Book('ETH');
    expect(moduleRef.get<WeightBudget>(PAPER_BOOK_BUDGET).readUsedTotal()).toBe(
      2,
    );
    expect(moduleRef.get(WeightBudget).readUsedTotal()).toBe(0);
  });

  it('leaves the main bucket untouched when paper reads exhaust theirs', async () => {
    const main = moduleRef.get(WeightBudget);
    const paperBooks = moduleRef.get<WeightBudget>(PAPER_BOOK_BUDGET);
    paperBooks.charge(paperBooks.weightPerMinute);
    await expect(settlesWithin(paperBooks.take(2), 100)).resolves.toBe(false);
    await expect(settlesWithin(main.take(2), 100)).resolves.toBe(true);
    expect(main.readUsedTotal()).toBe(2);
  });
});
