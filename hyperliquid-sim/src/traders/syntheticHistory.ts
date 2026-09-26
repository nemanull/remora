import type { PortfolioResponse, PortfolioWindow } from '@remora/sdk';
import { createRandom, randomBetween, randomNormal } from '../random';
import { formatUsd, toWireDecimal } from '../wireFormat';
import { deriveAddress, type SyntheticWallet } from './syntheticWallets';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MIN_EQUITY_USD = 1_000;
const CRASH_DAYS = 4;
const CRASH_DAILY_RETURN = -0.23;
const TAIL_CHANCE = 0.04;
const TAIL_MULTIPLIER = 2.5;
const LEADERBOARD_MIN_ACCOUNT_VALUE = 100_000;
const LEADERBOARD_MIN_ALL_TIME_VOLUME = 10_000_000;
const VAULT_PNL_POINTS = 8;

export type LeaderboardWindow = 'day' | 'week' | 'month' | 'allTime';

export type WindowPerformance = { pnl: string; roi: string; vlm: string };

export type LeaderboardRow = {
  ethAddress: string;
  accountValue: string;
  windowPerformances: [LeaderboardWindow, WindowPerformance][];
  prize: number;
  displayName: string | null;
};

export type VaultRow = {
  apr: number;
  pnls: [LeaderboardWindow, string[]][];
  summary: {
    name: string;
    vaultAddress: string;
    leader: string;
    tvl: string;
    isClosed: boolean;
    relationship: { type: 'normal' };
    createTimeMillis: number;
  };
};

export type AccountFlow = { time: number; usdc: number };

type AccountCurve = {
  equityAfterFlow: number[];
  pnl: number[];
  volume: number[];
  flow: number[];
  cumulativePnlAtStart: number[];
  cumulativeVolumeAtStart: number[];
  cumulativeFlow: number[];
};

type WindowSpec = {
  name: PortfolioWindow;
  spanMs: number | null;
  spacingMs: (ageMs: number) => number;
};

function allTimeSpacing(ageMs: number): number {
  if (ageMs <= 75 * DAY_MS) {
    return DAY_MS;
  }
  return ageMs <= 150 * DAY_MS ? 2 * DAY_MS : 7 * DAY_MS;
}

const PORTFOLIO_WINDOWS: readonly WindowSpec[] = [
  { name: 'day', spanMs: DAY_MS, spacingMs: () => 2 * HOUR_MS },
  { name: 'week', spanMs: 7 * DAY_MS, spacingMs: () => 140 * MINUTE_MS },
  { name: 'month', spanMs: 30 * DAY_MS, spacingMs: () => 16 * HOUR_MS },
  { name: 'allTime', spanMs: null, spacingMs: allTimeSpacing },
  { name: 'perpDay', spanMs: DAY_MS, spacingMs: () => 2 * HOUR_MS },
  { name: 'perpWeek', spanMs: 7 * DAY_MS, spacingMs: () => 140 * MINUTE_MS },
  { name: 'perpMonth', spanMs: 30 * DAY_MS, spacingMs: () => 12 * HOUR_MS },
  {
    name: 'perpAllTime',
    spanMs: null,
    spacingMs: (ageMs) => Math.max(DAY_MS, allTimeSpacing(ageMs) / 2),
  },
];

const LEADERBOARD_WINDOWS: readonly [LeaderboardWindow, number | null][] = [
  ['day', DAY_MS],
  ['week', 7 * DAY_MS],
  ['month', 30 * DAY_MS],
  ['allTime', null],
];

export function emptyPortfolio(): PortfolioResponse {
  return PORTFOLIO_WINDOWS.map(({ name }) => [
    name,
    { accountValueHistory: [], pnlHistory: [], vlm: '0.0' },
  ]);
}

export class SyntheticHistory {
  private readonly curves = new Map<number, AccountCurve>();

  constructor(
    private readonly seed: number,
    readonly wallets: readonly SyntheticWallet[],
    private readonly startedAt: number,
  ) {}

  readEquityAt(wallet: SyntheticWallet, time: number): number {
    const point = this.locate(wallet, time);
    if (!point) {
      return 0;
    }
    const { curve, day, fraction } = point;
    return curve.equityAfterFlow[day] + curve.pnl[day] * fraction;
  }

  readPortfolio(wallet: SyntheticWallet, now: number): PortfolioResponse {
    const zeroPoint = wallet.createdAt - HOUR_MS;
    return PORTFOLIO_WINDOWS.map((spec) => {
      const start =
        spec.spanMs === null
          ? zeroPoint
          : Math.max(now - spec.spanMs, zeroPoint);
      const spacing = spec.spacingMs(now - wallet.createdAt);
      const times = [start];
      for (
        let time = Math.floor(start / spacing) * spacing + spacing;
        time < now;
        time += spacing
      ) {
        times.push(time);
      }
      if (now > start) {
        times.push(now);
      }
      const basePnl = this.readCumulativePnlAt(wallet, start);
      return [
        spec.name,
        {
          accountValueHistory: times.map((time) => [
            time,
            formatUsd(this.readEquityAt(wallet, time)),
          ]),
          pnlHistory: times.map((time) => [
            time,
            formatUsd(this.readCumulativePnlAt(wallet, time) - basePnl),
          ]),
          vlm: toWireDecimal(
            this.readCumulativeVolumeAt(wallet, now) -
              this.readCumulativeVolumeAt(wallet, start),
            2,
          ),
        },
      ];
    });
  }

