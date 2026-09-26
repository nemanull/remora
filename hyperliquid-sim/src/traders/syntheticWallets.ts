import { createHash } from 'node:crypto';
import type { SimCoin } from '../market/syntheticMarket';
import {
  createRandom,
  pickWeighted,
  randomBetween,
  randomInteger,
  randomLogBetween,
  shuffle,
  type Random,
} from '../random';
import {
  TRADER_PROFILES,
  YOUNG_HISTORY_DAYS,
  expectedDailyTurnover,
  type Range,
  type TraderProfile,
} from './traderProfiles';

const DAY_MS = 86_400_000;
const FORCED_LIQUIDATION_DAYS: Range = [2, 28];
const VAULT_NAMES = [
  'Basis Capture',
  'Trend Desk',
  'Mean Reversion',
  'Majors Momentum',
  'Funding Harvest',
  'Volatility Carry',
  'Delta Swing',
  'Macro Perps',
];

export type SyntheticWallet = {
  index: number;
  address: string;
  profile: TraderProfile;
  hasEdge: boolean;
  skill: number;
  dailyDrift: number;
  dailyVolatility: number;
  createdAt: number;
  initialDepositUsd: number;
  positionShare: number;
  leverage: number;
  makerShare: number;
  turnoverPerDay: number;
  laneCoins: string[][];
  laneOffsetsMs: number[];
  crashDay: number | null;
  forcedLiquidationAt: number | null;
  vaultName: string | null;
  vaultLeader: string | null;
};

export function deriveAddress(...parts: (string | number)[]): string {
  const digest = createHash('sha256')
    .update(['copy-quant-sim', ...parts].join(':'))
    .digest('hex');
  return `0x${digest.slice(0, 40)}`;
}

function countProfiles(walletCount: number): TraderProfile[] {
  const counts = TRADER_PROFILES.map((profile) =>
    Math.round(profile.populationShare * walletCount),
  );
  const largest = counts.indexOf(Math.max(...counts));
  counts[largest] +=
    walletCount - counts.reduce((sum, count) => sum + count, 0);
  return TRADER_PROFILES.flatMap((profile, index) =>
    Array.from({ length: Math.max(0, counts[index]) }, () => profile),
  );
}

function pickCoins(
  random: Random,
  coins: readonly SimCoin[],
  count: number,
): string[] {
  const available = coins.filter(
    (coin) => !coin.onlyIsolated || random() < 0.08,
  );
  const picked: string[] = [];
  while (picked.length < count && available.length > 0) {
    const coin = pickWeighted(random, available, (item) => item.popularity);
    picked.push(coin.name);
    available.splice(available.indexOf(coin), 1);
  }
  return picked;
}

function splitIntoLanes(coins: string[], laneCount: number): string[][] {
  const lanes = Math.max(1, Math.min(laneCount, coins.length));
  return Array.from({ length: lanes }, (_, lane) =>
    coins.filter((_, index) => index % lanes === lane),
  );
}

export function createSyntheticWallets(
  seed: number,
  walletCount: number,
  startedAt: number,
  coins: readonly SimCoin[],
): SyntheticWallet[] {
  const profiles = shuffle(
    createRandom(seed, 'population'),
    countProfiles(walletCount),
  );
  const edgeRanks = new Map<number, number>();
  for (const profile of TRADER_PROFILES) {
    const members = profiles
      .map((member, index) => ({ member, index }))
      .filter(({ member }) => member === profile)
      .map(({ index }) => index);
    shuffle(createRandom(seed, 'edge', profile.name), members).forEach(
      (index, rank) => edgeRanks.set(index, rank),
    );
  }
  return profiles.map((profile, index) => {
    const random = createRandom(seed, 'wallet', index);
    const memberCount = profiles.filter((member) => member === profile).length;
    const hasEdge =
      (edgeRanks.get(index) ?? 0) < Math.round(profile.edgeShare * memberCount);
    const isYoung = !hasEdge && random() < profile.youngShare;
    const historyDays = randomBetween(
      random,
      ...(isYoung ? YOUNG_HISTORY_DAYS : profile.historyDays),
    );
    const createdAt = Math.floor(startedAt - historyDays * DAY_MS);
    const pickedCoins = pickCoins(
      random,
      coins,
      randomInteger(
        random,
        profile.coinsPerWallet[0],
        profile.coinsPerWallet[1],
      ),
    );
    const laneCoins = splitIntoLanes(pickedCoins, profile.lanes);
    const positionShare = randomBetween(random, ...profile.positionShare);
    const slotMs = profile.slotMinutes * 60_000;
    const crashDay =
      random() < profile.crashShare
        ? Math.floor(randomBetween(random, 10, Math.max(11, historyDays - 35)))
        : null;
    const forcedLiquidationAt =
      profile.liquidationChance > 0
        ? Math.floor(
            startedAt -
              randomBetween(random, ...FORCED_LIQUIDATION_DAYS) * DAY_MS,
          )
        : null;
    const isVault = profile.name === 'vault';
    return {
      index,
      address: deriveAddress(seed, 'wallet', index),
      profile,
      hasEdge,
      skill: hasEdge ? randomBetween(random, ...profile.skill) : 0,
      dailyDrift: randomBetween(
        random,
        ...(hasEdge ? profile.edgeDrift : profile.baseDrift),
      ),
      dailyVolatility: randomBetween(random, ...profile.dailyVolatility),
      createdAt,
      initialDepositUsd:
        randomLogBetween(random, ...profile.accountValueUsd) *
        randomBetween(random, 0.5, 0.9),
      positionShare,
      leverage: randomInteger(random, profile.leverage[0], profile.leverage[1]),
      makerShare: randomBetween(random, ...profile.makerShare),
      turnoverPerDay: expectedDailyTurnover(
        profile,
        laneCoins.length,
        positionShare,
      ),
      laneCoins,
      laneOffsetsMs: laneCoins.map(() => Math.floor(random() * slotMs)),
      crashDay,
      forcedLiquidationAt,
      vaultName: isVault
        ? `${VAULT_NAMES[index % VAULT_NAMES.length]} ${index}`
        : null,
      vaultLeader: isVault ? deriveAddress(seed, 'vault-leader', index) : null,
    };
  });
}
