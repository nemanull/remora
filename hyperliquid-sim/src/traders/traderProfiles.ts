export type TraderProfileName = 'swing' | 'scalper' | 'reckless' | 'vault';

export type Range = readonly [min: number, max: number];

export type TraderProfile = {
  name: TraderProfileName;
  populationShare: number;
  edgeShare: number;
  skill: Range;
  edgeDrift: Range;
  baseDrift: Range;
  dailyVolatility: Range;
  accountValueUsd: Range;
  historyDays: Range;
  youngShare: number;
  lanes: number;
  coinsPerWallet: Range;
  slotMinutes: number;
  episodeChance: number;
  openDelayShare: Range;
  holdShare: Range;
  scaleIns: Range;
  trims: Range;
  flipChance: number;
  positionShare: Range;
  leverage: Range;
  fillsPerOrder: Range;
  makerShare: Range;
  liquidationChance: number;
  crashShare: number;
  flowChancePerDay: number;
};

export const YOUNG_HISTORY_DAYS: Range = [45, 175];

export const TRADER_PROFILES: readonly TraderProfile[] = [
  {
    name: 'swing',
    populationShare: 0.7,
    edgeShare: 0.15,
    skill: [0.12, 0.2],
    edgeDrift: [0.0025, 0.0045],
    baseDrift: [0, 0],
    dailyVolatility: [0.012, 0.03],
    accountValueUsd: [80_000, 6_000_000],
    historyDays: [190, 260],
    youngShare: 0.35,
    lanes: 2,
    coinsPerWallet: [2, 5],
    slotMinutes: 720,
    episodeChance: 0.7,
    openDelayShare: [0.02, 0.3],
    holdShare: [0.15, 0.65],
    scaleIns: [0, 3],
    trims: [0, 2],
    flipChance: 0.05,
    positionShare: [0.08, 0.2],
    leverage: [2, 5],
    fillsPerOrder: [1, 20],
    makerShare: [0.15, 0.5],
    liquidationChance: 0,
    crashShare: 0,
    flowChancePerDay: 0.02,
  },
  {
    name: 'scalper',
    populationShare: 0.15,
    edgeShare: 0.3,
    skill: [0.08, 0.14],
    edgeDrift: [0.0035, 0.0055],
    baseDrift: [0, 0],
    dailyVolatility: [0.01, 0.018],
    accountValueUsd: [150_000, 3_000_000],
    historyDays: [190, 260],
    youngShare: 0.2,
    lanes: 1,
    coinsPerWallet: [1, 3],
    slotMinutes: 20,
    episodeChance: 0.85,
    openDelayShare: [0.02, 0.3],
    holdShare: [0.1, 0.5],
    scaleIns: [0, 1],
    trims: [0, 1],
    flipChance: 0,
    positionShare: [0.006, 0.01],
    leverage: [3, 10],
    fillsPerOrder: [1, 4],
    makerShare: [0.5, 0.85],
    liquidationChance: 0,
    crashShare: 0,
    flowChancePerDay: 0.01,
  },
  {
    name: 'reckless',
    populationShare: 0.1,
    edgeShare: 0,
    skill: [0, 0],
    edgeDrift: [0, 0],
    baseDrift: [0.003, 0.008],
    dailyVolatility: [0.05, 0.08],
    accountValueUsd: [100_000, 2_000_000],
    historyDays: [190, 260],
    youngShare: 0,
    lanes: 1,
    coinsPerWallet: [1, 3],
    slotMinutes: 720,
    episodeChance: 0.6,
    openDelayShare: [0.02, 0.3],
    holdShare: [0.1, 0.6],
    scaleIns: [0, 2],
    trims: [0, 1],
    flipChance: 0.05,
    positionShare: [0.5, 0.9],
    leverage: [10, 20],
    fillsPerOrder: [3, 20],
    makerShare: [0, 0.1],
    liquidationChance: 0.1,
    crashShare: 0.7,
    flowChancePerDay: 0.03,
  },
  {
    name: 'vault',
    populationShare: 0.05,
    edgeShare: 1,
    skill: [0.04, 0.08],
    edgeDrift: [0.002, 0.003],
    baseDrift: [0, 0],
    dailyVolatility: [0.004, 0.01],
    accountValueUsd: [1_000_000, 25_000_000],
    historyDays: [220, 260],
    youngShare: 0,
    lanes: 2,
    coinsPerWallet: [3, 6],
    slotMinutes: 720,
    episodeChance: 0.7,
    openDelayShare: [0.02, 0.3],
    holdShare: [0.2, 0.7],
    scaleIns: [1, 3],
    trims: [0, 2],
    flipChance: 0,
    positionShare: [0.05, 0.12],
    leverage: [2, 3],
    fillsPerOrder: [2, 20],
    makerShare: [0.3, 0.7],
    liquidationChance: 0,
    crashShare: 0,
    flowChancePerDay: 0.05,
  },
];

export function expectedDailyTurnover(
  profile: TraderProfile,
  lanes: number,
  positionShare: number,
): number {
  const slotsPerDay = 1_440 / profile.slotMinutes;
  return lanes * slotsPerDay * profile.episodeChance * 2 * positionShare;
}
