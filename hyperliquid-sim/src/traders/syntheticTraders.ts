import type { HyperliquidFill, NonFundingLedgerUpdate } from '@remora/sdk';
import { createHash } from 'node:crypto';
import {
  BOOK_HALF_SPREAD,
  BOOK_LEVEL_STEP,
  priceAwayFromMid,
  type SyntheticMarket,
} from '../market/syntheticMarket';
import {
  createRandom,
  hashUnit,
  permuteInteger,
  pickWeighted,
  randomBetween,
  randomInteger,
  type Random,
} from '../random';
import { formatLots, formatPrice, formatUsd } from '../wireFormat';
import type { SyntheticHistory } from './syntheticHistory';
import type { SyntheticWallet } from './syntheticWallets';

const TAKER_FEE_RATE = 0.00045;
const MAKER_FEE_RATE = 0.00015;
const MIN_ORDER_USD = 10;
const SLOT_INDEX_OFFSET = 2 ** 20;
const ORDERS_PER_SLOT = 64;
const FILLS_PER_ORDER_KEY = 32;
const LANE_KEY_SPACE = 4;
const MAX_CACHED_EPISODES = 1_000;
const LIQUIDATION_SAMPLES = 60;

export const SNAPSHOT_FILL_LIMIT = 30;
export const FILL_HORIZON = 10_000;
export const FILLS_PAGE_LIMIT = 2_000;

export type SimOrder = {
  wallet: string;
  coin: string;
  time: number;
  oid: number;
  lane: number;
  sequence: number;
  isLiquidation: boolean;
  fills: HyperliquidFill[];
  lotsAfter: number;
  entryPxAfter: number;
};

export type SimLiquidation = {
  time: number;
  coin: string;
  szi: number;
  notionalUsd: number;
  hash: string;
};

export type SimPosition = {
  wallet: string;
  coin: string;
  szDecimals: number;
  lots: number;
  entryPx: number;
  leverage: number;
  liquidationPx: number | null;
  isIsolated: boolean;
};

type Episode = {
  orders: SimOrder[];
  liquidation: SimLiquidation | null;
  liquidationPx: number | null;
};

type PlannedOrder = {
  time: number;
  kind: 'open' | 'scaleIn' | 'trim' | 'close' | 'finalClose' | 'liquidation';
  share: number;
};

type PositionState = { lots: number; entryPx: number };

const EMPTY_EPISODE: Episode = {
  orders: [],
  liquidation: null,
  liquidationPx: null,
};

function directionOf(startLots: number, endLots: number): string {
  if (startLots === 0) {
    return endLots > 0 ? 'Open Long' : 'Open Short';
  }
  if (startLots > 0) {
    if (endLots > startLots) {
      return 'Open Long';
    }
    return endLots >= 0 ? 'Close Long' : 'Long > Short';
  }
  if (endLots < startLots) {
    return 'Open Short';
  }
  return endLots <= 0 ? 'Close Short' : 'Short > Long';
}

function splitLots(random: Random, lots: number, parts: number): number[] {
  const count = Math.max(1, Math.min(parts, lots));
  const weights = Array.from({ length: count }, () => 0.2 + random());
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sizes = weights.map((weight) =>
    Math.max(1, Math.floor((lots * weight) / total)),
  );
  let excess = sizes.reduce((sum, size) => sum + size, 0) - lots;
  for (
    let index = sizes.length - 1;
    excess !== 0;
    index = (index + sizes.length - 1) % sizes.length
  ) {
    if (excess > 0 && sizes[index] > 1) {
      sizes[index] -= 1;
      excess -= 1;
    } else if (excess < 0) {
      sizes[index] += 1;
      excess += 1;
    }
  }
  return sizes;
}

function mergeOrders(lanes: SimOrder[][]): SimOrder[] {
  return lanes
    .flat()
    .sort(
      (left, right) =>
        left.time - right.time ||
        left.lane - right.lane ||
        left.sequence - right.sequence,
    );
}

export class SyntheticTraders {
  private readonly byAddress: Map<string, SyntheticWallet>;
  private readonly episodes = new Map<string, Episode>();
  private readonly permutationKey: number;

  constructor(
    private readonly seed: number,
    private readonly speed: number,
    readonly startedAt: number,
    readonly wallets: readonly SyntheticWallet[],
    private readonly market: SyntheticMarket,
    private readonly history: SyntheticHistory,
  ) {
    this.byAddress = new Map(wallets.map((wallet) => [wallet.address, wallet]));
    this.permutationKey = Math.floor(hashUnit(seed, 'permutation') * 2 ** 31);
  }

