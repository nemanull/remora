import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletFinderConfig } from '../config';
import {
  parseLeaderboard,
  parseVaultAddresses,
  StatsDataFiles,
} from './statsDataFiles';

const LEADER = '0xbe1e9f1119e583c9547258eb7c7553219cf80875';
const HLP = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

function leaderboardRow(address: string) {
  return {
    ethAddress: address,
    accountValue: '499195.086088',
    windowPerformances: [
      ['day', { pnl: '-53161.82892', roi: '-0.2790539755', vlm: '0.0' }],
      ['week', { pnl: '142457.973013', roi: '0.3993360034', vlm: '908053.88' }],
      [
        'month',
        {
          pnl: '288360.220943',
          roi: '1.3677065259',
          vlm: '3364196.6400000001',
        },
      ],
      [
        'allTime',
        {
          pnl: '372384.826088',
          roi: '2.9365512387',
          vlm: '5538737.6799999997',
        },
      ],
    ],
    prize: 0,
    displayName: null,
  };
}

describe('parseLeaderboard', () => {
  it('reads the rows of the stats-data file into numbers', () => {
    const rows = parseLeaderboard({
      leaderboardRows: [leaderboardRow(LEADER)],
    });

    expect(rows).toEqual([
      {
        address: LEADER,
        accountValue: 499195.086088,
        windows: {
          day: { pnl: -53161.82892, roi: -0.2790539755, volume: 0 },
          week: { pnl: 142457.973013, roi: 0.3993360034, volume: 908053.88 },
          month: {
            pnl: 288360.220943,
            roi: 1.3677065259,
            volume: 3364196.6400000001,
          },
          allTime: {
            pnl: 372384.826088,
            roi: 2.9365512387,
            volume: 5538737.6799999997,
          },
        },
      },
    ]);
  });

  it('lowercases addresses and skips rows it cannot read', () => {
    const broken = leaderboardRow(LEADER);
    broken.windowPerformances = broken.windowPerformances.slice(0, 3);

    const rows = parseLeaderboard({
      leaderboardRows: [
        leaderboardRow(HLP.toUpperCase().replace('0X', '0x')),
        broken,
        { ...leaderboardRow(LEADER), accountValue: 'unknown' },
        { ...leaderboardRow('not-an-address') },
      ],
    });

    expect(rows.map((row) => row.address)).toEqual([HLP]);
  });

  it('fails on a file without leaderboard rows', () => {
    expect(() => parseLeaderboard({ rows: [] })).toThrow(
      'The leaderboard file has no leaderboardRows array',
    );
  });
});

describe('parseVaultAddresses', () => {
  it('collects vault addresses and the children of parent vaults', () => {
    const child = '0x010461c14e146ac35fe42271bdc1134ee31c703a';

    const addresses = parseVaultAddresses([
      {
        apr: 0.04,
        summary: {
          vaultAddress: HLP,
          relationship: { type: 'parent', data: { childAddresses: [child] } },
        },
      },
      { summary: { vaultAddress: LEADER, relationship: { type: 'normal' } } },
    ]);

    expect([...addresses]).toEqual([HLP, child, LEADER]);
  });
});

describe('StatsDataFiles', () => {
  const config = {
    getOrThrow: () => 'https://stats.example/Mainnet/',
  } as unknown as ConfigService<WalletFinderConfig, true>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads both files from the stats-data base url', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith('/leaderboard')
              ? { leaderboardRows: [leaderboardRow(LEADER)] }
              : [{ summary: { vaultAddress: HLP } }],
          ),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const files = new StatsDataFiles(config);

    const [rows, vaults] = await Promise.all([
      files.downloadLeaderboard(),
      files.downloadVaultAddresses(),
    ]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://stats.example/Mainnet/leaderboard',
      'https://stats.example/Mainnet/vaults',
    ]);
    expect(rows).toHaveLength(1);
    expect(vaults.has(HLP)).toBe(true);
  });

  it('fails when the file host answers with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 503 }))),
    );

    await expect(
      new StatsDataFiles(config).downloadLeaderboard(),
    ).rejects.toThrow(
      'Downloading the leaderboard file failed with status 503',
    );
  });
});
