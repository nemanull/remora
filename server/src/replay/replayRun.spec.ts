import type { ConfigService } from '@nestjs/config';
import type {
  Candle,
  HyperliquidFill,
  HyperliquidInfoClient,
  MetaAndAssetCtxs,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config';
import type { CopySettings } from '../copy/types';
import type { Market } from '../market/marketData.service';
import { buildReplayReport, renderReplayMarkdown } from './replayReport';
import {
  groupReplaySignals,
  interpolateEquity,
  readEquityHistory,
  type ReplayInput,
  ReplayRun,
  simulateReplay,
} from './replayRun';

const WALLET = '0x9e6b92cd44167d06b102e683df3f02e23d932e4f';
const START = Date.parse('2026-04-01T00:00:00.000Z');
const MINUTE = 60_000;

let nextTid = 100;

function fill(
  minute: number,
  side: 'B' | 'A',
  size: string,
  startPosition: string,
  price: string,
  overrides: Partial<HyperliquidFill> = {},
): HyperliquidFill {
  nextTid += 1;
  return {
    coin: 'ETH',
    px: price,
    sz: size,
    side,
    time: START + minute * MINUTE,
    startPosition,
    dir: side === 'B' ? 'Open Long' : 'Close Long',
    closedPnl: '0',
    hash: '0x00',
    oid: nextTid,
    crossed: true,
    fee: '0.5',
    tid: nextTid,
    feeToken: 'USDC',
    twapId: null,
    ...overrides,
  };
}

function candle(minute: number, low: string, high: string): Candle {
  return {
    t: START + minute * MINUTE,
    T: START + (minute + 15) * MINUTE - 1,
    s: 'ETH',
    i: '15m',
    o: '3000',
    c: '3000',
    h: high,
    l: low,
    v: '100',
    n: 10,
  };
}

const SETTINGS: CopySettings = {
  liveAllocationUsd: new Decimal(5_000),
  shadowAllocationUsd: new Decimal(5_000),
  signalMaxAgeMs: 15_000,
  driftLimitMajorBps: 50,
  driftLimitOtherBps: 100,
  exitSlippageBps: 300,
  leaderEquityMaxAgeMs: 900_000,
  positionCapMultiple: 3,
  grossExposureMultiple: 3,
  maxOpenCopies: 12,
  marginBuffer: 1.2,
  dailyLossLimit: 0.05,
  maxExchangeLeverage: 5,
};

const ETH: Market = {
  coin: 'ETH',
  assetIndex: 1,
  szDecimals: 4,
  maxLeverage: 25,
  isOnlyIsolated: false,
  marginMode: null,
  fundingRate: new Decimal(0),
  markPrice: new Decimal(3_000),
  oraclePrice: new Decimal(3_000),
};

function replayInput(
  fills: HyperliquidFill[],
  candles: Candle[] = [],
): ReplayInput {
  return {
    wallet: WALLET,
    source: 'http://127.0.0.1:3030',
    start: new Date(START),
    end: new Date(START + 2 * 86_400_000),
    fills,
    candles: new Map([['ETH', candles]]),
    funding: new Map([
      [
        'ETH',
        [
          {
            coin: 'ETH',
            fundingRate: '0.0001',
            premium: '0',
            time: START + 30 * MINUTE,
          },
        ],
      ],
    ]),
    equity: [
      { time: START - 86_400_000, value: new Decimal(100_000) },
      { time: START + 86_400_000, value: new Decimal(100_000) },
    ],
    markets: new Map([['ETH', ETH]]),
    settings: SETTINGS,
    latencyMs: 1_200,
    driftBps: 2,
    takerFeeBps: 4.5,
    stopLossShare: 0.2,
    stopMaxDistance: 0.25,
  };
}

describe('groupReplaySignals', () => {
  it('groups fills of one coin and millisecond into one signal in time order', () => {
    const fills = [
      fill(1, 'B', '4', '0', '3000'),
      fill(1, 'B', '6', '4', '3001'),
      fill(5, 'A', '10', '10', '3010'),
    ];
    const signals = groupReplaySignals(WALLET, fills);
    expect(signals).toHaveLength(2);
    expect(signals[0].fillIds).toHaveLength(2);
    expect(signals[0].positionAfter.toFixed()).toBe('10');
    expect(signals[0].vwap.toFixed()).toBe('3000.6');
    expect(signals[1].positionAfter.toFixed()).toBe('0');
  });
});

describe('interpolateEquity', () => {
  const points = [
    { time: 1_000, value: new Decimal(100) },
    { time: 3_000, value: new Decimal(200) },
  ];

  it('interpolates between two portfolio points', () => {
    expect(interpolateEquity(points, 2_000)?.toFixed()).toBe('150');
  });

  it('knows nothing before the first point and holds the last one after it', () => {
    expect(interpolateEquity(points, 999)).toBeNull();
    expect(interpolateEquity(points, 9_000)?.toFixed()).toBe('200');
  });
});

describe('readEquityHistory', () => {
  it('merges the combined windows and leaves the perp windows out', () => {
    const history = readEquityHistory([
      [
        'day',
        {
          accountValueHistory: [
            [2, '20'],
            [3, '30'],
          ],
          pnlHistory: [],
          vlm: '0',
        },
      ],
      [
        'allTime',
        {
          accountValueHistory: [
            [1, '10'],
            [2, '20'],
          ],
          pnlHistory: [],
          vlm: '0',
        },
      ],
      [
        'perpDay',
        { accountValueHistory: [[4, '99']], pnlHistory: [], vlm: '0' },
      ],
    ]);
    expect(history.map((point) => point.time)).toEqual([1, 2, 3]);
  });
});

describe('simulateReplay', () => {
  it('opens, resizes and closes a copy through the live engine with drift and sweep', async () => {
    const fills = [
      fill(1, 'B', '10', '0', '3000'),
      fill(10, 'B', '5', '10', '3000'),
      fill(60, 'A', '15', '15', '3100', { closedPnl: '1500', fee: '2' }),
    ];
    const input = replayInput(fills);
    const outcome = await simulateReplay(input);
    expect(outcome.decisions.map((decision) => decision.action)).toEqual([
      'OPEN',
      'INCREASE',
      'CLOSE',
    ]);
    const [copy] = outcome.copies;
    expect(copy).toMatchObject({ isOpen: false, closeReason: 'leader_closed' });
    expect(copy.size.toFixed()).toBe('0');
    expect(copy.orders).toHaveLength(3);
    expect(copy.orders[0].averagePrice?.toFixed(4)).toBe('3001.0201');
    expect(copy.fundingUsd.toFixed()).toBe('-0.225045');
    const report = buildReplayReport(input, outcome, false, new Date(START));
    expect(report.label).toBe('replay');
    expect(report.closedCopies.matchedEpisodes).toBe(1);
    expect(report.closedCopies.scaledLeaderPnlUsd).toBe('74.85');
    expect(Number(report.closedCopies.copyPnlUsd)).toBeLessThan(74.85);
    const gap = report.closedCopies.gap;
    const parts = [
      gap.entryDrift,
      gap.exitDrift,
      gap.feeDifference,
      gap.funding,
      gap.residual,
    ].reduce((total, part) => total.plus(part), new Decimal(0));
    expect(parts.toFixed(2)).toBe(gap.totalGap);
    const markdown = renderReplayMarkdown(report);
    expect(markdown).toContain('replay, 2026-04-01 to 2026-04-03');
    expect(markdown).toContain('None of it is a paper or a live result.');
    expect(markdown).toContain('| Info endpoint | http://127.0.0.1:3030 |');
  });

  it('closes a copy on a candle that crosses its stop', async () => {
    const fills = [fill(1, 'B', '10', '0', '3000')];
    const outcome = await simulateReplay(
      replayInput(fills, [candle(15, '2000', '3010')]),
    );
    const [copy] = outcome.copies;
    expect(copy).toMatchObject({ isOpen: false, closeReason: 'stop_loss' });
    expect(copy.orders.at(-1)?.purpose).toBe('STOP');
  });

  it('never copies an episode that began before the window', async () => {
    const outcome = await simulateReplay(
      replayInput([fill(1, 'A', '5', '20', '3000')]),
    );
    expect(outcome.copies).toHaveLength(0);
    expect(outcome.decisions[0].reason).toBe('position_not_copied');
  });

  it('rejects entries without a leader equity point before them', async () => {
    const input = {
      ...replayInput([fill(1, 'B', '10', '0', '3000')]),
      equity: [],
    };
    const outcome = await simulateReplay(input);
    expect(outcome.decisions[0].reason).toBe('leader_equity_stale');
  });
});

describe('ReplayRun', () => {
  it('reads every fill page in exchange order and keeps main-dex perps only', async () => {
    const closing = fill(1, 'B', '1610', '-1610', '1.88', { tid: 5 });
    const partial = fill(1, 'B', '1577.2', '-3187.2', '1.88', { tid: 9 });
    const hip3 = fill(2, 'B', '1', '0', '10', { coin: 'xyz:MU' });
    const firstPage = [
      partial,
      closing,
      ...Array.from({ length: 1_998 }, (_, index) =>
        fill(3 + index / 1_000, 'B', '0.1', '0', '3000'),
      ),
    ];
    const meta: MetaAndAssetCtxs = [
      {
        universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }],
      },
      [
        {
          funding: '0',
          openInterest: '0',
          prevDayPx: '3000',
          dayNtlVlm: '0',
          premium: '0',
          oraclePx: '3000',
          markPx: '3000',
          midPx: '3000',
          impactPxs: null,
          dayBaseVlm: '0',
        },
      ],
    ] as unknown as MetaAndAssetCtxs;
    const userFillsByTime = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([firstPage.at(-1), hip3]);
    const infoClient = {
      metaAndAssetCtxs: vi.fn().mockResolvedValue(meta),
      userFillsByTime,
      candleSnapshot: vi.fn().mockResolvedValue([]),
      fundingHistory: vi.fn().mockResolvedValue([]),
      portfolio: vi.fn().mockResolvedValue([]),
    } as unknown as HyperliquidInfoClient;
    const values: Record<string, unknown> = {
      TAKER_FEE_BPS: 4.5,
      STOP_LOSS_ALLOCATION_SHARE: 0.2,
      STOP_MAX_DISTANCE: 0.25,
      LIVE_ALLOCATION_USD: 5_000,
      SHADOW_ALLOCATION_USD: 5_000,
      MAX_EXCHANGE_LEVERAGE: 5,
    };
    const config = {
      getOrThrow: (key: string) => values[key] ?? 1,
    } as unknown as ConfigService<ServerConfig, true>;
    const { input, isTruncated } = await new ReplayRun(infoClient, config).run({
      wallet: WALLET,
      days: 2,
      allocationUsd: 2_500,
      latencyMs: 1_200,
      driftBps: 2,
      end: new Date(START + 2 * 86_400_000),
    });
    expect(userFillsByTime).toHaveBeenCalledTimes(2);
    expect(userFillsByTime.mock.calls[1][1]).toBe(firstPage.at(-1)?.time);
    expect(input.fills).toHaveLength(2_000);
    expect(input.fills.slice(0, 2).map((entry) => entry.tid)).toEqual([9, 5]);
    expect(input.settings.shadowAllocationUsd.toFixed()).toBe('2500');
    expect(isTruncated).toBe(false);
  });
});