  findWallet(address: string): SyntheticWallet | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  readFillsBetween(
    wallet: SyntheticWallet,
    from: number,
    to: number,
  ): HyperliquidFill[] {
    return this.readOrdersBetween(wallet, from - 1, to).flatMap(
      (order) => order.fills,
    );
  }

  readOrdersBetween(
    wallet: SyntheticWallet,
    afterTime: number,
    untilTime: number,
  ): SimOrder[] {
    if (untilTime <= afterTime) {
      return [];
    }
    return mergeOrders(
      wallet.laneCoins.map((_, lane) => {
        const orders: SimOrder[] = [];
        const lastSlot = this.findSlotIndexAt(wallet, lane, untilTime);
        for (
          let slot = this.findSlotIndexAt(
            wallet,
            lane,
            Math.max(afterTime, wallet.createdAt),
          );
          slot <= lastSlot;
          slot += 1
        ) {
          for (const order of this.readEpisode(wallet, lane, slot).orders) {
            if (order.time > afterTime && order.time <= untilTime) {
              orders.push(order);
            }
          }
        }
        return orders;
      }),
    );
  }

  readRecentFills(
    wallet: SyntheticWallet,
    since: number,
    until: number,
    limit: number,
  ): HyperliquidFill[] {
    const lanes = wallet.laneCoins.map((_, lane) => {
      const orders: SimOrder[] = [];
      let fillCount = 0;
      for (
        let slot = this.findSlotIndexAt(wallet, lane, until);
        fillCount < limit &&
        this.readSlotStart(wallet, lane, slot + 1) >
          Math.max(since, wallet.createdAt);
        slot -= 1
      ) {
        const episode = this.readEpisode(wallet, lane, slot).orders;
        for (let index = episode.length - 1; index >= 0; index -= 1) {
          const order = episode[index];
          if (order.time <= until && order.time >= since) {
            orders.push(order);
            fillCount += order.fills.length;
          }
        }
      }
      return orders;
    });
    const fills = mergeOrders(lanes).flatMap((order) => order.fills);
    return fills.slice(Math.max(0, fills.length - limit));
  }

  readPositions(wallet: SyntheticWallet, time: number): SimPosition[] {
    const positions: SimPosition[] = [];
    wallet.laneCoins.forEach((_, lane) => {
      const episode = this.readEpisode(
        wallet,
        lane,
        this.findSlotIndexAt(wallet, lane, time),
      );
      const last = episode.orders.filter((order) => order.time <= time).at(-1);
      const coin = last ? this.market.findCoin(last.coin) : undefined;
      if (!last || !coin || last.lotsAfter === 0) {
        return;
      }
      const leverage = Math.min(wallet.leverage, coin.maxLeverage);
      const side = last.lotsAfter > 0 ? 1 : -1;
      const formulaPx = last.entryPxAfter * (1 - (side * 0.9) / leverage);
      positions.push({
        wallet: wallet.address,
        coin: coin.name,
        szDecimals: coin.szDecimals,
        lots: last.lotsAfter,
        entryPx: last.entryPxAfter,
        leverage,
        liquidationPx:
          episode.liquidationPx ?? (formulaPx > 0 ? formulaPx : null),
        isIsolated: coin.onlyIsolated === true,
      });
    });
    return positions;
  }

  readLedgerUpdates(
    wallet: SyntheticWallet,
    startTime: number,
    endTime: number,
  ): NonFundingLedgerUpdate[] {
    const updates: { time: number; update: NonFundingLedgerUpdate }[] = [];
    for (const flow of this.history.readFlows(wallet, startTime, endTime)) {
      const usdc = formatUsd(Math.abs(flow.usdc));
      const hash = this.hashOf('flow', wallet.index, flow.time);
      updates.push({
        time: flow.time,
        update: {
          time: flow.time,
          hash,
          delta:
            flow.usdc >= 0
              ? { type: 'deposit', usdc }
              : ({
                  type: 'withdraw',
                  usdc,
                  nonce: flow.time,
                  fee: '1.0',
                } as NonFundingLedgerUpdate['delta']),
        },
      });
    }
    for (const liquidation of this.readLiquidations(
      wallet,
      startTime,
      endTime,
    )) {
      updates.push({
        time: liquidation.time,
        update: {
          time: liquidation.time,
          hash: liquidation.hash,
          delta: {
            type: 'liquidation',
            liquidatedNtlPos: formatUsd(liquidation.notionalUsd),
            accountValue: formatUsd(
              this.history.readEquityAt(wallet, liquidation.time),
            ),
            leverageType: 'Cross',
            liquidatedPositions: [
              { coin: liquidation.coin, szi: String(liquidation.szi) },
            ],
          } as NonFundingLedgerUpdate['delta'],
        },
      });
    }
    return updates
      .sort((left, right) => left.time - right.time)
      .map(({ update }) => update);
  }

