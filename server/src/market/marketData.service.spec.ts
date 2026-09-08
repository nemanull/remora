import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  HyperliquidInfoClient,
  L2BookResponse,
  MetaAndAssetCtxs,
} from '@remora/sdk';
import type { AddressInfo } from 'node:net';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { ServerConfig } from '../config';
import { MetricsService } from '../metrics/metrics.service';
import {
  MarketDataService,
  readMarkets,
  readMids,
  readOrderBook,
} from './marketData.service';

function context(markPx: string, funding = '0.0000125') {
  return {
    funding,
    openInterest: '1000',
    prevDayPx: markPx,
    dayNtlVlm: '1000000',
    premium: '0.0001',
    oraclePx: markPx,
    markPx,
    midPx: markPx,
    impactPxs: [markPx, markPx],
    dayBaseVlm: '100',
  };
}

const META_AND_ASSET_CTXS: MetaAndAssetCtxs = [
  {
    universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
      { name: 'ETH', szDecimals: 4, maxLeverage: 25, marginTableId: 55 },
      {
        name: 'MATIC',
        szDecimals: 1,
        maxLeverage: 20,
        marginTableId: 20,
        isDelisted: true,
      },
      {
        name: 'NEAR',
        szDecimals: 1,
        maxLeverage: 10,
        marginTableId: 52,
        onlyIsolated: true,
        marginMode: 'noCross',
      },
      { name: 'kBONK', szDecimals: 0, maxLeverage: 3, marginTableId: 3 },
    ],
  },
  [
    context('80012.5'),
    context('2012.35'),
    context('0.21'),
    context('4.832', '-0.0000031'),
    context('0.003759'),
  ],
];

const ALL_MIDS_FRAME = {
  channel: 'allMids',
  data: {
    mids: {
      BTC: '80011.5',
      ETH: '2012.25',
      NEAR: '4.8315',
      '@107': '41.2',
    },
  },
};

describe('readMarkets', () => {
  it('reads every live main-dex perp with its asset index', () => {
    const markets = readMarkets(META_AND_ASSET_CTXS);

    expect([...markets.keys()]).toEqual(['BTC', 'ETH', 'NEAR', 'kBONK']);
    expect(markets.get('kBONK')?.assetIndex).toBe(4);
    expect(markets.get('BTC')).toMatchObject({
      szDecimals: 5,
      maxLeverage: 40,
      isOnlyIsolated: false,
      marginMode: null,
    });
    expect(markets.get('BTC')?.markPrice.toString()).toBe('80012.5');
  });

  it('keeps the margin mode and the isolated flag of a market', () => {
    const near = readMarkets(META_AND_ASSET_CTXS).get('NEAR');

    expect(near).toMatchObject({
      isOnlyIsolated: true,
      marginMode: 'noCross',
      assetIndex: 3,
    });
    expect(near?.fundingRate.toString()).toBe('-0.0000031');
    expect(near?.oraclePrice.toString()).toBe('4.832');
  });

  it('refuses a response whose shape is not meta and asset contexts', () => {
    expect(() =>
      readMarkets([
        { universe: [{ name: 'BTC' }] },
        [],
      ] as unknown as MetaAndAssetCtxs),
    ).toThrow();
  });
});

describe('readMids', () => {
  it('reads the mids of an allMids frame', () => {
    expect(readMids(ALL_MIDS_FRAME)).toEqual(ALL_MIDS_FRAME.data.mids);
  });

  it('ignores other channels and malformed frames', () => {
    expect(readMids({ channel: 'trades', data: [] })).toBeNull();
    expect(
      readMids({ channel: 'allMids', data: { mids: { BTC: 1 } } }),
    ).toBeNull();
  });
});

describe('MarketDataService', () => {
  let server: WebSocketServer | null = null;
  let service: MarketDataService | null = null;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(async () => {
    await service?.onModuleDestroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    service = null;
    server = null;
  });

  async function startService(infoClient: Partial<HyperliquidInfoClient>) {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const request = JSON.parse((data as Buffer).toString('utf8')) as {
          method: string;
          subscription: unknown;
        };
        if (request.method !== 'subscribe') {
          return;
        }
        socket.send(
          JSON.stringify({ channel: 'subscriptionResponse', data: request }),
        );
        socket.send(JSON.stringify(ALL_MIDS_FRAME));
      });
    });
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const config = {
      getOrThrow: () => `ws://127.0.0.1:${port}`,
    } as unknown as ConfigService<ServerConfig, true>;
    service = new MarketDataService(
      infoClient as HyperliquidInfoClient,
      new MetricsService(),
      config,
    );
    return service;
  }

  it('loads markets at boot and publishes mids of known markets', async () => {
    const marketData = await startService({
      metaAndAssetCtxs: vi.fn().mockResolvedValue(META_AND_ASSET_CTXS),
    });
    const update = firstValueFrom(marketData.mids$);

    await marketData.onModuleInit();

    expect(marketData.hasMarkets()).toBe(true);
    expect(marketData.readMarket('ETH')?.szDecimals).toBe(4);
    const { mids } = await update;
    expect([...mids.keys()]).toEqual(['BTC', 'ETH', 'NEAR']);
    expect(mids.get('BTC')?.toString()).toBe('80011.5');
    expect(marketData.readMid('NEAR')?.price.toString()).toBe('4.8315');
    expect(marketData.readMid('DOGE')).toBeNull();
  });

  it('keeps the cluster link closed when markets fail to load and retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const metaAndAssetCtxs = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(META_AND_ASSET_CTXS);
    const marketData = await startService({ metaAndAssetCtxs });

    await marketData.onModuleInit();
    expect(marketData.hasMarkets()).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    vi.useRealTimers();

    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(2);
    expect(marketData.hasMarkets()).toBe(true);
  });
});

describe('readOrderBook', () => {
  it('reads a book with domain prices and sizes', () => {
    const book: L2BookResponse = {
      coin: 'BTC',
      time: 1_770_000_000_000,
      levels: [
        [{ px: '80010', sz: '1.5', n: 3 }],
        [
          { px: '80012', sz: '0.4', n: 1 },
          { px: '80013', sz: '2', n: 2 },
        ],
      ],
    };
    const result = readOrderBook(book);

    expect(result.time).toEqual(new Date(1_770_000_000_000));
    expect(result.bids.map((level) => level.price.toString())).toEqual([
      '80010',
    ]);
    expect(result.asks.map((level) => level.size.toString())).toEqual([
      '0.4',
      '2',
    ]);
  });
});