  readLeaderboard(now: number): LeaderboardRow[] {
    return this.wallets
      .map((wallet) => ({
        wallet,
        monthVolume:
          this.readCumulativeVolumeAt(wallet, now) -
          this.readCumulativeVolumeAt(wallet, now - 30 * DAY_MS),
        allTimeVolume: this.readCumulativeVolumeAt(wallet, now),
        accountValue: this.readEquityAt(wallet, now),
      }))
      .filter(
        (entry) =>
          entry.accountValue >= LEADERBOARD_MIN_ACCOUNT_VALUE ||
          entry.allTimeVolume >= LEADERBOARD_MIN_ALL_TIME_VOLUME,
      )
      .sort((left, right) => right.monthVolume - left.monthVolume)
      .map(({ wallet, accountValue }) => ({
        ethAddress: wallet.address,
        accountValue: formatUsd(accountValue),
        windowPerformances: LEADERBOARD_WINDOWS.map(([name, spanMs]) => [
          name,
          this.readWindowPerformance(wallet, spanMs, now),
        ]),
        prize: 0,
        displayName: null,
      }));
  }

  readVaults(now: number): VaultRow[] {
    const openVaults = this.wallets
      .filter((wallet) => wallet.vaultName !== null)
      .map((wallet): VaultRow => {
        const monthAgo = now - 30 * DAY_MS;
        const monthBase = Math.max(
          this.readEquityAt(wallet, monthAgo),
          MIN_EQUITY_USD,
        );
        const monthPnl =
          this.readCumulativePnlAt(wallet, now) -
          this.readCumulativePnlAt(wallet, monthAgo);
        return {
          apr: (monthPnl / monthBase) * (365 / 30),
          pnls: LEADERBOARD_WINDOWS.map(([name, spanMs]) => [
            name,
            this.readPnlPoints(wallet, spanMs, now),
          ]),
          summary: {
            name: wallet.vaultName ?? '',
            vaultAddress: wallet.address,
            leader: wallet.vaultLeader ?? wallet.address,
            tvl: formatUsd(this.readEquityAt(wallet, now)),
            isClosed: false,
            relationship: { type: 'normal' },
            createTimeMillis: wallet.createdAt,
          },
        };
      });
    const closedCount = Math.max(3, Math.round(this.wallets.length * 0.03));
    const closedVaults = Array.from(
      { length: closedCount },
      (_, index): VaultRow => ({
        apr: 0,
        pnls: LEADERBOARD_WINDOWS.map(([name]) => [
          name,
          Array.from({ length: VAULT_PNL_POINTS }, () => '0.0'),
        ]),
        summary: {
          name: `Closed Strategy ${index + 1}`,
          vaultAddress: deriveAddress(this.seed, 'closed-vault', index),
          leader: deriveAddress(this.seed, 'closed-vault-leader', index),
          tvl: '0.0',
          isClosed: true,
          relationship: { type: 'normal' },
          createTimeMillis: this.startedAt - (300 + index * 7) * DAY_MS,
        },
      }),
    );
    return [...openVaults, ...closedVaults];
  }

  readFlows(wallet: SyntheticWallet, from: number, to: number): AccountFlow[] {
    const lastDay = this.locate(wallet, to)?.day ?? -1;
    const firstDay = Math.max(0, Math.ceil((from - wallet.createdAt) / DAY_MS));
    const flows: AccountFlow[] = [];
    for (let day = firstDay; day <= lastDay; day += 1) {
      const curve = this.readCurve(wallet, day);
      const time = wallet.createdAt + day * DAY_MS;
      if (curve.flow[day] !== 0 && time >= from && time <= to) {
        flows.push({ time, usdc: curve.flow[day] });
      }
    }
    return flows;
  }

  private readWindowPerformance(
    wallet: SyntheticWallet,
    spanMs: number | null,
    now: number,
  ): WindowPerformance {
    const start =
      spanMs === null
        ? wallet.createdAt - HOUR_MS
        : Math.max(now - spanMs, wallet.createdAt - HOUR_MS);
    const pnl =
      this.readCumulativePnlAt(wallet, now) -
      this.readCumulativePnlAt(wallet, start);
    const startFlow = this.readCumulativeFlowAt(wallet, start);
    let maxNetInflow = 0;
    for (let time = start; time <= now; time += DAY_MS) {
      maxNetInflow = Math.max(
        maxNetInflow,
        this.readCumulativeFlowAt(wallet, Math.min(time + HOUR_MS, now)) -
          startFlow,
      );
    }
    const base = Math.max(100, this.readEquityAt(wallet, start) + maxNetInflow);
    return {
      pnl: formatUsd(pnl),
      roi: toWireDecimal(pnl / base, 10),
      vlm: toWireDecimal(
        this.readCumulativeVolumeAt(wallet, now) -
          this.readCumulativeVolumeAt(wallet, start),
        2,
      ),
    };
  }