  readLiquidations(
    wallet: SyntheticWallet,
    from: number,
    to: number,
  ): SimLiquidation[] {
    if (wallet.profile.liquidationChance <= 0) {
      return [];
    }
    const liquidations: SimLiquidation[] = [];
    wallet.laneCoins.forEach((_, lane) => {
      const lastSlot = this.findSlotIndexAt(wallet, lane, to);
      for (
        let slot = this.findSlotIndexAt(
          wallet,
          lane,
          Math.max(from, wallet.createdAt),
        );
        slot <= lastSlot;
        slot += 1
      ) {
        const liquidation = this.readEpisode(wallet, lane, slot).liquidation;
        if (liquidation && liquidation.time >= from && liquidation.time <= to) {
          liquidations.push(liquidation);
        }
      }
    });
    return liquidations.sort((left, right) => left.time - right.time);
  }

  findSlotIndexAt(wallet: SyntheticWallet, lane: number, time: number): number {
    const tradingTime =
      time < this.startedAt
        ? time
        : this.startedAt + (time - this.startedAt) * this.speed;
    const origin = this.startedAt + wallet.laneOffsetsMs[lane];
    return Math.floor(
      (tradingTime - origin) / (wallet.profile.slotMinutes * 60_000),
    );
  }

  readSlotStart(wallet: SyntheticWallet, lane: number, slot: number): number {
    const tradingTime =
      this.startedAt +
      wallet.laneOffsetsMs[lane] +
      slot * wallet.profile.slotMinutes * 60_000;
    return tradingTime < this.startedAt
      ? tradingTime
      : this.startedAt + Math.ceil((tradingTime - this.startedAt) / this.speed);
  }

  private readEpisode(
    wallet: SyntheticWallet,
    lane: number,
    slot: number,
  ): Episode {
    const key = `${wallet.index}:${lane}:${slot}`;
    const cached = this.episodes.get(key);
    if (cached) {
      return cached;
    }
    const episode = this.generateEpisode(wallet, lane, slot);
    this.episodes.set(key, episode);
    if (this.episodes.size > MAX_CACHED_EPISODES) {
      const oldest = this.episodes.keys().next().value;
      if (oldest !== undefined) {
        this.episodes.delete(oldest);
      }
    }
    return episode;
  }

