import type {
  Candle,
  CandleInterval,
  FundingHistoryItem,
  L2BookLevel,
  L2BookResponse,
  PerpAsset,
  PerpAssetContext,
  PerpMarginMode,
} from '@remora/sdk';
import { createRandom, hashUnit, randomNormal, type Random } from '../random';
import { roundPrice, toWireDecimal } from '../wireFormat';

export type SimCoin = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  startPx: number;
  hourlyVolatility: number;
  depthUsd: number;
  popularity: number;
  onlyIsolated?: boolean;
  marginMode?: PerpMarginMode;
};

export const SIM_COINS: readonly SimCoin[] = [
  {
    name: 'BTC',
    szDecimals: 5,
    maxLeverage: 40,
    startPx: 84_500,
    hourlyVolatility: 0.0045,
    depthUsd: 400_000,
    popularity: 10,
  },
  {
    name: 'ETH',
    szDecimals: 4,
    maxLeverage: 25,
    startPx: 2_700,
    hourlyVolatility: 0.006,
    depthUsd: 250_000,
    popularity: 8,
  },
  {
    name: 'SOL',
    szDecimals: 2,
    maxLeverage: 20,
    startPx: 140,
    hourlyVolatility: 0.008,
    depthUsd: 120_000,
    popularity: 6,
  },
  {
    name: 'HYPE',
    szDecimals: 2,
    maxLeverage: 10,
    startPx: 30,
    hourlyVolatility: 0.01,
    depthUsd: 80_000,
    popularity: 6,
  },
  {
    name: 'XRP',
    szDecimals: 0,
    maxLeverage: 20,
    startPx: 1.42,
    hourlyVolatility: 0.008,
    depthUsd: 60_000,
    popularity: 4,
  },
  {
    name: 'DOGE',
    szDecimals: 0,
    maxLeverage: 10,
    startPx: 0.17,
    hourlyVolatility: 0.009,
    depthUsd: 40_000,
    popularity: 3,
  },
  {
    name: 'AVAX',
    szDecimals: 2,
    maxLeverage: 10,
    startPx: 20,
    hourlyVolatility: 0.009,
    depthUsd: 40_000,
    popularity: 2,
  },
  {
    name: 'LINK',
    szDecimals: 1,
    maxLeverage: 10,
    startPx: 14,
    hourlyVolatility: 0.009,
    depthUsd: 40_000,
    popularity: 2,
  },
  {
    name: 'SUI',
    szDecimals: 1,
    maxLeverage: 10,
    startPx: 2.4,
    hourlyVolatility: 0.011,
    depthUsd: 30_000,
    popularity: 2,
  },
  {
    name: 'ARB',
    szDecimals: 1,
    maxLeverage: 10,
    startPx: 0.35,
    hourlyVolatility: 0.011,
    depthUsd: 20_000,
    popularity: 1,
  },
  {
    name: 'NEAR',
    szDecimals: 1,
    maxLeverage: 10,
    startPx: 4.8,
    hourlyVolatility: 0.011,
    depthUsd: 20_000,
    popularity: 1,
  },
  {
    name: 'kPEPE',
    szDecimals: 0,
    maxLeverage: 10,
    startPx: 0.009,
    hourlyVolatility: 0.013,
    depthUsd: 30_000,
    popularity: 2,
  },
  {
    name: 'JELLY',
    szDecimals: 0,
    maxLeverage: 3,
    startPx: 0.021,
    hourlyVolatility: 0.02,
    depthUsd: 5_000,
    popularity: 0.5,
    onlyIsolated: true,
    marginMode: 'noCross',
  },
];

const GRID_STEP_MS = 300_000;
const POINTS_PER_CHUNK = 288;
const HISTORY_SPAN_MS = 280 * 86_400_000;
const HOUR_MS = 3_600_000;
const BOOK_LEVELS = 20;
export const BOOK_HALF_SPREAD = 0.00005;
export const BOOK_LEVEL_STEP = 0.0001;
const MEAN_REVERSION_PER_STEP = 1 / (60 * POINTS_PER_CHUNK);
const MAX_CANDLES = 5_000;
const MAX_FUNDING_ITEMS = 500;
const MAX_CANDLE_SAMPLES = 48;

const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

type CoinPath = {
  coin: SimCoin;
  random: Random;
  chunks: Float64Array[];
  lastLogPrice: number;
};

export function priceTick(price: number, szDecimals: number): number {
  const decimalTick = 10 ** -(6 - szDecimals);
  const significantTick = 10 ** (Math.floor(Math.log10(price)) - 4);
  return Math.max(decimalTick, significantTick);
}

function tickDecimals(tick: number): number {
  return Math.max(0, -Math.floor(Math.log10(tick) + 1e-9));
}

