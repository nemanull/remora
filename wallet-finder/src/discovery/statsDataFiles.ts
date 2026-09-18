import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeAddress } from '@remora/sdk';
import { z } from 'zod';
import type { WalletFinderConfig } from '../config';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export type LeaderboardWindow = 'day' | 'week' | 'month' | 'allTime';

export type WindowPerformance = {
  pnl: number;
  roi: number;
  volume: number;
};

export type LeaderboardRow = {
  address: string;
  accountValue: number;
  windows: Record<LeaderboardWindow, WindowPerformance>;
};

const decimal = z
  .string()
  .regex(DECIMAL_PATTERN)
  .transform((value) => Number(value));

const windowPerformanceSchema = z.object({
  pnl: decimal,
  roi: decimal,
  vlm: decimal,
});

const leaderboardRowSchema = z.object({
  ethAddress: z.string(),
  accountValue: decimal,
  windowPerformances: z.array(
    z.tuple([z.enum(['day', 'week', 'month', 'allTime']), z.unknown()]),
  ),
});

const leaderboardFileSchema = z.object({
  leaderboardRows: z.array(z.unknown()),
});

const vaultFileSchema = z.array(
  z.object({
    summary: z.object({
      vaultAddress: z.string(),
      relationship: z
        .object({
          data: z
            .object({ childAddresses: z.array(z.string()).optional() })
            .optional(),
        })
        .optional(),
    }),
  }),
);

function parseLeaderboardRow(value: unknown): LeaderboardRow | null {
  const row = leaderboardRowSchema.safeParse(value);
  if (!row.success) {
    return null;
  }
  const address = normalizeAddress(row.data.ethAddress);
  if (address === null) {
    return null;
  }
  const windows: Partial<Record<LeaderboardWindow, WindowPerformance>> = {};
  for (const [window, performance] of row.data.windowPerformances) {
    const parsed = windowPerformanceSchema.safeParse(performance);
    if (!parsed.success) {
      return null;
    }
    windows[window] = {
      pnl: parsed.data.pnl,
      roi: parsed.data.roi,
      volume: parsed.data.vlm,
    };
  }
  if (!windows.day || !windows.week || !windows.month || !windows.allTime) {
    return null;
  }
  return {
    address,
    accountValue: row.data.accountValue,
    windows: {
      day: windows.day,
      week: windows.week,
      month: windows.month,
      allTime: windows.allTime,
    },
  };
}

export function parseLeaderboard(body: unknown): LeaderboardRow[] {
  const file = leaderboardFileSchema.safeParse(body);
  if (!file.success) {
    throw new Error('The leaderboard file has no leaderboardRows array');
  }
  const rows: LeaderboardRow[] = [];
  for (const value of file.data.leaderboardRows) {
    const row = parseLeaderboardRow(value);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

export function parseVaultAddresses(body: unknown): Set<string> {
  const file = vaultFileSchema.safeParse(body);
  if (!file.success) {
    throw new Error('The vault file is not a list of vault summaries');
  }
  const addresses = new Set<string>();
  for (const { summary } of file.data) {
    const children = summary.relationship?.data?.childAddresses ?? [];
    for (const candidate of [summary.vaultAddress, ...children]) {
      const address = normalizeAddress(candidate);
      if (address !== null) {
        addresses.add(address);
      }
    }
  }
  return addresses;
}

@Injectable()
export class StatsDataFiles {
  private readonly baseUrl: string;

  constructor(config: ConfigService<WalletFinderConfig, true>) {
    this.baseUrl = config
      .getOrThrow('STATS_DATA_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  async downloadLeaderboard(): Promise<LeaderboardRow[]> {
    return parseLeaderboard(await this.download('leaderboard'));
  }

  async downloadVaultAddresses(): Promise<Set<string>> {
    return parseVaultAddresses(await this.download('vaults'));
  }

  private async download(file: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${file}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Downloading the ${file} file failed with status ${response.status}`,
      );
    }
    return response.json();
  }
}