  private generateEpisode(
    wallet: SyntheticWallet,
    lane: number,
    slot: number,
  ): Episode {
    const start = this.readSlotStart(wallet, lane, slot);
    const end = this.readSlotStart(wallet, lane, slot + 1);
    if (start < wallet.createdAt) {
      return EMPTY_EPISODE;
    }
    const random = createRandom(this.seed, 'slot', wallet.index, lane, slot);
    const isForcedLiquidation =
      lane === 0 &&
      wallet.forcedLiquidationAt !== null &&
      wallet.forcedLiquidationAt >= start &&
      wallet.forcedLiquidationAt < end;
    if (!isForcedLiquidation && random() >= wallet.profile.episodeChance) {
      return EMPTY_EPISODE;
    }
    const profile = wallet.profile;
    const length = end - start;
    const coinName = pickWeighted(
      random,
      wallet.laneCoins[lane],
      (name) => this.market.findCoin(name)?.popularity ?? 1,
    );
    const coin = this.market.findCoin(coinName);
    if (!coin) {
      return EMPTY_EPISODE;
    }
    const openAt = Math.floor(
      start + length * randomBetween(random, ...profile.openDelayShare),
    );
    let closeAt = Math.floor(
      Math.min(
        openAt + length * randomBetween(random, ...profile.holdShare),
        end - length * 0.05,
      ),
    );
    const isLiquidated =
      isForcedLiquidation || random() < profile.liquidationChance;
    const marketMove =
      this.market.readMidAt(coinName, closeAt) -
      this.market.readMidAt(coinName, openAt);
    const profitableSide = marketMove >= 0 ? 1 : -1;
    const roll = random();
    let side: 1 | -1;
    if (isLiquidated) {
      side = profitableSide === 1 ? -1 : 1;
    } else if (wallet.skill > 0) {
      side =
        roll < 0.5 + wallet.skill
          ? profitableSide
          : profitableSide === 1
            ? -1
            : 1;
    } else {
      side = roll < 0.5 ? 1 : -1;
    }
    let liquidationPx: number | null = null;
    if (isLiquidated) {
      closeAt = this.findWorstTime(coinName, side, openAt, closeAt);
      liquidationPx = this.market.readMidAt(coinName, closeAt);
    }
    const plan = this.planOrders(
      random,
      wallet,
      openAt,
      closeAt,
      end,
      isLiquidated,
    );
    const targetNotional =
      this.history.readEquityAt(wallet, openAt) *
      wallet.positionShare *
      randomBetween(random, 0.7, 1.3);
    const position: PositionState = { lots: 0, entryPx: 0 };
    const orders: SimOrder[] = [];
    let liquidation: SimLiquidation | null = null;
    const scale = 10 ** coin.szDecimals;
    for (const planned of plan) {
      const mid = this.market.readMidAt(coinName, planned.time);
      let lots = 0;
      let isBuy = side === 1;
      if (planned.kind === 'open' || planned.kind === 'scaleIn') {
        lots = Math.floor(((targetNotional * planned.share) / mid) * scale);
        const minimumLots = Math.ceil(((MIN_ORDER_USD * 1.05) / mid) * scale);
        if (planned.kind === 'open' || position.lots !== 0) {
          lots = Math.max(lots, minimumLots);
        } else {
          lots = 0;
        }
      } else if (position.lots !== 0) {
        isBuy = position.lots < 0;
        const held = Math.abs(position.lots);
        if (planned.kind === 'trim') {
          lots = Math.floor(held * planned.share);
          if (lots >= held || (lots / scale) * mid < MIN_ORDER_USD) {
            lots = 0;
          }
        } else if (planned.kind === 'close' && planned.share > 1) {
          lots = held + Math.max(1, Math.floor(held * (planned.share - 1)));
        } else {
          lots = held;
        }
      }
      if (lots <= 0) {
        continue;
      }
      const startLots = position.lots;
      const order = this.buildOrder({
        random,
        wallet,
        lane,
        slot,
        sequence: orders.length,
        coinName,
        szDecimals: coin.szDecimals,
        time: planned.time,
        mid,
        isBuy,
        lots,
        isLiquidation: planned.kind === 'liquidation',
        position,
      });
      orders.push(order);
      if (planned.kind === 'liquidation') {
        liquidation = {
          time: planned.time,
          coin: coinName,
          szi: startLots / scale,
          notionalUsd: (Math.abs(startLots) / scale) * mid,
          hash: order.fills[0].hash,
        };
      }
    }
    return { orders, liquidation, liquidationPx };
  }