export function priceAwayFromMid(
  mid: number,
  szDecimals: number,
  isBuy: boolean,
  share: number,
): number {
  const tick = priceTick(mid, szDecimals);
  const raw = isBuy ? mid * (1 + share) : mid * (1 - share);
  const ticks = isBuy
    ? Math.ceil(raw / tick - 1e-9)
    : Math.floor(raw / tick + 1e-9);
  return roundPrice(
    Number((ticks * tick).toFixed(tickDecimals(tick))),
    szDecimals,
  );
}

export class SyntheticMarket {
  readonly coins: readonly SimCoin[] = SIM_COINS;
  private readonly anchor: number;
  private readonly paths = new Map<string, CoinPath>();

  constructor(
    private readonly seed: number,
    readonly startedAt: number,
  ) {
    this.anchor =
      Math.floor((startedAt - HISTORY_SPAN_MS) / GRID_STEP_MS) * GRID_STEP_MS;
    for (const coin of this.coins) {
      this.paths.set(coin.name, {
        coin,
        random: createRandom(seed, 'market', coin.name),
        chunks: [],
        lastLogPrice: Math.log(coin.startPx),
      });
    }
  }

  findCoin(name: string): SimCoin | undefined {
    return this.paths.get(name)?.coin;
  }

  readMidAt(coinName: string, time: number): number {
    const path = this.readPath(coinName);
    const position = Math.max(0, (time - this.anchor) / GRID_STEP_MS);
    const index = Math.floor(position);
    const fraction = position - index;
    const logPrice =
      this.readLogPrice(path, index) * (1 - fraction) +
      this.readLogPrice(path, index + 1) * fraction;
    const jitter =
      (hashUnit(this.seed, 'jitter', coinName, Math.floor(time / 1_000)) -
        0.5) *
      path.coin.hourlyVolatility *
      0.04;
    return Math.exp(logPrice + jitter);
  }

  readMids(time: number): Record<string, string> {
    const mids: Record<string, string> = {};
    for (const coin of this.coins) {
      const mid = this.readMidAt(coin.name, time);
      mids[coin.name] = toWireDecimal(Number(mid.toPrecision(6)), 7);
    }
    return mids;
  }

  readBook(coinName: string, time: number): L2BookResponse {
    const coin = this.readPath(coinName).coin;
    const mid = this.readMidAt(coinName, time);
    const tick = priceTick(mid, coin.szDecimals);
    const decimals = tickDecimals(tick);
    const halfSpreadTicks = Math.max(
      1,
      Math.round((mid * BOOK_HALF_SPREAD) / tick),
    );
    const stepTicks = Math.max(1, Math.round((mid * BOOK_LEVEL_STEP) / tick));
    const midTicks = mid / tick;
    const bestBid = Math.floor(midTicks) - halfSpreadTicks + 1;
    const bestAsk = Math.max(
      Math.ceil(midTicks) + halfSpreadTicks - 1,
      bestBid + 1,
    );
    const bookSecond = Math.floor(time / 2_000);
    const levelsFor = (isBid: boolean): L2BookLevel[] =>
      Array.from({ length: BOOK_LEVELS }, (_, level) => {
        const ticks = isBid
          ? bestBid - level * stepTicks
          : bestAsk + level * stepTicks;
        const price = Number((ticks * tick).toFixed(decimals));
        const variation = hashUnit(
          this.seed,
          'book',
          coinName,
          bookSecond,
          isBid ? 'bid' : 'ask',
          level,
        );
        const notional =
          coin.depthUsd * (0.25 + level * 0.12) * (0.6 + 0.8 * variation);
        const lots = Math.max(
          1,
          Math.floor((notional / price) * 10 ** coin.szDecimals),
        );
        return {
          px: toWireDecimal(price, decimals),
          sz: toWireDecimal(lots / 10 ** coin.szDecimals, coin.szDecimals),
          n: 1 + Math.floor(variation * 12),
        };
      });
    return {
      coin: coinName,
      time,
      levels: [levelsFor(true), levelsFor(false)],
    };
  }

  readFundingRate(coinName: string): number {
    this.readPath(coinName);
    return (
      0.00001 +
      Math.round(hashUnit(this.seed, 'funding', coinName) * 4) * 0.0000025
    );
  }

  readFundingHistory(
    coinName: string,
    startTime: number,
    endTime: number,
  ): FundingHistoryItem[] {
    const rate = this.readFundingRate(coinName);
    const items: FundingHistoryItem[] = [];
    const firstHour =
      Math.ceil(Math.max(startTime, this.anchor) / HOUR_MS) * HOUR_MS;
    for (
      let time = firstHour;
      time <= endTime && items.length < MAX_FUNDING_ITEMS;
      time += HOUR_MS
    ) {
      items.push({
        coin: coinName,
        fundingRate: toWireDecimal(rate, 8),
        premium: toWireDecimal(rate * 0.4, 8),
        time,
      });
    }
    return items;
  }