  private readPnlPoints(
    wallet: SyntheticWallet,
    spanMs: number | null,
    now: number,
  ): string[] {
    const start =
      spanMs === null
        ? wallet.createdAt
        : Math.max(now - spanMs, wallet.createdAt);
    const basePnl = this.readCumulativePnlAt(wallet, start);
    return Array.from({ length: VAULT_PNL_POINTS }, (_, index) => {
      const time = start + ((now - start) * index) / (VAULT_PNL_POINTS - 1);
      return formatUsd(this.readCumulativePnlAt(wallet, time) - basePnl);
    });
  }

  private readCumulativePnlAt(wallet: SyntheticWallet, time: number): number {
    const point = this.locate(wallet, time);
    if (!point) {
      return 0;
    }
    const { curve, day, fraction } = point;
    return curve.cumulativePnlAtStart[day] + curve.pnl[day] * fraction;
  }

  private readCumulativeVolumeAt(
    wallet: SyntheticWallet,
    time: number,
  ): number {
    const point = this.locate(wallet, time);
    if (!point) {
      return 0;
    }
    const { curve, day, fraction } = point;
    return curve.cumulativeVolumeAtStart[day] + curve.volume[day] * fraction;
  }

  private readCumulativeFlowAt(wallet: SyntheticWallet, time: number): number {
    const point = this.locate(wallet, time);
    return point ? point.curve.cumulativeFlow[point.day] : 0;
  }

  private locate(
    wallet: SyntheticWallet,
    time: number,
  ): { curve: AccountCurve; day: number; fraction: number } | null {
    if (time < wallet.createdAt) {
      return null;
    }
    const elapsed = time - wallet.createdAt;
    const day = Math.floor(elapsed / DAY_MS);
    return {
      curve: this.readCurve(wallet, day),
      day,
      fraction: (elapsed - day * DAY_MS) / DAY_MS,
    };
  }

  private readCurve(wallet: SyntheticWallet, day: number): AccountCurve {
    let curve = this.curves.get(wallet.index);
    if (!curve) {
      curve = {
        equityAfterFlow: [],
        pnl: [],
        volume: [],
        flow: [],
        cumulativePnlAtStart: [],
        cumulativeVolumeAtStart: [],
        cumulativeFlow: [],
      };
      this.curves.set(wallet.index, curve);
    }
    while (curve.pnl.length <= day) {
      this.appendDay(wallet, curve);
    }
    return curve;
  }

  private appendDay(wallet: SyntheticWallet, curve: AccountCurve): void {
    const day = curve.pnl.length;
    const random = createRandom(this.seed, 'day', wallet.index, day);
    const previousEnd =
      day === 0 ? 0 : curve.equityAfterFlow[day - 1] + curve.pnl[day - 1];
    let flow = day === 0 ? wallet.initialDepositUsd : 0;
    if (day > 0 && random() < wallet.profile.flowChancePerDay) {
      const share = randomBetween(random, 0.05, 0.25);
      flow = random() < 0.5 ? previousEnd * share : -previousEnd * share;
    }
    const equity = Math.max(previousEnd + flow, MIN_EQUITY_USD);
    flow = equity - previousEnd;
    const tail = random() < TAIL_CHANCE ? TAIL_MULTIPLIER : 1;
    let dailyReturn =
      wallet.dailyDrift + wallet.dailyVolatility * randomNormal(random) * tail;
    if (
      wallet.crashDay !== null &&
      day >= wallet.crashDay &&
      day < wallet.crashDay + CRASH_DAYS
    ) {
      dailyReturn = CRASH_DAILY_RETURN;
    }
    const pnl = Math.max(
      equity * Math.max(dailyReturn, -0.6),
      MIN_EQUITY_USD - equity,
    );
    const volume =
      wallet.turnoverPerDay * equity * randomBetween(random, 0.5, 1.5);
    curve.cumulativePnlAtStart.push(
      day === 0 ? 0 : curve.cumulativePnlAtStart[day - 1] + curve.pnl[day - 1],
    );
    curve.cumulativeVolumeAtStart.push(
      day === 0
        ? 0
        : curve.cumulativeVolumeAtStart[day - 1] + curve.volume[day - 1],
    );
    curve.cumulativeFlow.push(
      (day === 0 ? 0 : curve.cumulativeFlow[day - 1]) + flow,
    );
    curve.equityAfterFlow.push(equity);
    curve.pnl.push(pnl);
    curve.volume.push(volume);
    curve.flow.push(flow);
  }
}