  private planOrders(
    random: Random,
    wallet: SyntheticWallet,
    openAt: number,
    closeAt: number,
    end: number,
    isLiquidated: boolean,
  ): PlannedOrder[] {
    const profile = wallet.profile;
    const span = Math.max(closeAt - openAt, 10);
    const scaleIns = randomInteger(
      random,
      profile.scaleIns[0],
      profile.scaleIns[1],
    );
    const trims = randomInteger(random, profile.trims[0], profile.trims[1]);
    const openShare = scaleIns === 0 ? 1 : randomBetween(random, 0.35, 0.7);
    const plan: PlannedOrder[] = [
      { time: openAt, kind: 'open', share: openShare },
    ];
    for (let index = 0; index < scaleIns; index += 1) {
      plan.push({
        time: Math.floor(openAt + span * randomBetween(random, 0.02, 0.6)),
        kind: 'scaleIn',
        share: (1 - openShare) / scaleIns,
      });
    }
    for (let index = 0; index < trims; index += 1) {
      plan.push({
        time: Math.floor(openAt + span * randomBetween(random, 0.3, 0.97)),
        kind: 'trim',
        share: randomBetween(random, 0.05, 0.5),
      });
    }
    const isFlip = !isLiquidated && random() < profile.flipChance;
    if (isLiquidated) {
      plan.push({ time: closeAt, kind: 'liquidation', share: 1 });
    } else if (isFlip) {
      plan.push({
        time: closeAt,
        kind: 'close',
        share: randomBetween(random, 1.3, 2),
      });
      plan.push({
        time: Math.floor(closeAt + (end - closeAt) * 0.5),
        kind: 'finalClose',
        share: 1,
      });
    } else {
      plan.push({ time: closeAt, kind: 'close', share: 1 });
    }
    const ordered = plan.sort((left, right) => left.time - right.time);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].time <= ordered[index - 1].time) {
        ordered[index].time = ordered[index - 1].time + 1;
      }
    }
    return ordered;
  }

  private findWorstTime(
    coinName: string,
    side: 1 | -1,
    from: number,
    to: number,
  ): number {
    let worstTime = to;
    let worstValue = Number.POSITIVE_INFINITY;
    for (let index = 1; index <= LIQUIDATION_SAMPLES; index += 1) {
      const time = Math.floor(
        from + ((to - from) * index) / LIQUIDATION_SAMPLES,
      );
      const value = side * this.market.readMidAt(coinName, time);
      if (value < worstValue) {
        worstValue = value;
        worstTime = time;
      }
    }
    return worstTime;
  }

  private buildOrder(input: {
    random: Random;
    wallet: SyntheticWallet;
    lane: number;
    slot: number;
    sequence: number;
    coinName: string;
    szDecimals: number;
    time: number;
    mid: number;
    isBuy: boolean;
    lots: number;
    isLiquidation: boolean;
    position: PositionState;
  }): SimOrder {
    const { random, wallet, szDecimals, mid, isBuy, position } = input;
    const scale = 10 ** szDecimals;
    const isMaker = !input.isLiquidation && random() < wallet.makerShare;
    const fillCount = isMaker
      ? randomInteger(random, 1, 2)
      : randomInteger(
          random,
          wallet.profile.fillsPerOrder[0],
          wallet.profile.fillsPerOrder[1],
        );
    const parts = splitLots(random, input.lots, fillCount);
    const orderKey =
      ((wallet.index * LANE_KEY_SPACE + input.lane) * 2 * SLOT_INDEX_OFFSET +
        (input.slot + SLOT_INDEX_OFFSET)) *
        ORDERS_PER_SLOT +
      input.sequence;
    const oid =
      100_000_000_000 + permuteInteger(orderKey, 20, this.permutationKey);
    const hash = this.hashOf('order', orderKey);
    let level = 0;
    const fills = parts.map((partLots, index): HyperliquidFill => {
      if (!isMaker && index > 0 && random() < 0.45) {
        level += 1;
      }
      const share = BOOK_HALF_SPREAD + level * BOOK_LEVEL_STEP;
      const fillPrice = isMaker
        ? priceAwayFromMid(mid, szDecimals, !isBuy, share)
        : priceAwayFromMid(mid, szDecimals, isBuy, share);
      const startLots = position.lots;
      const signed = isBuy ? partLots : -partLots;
      const endLots = startLots + signed;
      const closedLots =
        startLots !== 0 && Math.sign(signed) !== Math.sign(startLots)
          ? Math.min(partLots, Math.abs(startLots))
          : 0;
      const closedPnl =
        closedLots === 0
          ? 0
          : (fillPrice - position.entryPx) *
            (closedLots / scale) *
            Math.sign(startLots);
      if (startLots === 0 || Math.sign(signed) === Math.sign(startLots)) {
        position.entryPx =
          (position.entryPx * Math.abs(startLots) + fillPrice * partLots) /
          Math.abs(endLots);
      } else if (endLots === 0) {
        position.entryPx = 0;
      } else if (Math.sign(endLots) !== Math.sign(startLots)) {
        position.entryPx = fillPrice;
      }
      position.lots = endLots;
      const fillKey = orderKey * FILLS_PER_ORDER_KEY + index;
      const size = partLots / scale;
      return {
        coin: input.coinName,
        px: formatPrice(fillPrice, szDecimals),
        sz: formatLots(partLots, szDecimals),
        side: isBuy ? 'B' : 'A',
        time: input.time,
        startPosition: formatLots(startLots, szDecimals),
        dir: directionOf(startLots, endLots),
        closedPnl: formatUsd(closedPnl),
        hash,
        oid,
        crossed: !isMaker,
        fee: formatUsd(
          fillPrice * size * (isMaker ? MAKER_FEE_RATE : TAKER_FEE_RATE),
        ),
        tid: permuteInteger(fillKey, 25, this.permutationKey) + 1,
        ...(input.isLiquidation
          ? {
              liquidation: {
                liquidatedUser: wallet.address,
                markPx: formatPrice(mid, szDecimals),
                method: 'market' as const,
              },
            }
          : {}),
        feeToken: 'USDC',
        twapId: null,
      };
    });
    return {
      wallet: wallet.address,
      coin: input.coinName,
      time: input.time,
      oid,
      lane: input.lane,
      sequence: input.sequence,
      isLiquidation: input.isLiquidation,
      fills,
      lotsAfter: position.lots,
      entryPxAfter: position.entryPx,
    };
  }

  private hashOf(...parts: (string | number)[]): string {
    return `0x${createHash('sha256')
      .update([this.seed, ...parts].join(':'))
      .digest('hex')}`;
  }
}