  readCandles(
    coinName: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
    now: number,
  ): Candle[] {
    const coin = this.readPath(coinName).coin;
    const bucketMs = CANDLE_INTERVAL_MS[interval];
    const lastTime = Math.min(endTime, now);
    const firstBucket =
      Math.floor(Math.max(startTime, this.anchor) / bucketMs) * bucketMs;
    const lastBucket = Math.floor(lastTime / bucketMs) * bucketMs;
    if (lastBucket < firstBucket) {
      return [];
    }
    const bucketCount = Math.floor((lastBucket - firstBucket) / bucketMs) + 1;
    const startBucket =
      firstBucket + Math.max(0, bucketCount - MAX_CANDLES) * bucketMs;
    const candles: Candle[] = [];
    for (let open = startBucket; open <= lastBucket; open += bucketMs) {
      const close = Math.min(open + bucketMs - 1, lastTime);
      const samples = Math.min(
        MAX_CANDLE_SAMPLES,
        Math.max(2, Math.ceil((close - open) / GRID_STEP_MS) + 1),
      );
      const prices = Array.from({ length: samples }, (_, index) =>
        this.readMidAt(
          coinName,
          open + ((close - open) * index) / (samples - 1),
        ),
      );
      const activity = hashUnit(this.seed, 'volume', coinName, interval, open);
      const notional =
        coin.depthUsd * 40 * (bucketMs / HOUR_MS) * (0.5 + activity);
      const format = (price: number) =>
        toWireDecimal(roundPrice(price, coin.szDecimals), 6 - coin.szDecimals);
      candles.push({
        t: open,
        T: open + bucketMs - 1,
        s: coinName,
        i: interval,
        o: format(prices[0]),
        c: format(prices[prices.length - 1]),
        h: format(Math.max(...prices)),
        l: format(Math.min(...prices)),
        v: toWireDecimal(notional / prices[0], coin.szDecimals),
        n: Math.max(1, Math.round(notional / 2_000)),
      });
    }
    return candles;
  }

  readUniverse(): PerpAsset[] {
    return this.coins.map((coin) => ({
      name: coin.name,
      szDecimals: coin.szDecimals,
      maxLeverage: coin.maxLeverage,
      marginTableId: coin.maxLeverage,
      ...(coin.onlyIsolated ? { onlyIsolated: true } : {}),
      ...(coin.marginMode ? { marginMode: coin.marginMode } : {}),
    }));
  }

  readContexts(time: number): PerpAssetContext[] {
    return this.coins.map((coin) => {
      const mid = this.readMidAt(coin.name, time);
      const previousDay = this.readMidAt(coin.name, time - 86_400_000);
      const funding = this.readFundingRate(coin.name);
      const format = (price: number) =>
        toWireDecimal(roundPrice(price, coin.szDecimals), 6 - coin.szDecimals);
      const dayNotional =
        coin.depthUsd *
        960 *
        (0.5 +
          hashUnit(this.seed, 'day', coin.name, Math.floor(time / 86_400_000)));
      return {
        funding: toWireDecimal(funding, 8),
        openInterest: toWireDecimal(
          (coin.depthUsd * 200) / mid,
          coin.szDecimals,
        ),
        prevDayPx: format(previousDay),
        dayNtlVlm: toWireDecimal(dayNotional, 2),
        premium: toWireDecimal(funding * 0.4, 8),
        oraclePx: format(mid * (1 - funding)),
        markPx: format(mid),
        midPx: format(mid),
        impactPxs: [
          format(priceAwayFromMid(mid, coin.szDecimals, false, 0.0002)),
          format(priceAwayFromMid(mid, coin.szDecimals, true, 0.0002)),
        ],
        dayBaseVlm: toWireDecimal(dayNotional / mid, coin.szDecimals),
      };
    });
  }

  private readPath(coinName: string): CoinPath {
    const path = this.paths.get(coinName);
    if (!path) {
      throw new Error(`Unknown simulated coin ${coinName}`);
    }
    return path;
  }

  private readLogPrice(path: CoinPath, index: number): number {
    const chunkIndex = Math.floor(index / POINTS_PER_CHUNK);
    while (path.chunks.length <= chunkIndex) {
      path.chunks.push(this.generateChunk(path));
    }
    return path.chunks[chunkIndex][index % POINTS_PER_CHUNK];
  }

  private generateChunk(path: CoinPath): Float64Array {
    const chunk = new Float64Array(POINTS_PER_CHUNK);
    const stepVolatility =
      path.coin.hourlyVolatility / Math.sqrt(HOUR_MS / GRID_STEP_MS);
    const center = Math.log(path.coin.startPx);
    let logPrice = path.lastLogPrice;
    for (let index = 0; index < POINTS_PER_CHUNK; index += 1) {
      chunk[index] = logPrice;
      logPrice +=
        stepVolatility * randomNormal(path.random) -
        MEAN_REVERSION_PER_STEP * (logPrice - center);
    }
    path.lastLogPrice = logPrice;
    return chunk;
  }
}
