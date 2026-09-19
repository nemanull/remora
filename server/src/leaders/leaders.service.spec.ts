import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AssignmentService } from '../clusters/assignment.service';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import type { Wallet } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadersService } from './leaders.service';

Logger.overrideLogger(false);

const ADDRESS = '0x24fb52e17e3d4fd62a119b8f53c1a3f3bfe65c2f';

type WalletWhere = {
  address?: string;
  isPaused?: boolean;
  status?: Wallet['status'] | { in: Wallet['status'][] };
};

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    address: ADDRESS,
    status: 'CANDIDATE',
    source: 'LEADERBOARD',
    score: 0.6,
    scoredAt: null,
    topStreak: 0,
    missStreak: 0,
    isPaused: false,
    statusReason: null,
    trackedSince: null,
    fillsSyncedUntil: null,
    liveSince: null,
    retiredAt: null,
    clusterId: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    ...overrides,
  };
}

function matches(row: Wallet, where: WalletWhere): boolean {
  if (where.address !== undefined && row.address !== where.address) {
    return false;
  }
  if (where.isPaused !== undefined && row.isPaused !== where.isPaused) {
    return false;
  }
  if (typeof where.status === 'string') {
    return row.status === where.status;
  }
  if (where.status !== undefined) {
    return where.status.in.includes(row.status);
  }
  return true;
}

function createService(rows: Wallet[], openCopies = 0) {
  const wallets = new Map(rows.map((row) => [row.address, { ...row }]));
  const prisma = {
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
    wallet: {
      createMany: vi.fn(({ data }: { data: Partial<Wallet>[] }) => {
        const [row] = data;
        if (wallets.has(row.address!)) {
          return Promise.resolve({ count: 0 });
        }
        wallets.set(row.address!, wallet(row));
        return Promise.resolve({ count: 1 });
      }),
      findUnique: ({ where }: { where: { address: string } }) =>
        Promise.resolve(wallets.get(where.address) ?? null),
      findUniqueOrThrow: ({ where }: { where: { address: string } }) =>
        Promise.resolve(wallets.get(where.address)!),
      update: ({
        where,
        data,
      }: {
        where: { address: string };
        data: Partial<Wallet>;
      }) => {
        Object.assign(wallets.get(where.address)!, data);
        return Promise.resolve(wallets.get(where.address));
      },
      updateMany: ({
        where,
        data,
      }: {
        where: WalletWhere;
        data: Partial<Wallet>;
      }) => {
        const hits = [...wallets.values()].filter((row) => matches(row, where));
        hits.forEach((row) => Object.assign(row, data));
        return Promise.resolve({ count: hits.length });
      },
      count: ({ where }: { where: WalletWhere }) =>
        Promise.resolve(
          [...wallets.values()].filter((row) => matches(row, where)).length,
        ),
    },
    copyPosition: {
      count: vi.fn(() => Promise.resolve(openCopies)),
      groupBy: () =>
        Promise.resolve(
          openCopies > 0
            ? [{ walletAddress: ADDRESS, _count: { _all: 1 } }]
            : [],
        ),
      findMany: () => Promise.resolve([]),
    },
    leaderFill: { groupBy: () => Promise.resolve([]) },
    copyDecision: { groupBy: () => Promise.resolve([]) },
  };
  const assignment = { requestAssignment: vi.fn() };
  const events = new CopyEvents();
  const published: CopyEvent[] = [];
  events.events$.subscribe((event) => published.push(event));
  const settings: Partial<ServerConfig> = {
    MAX_LIVE_LEADERS: 1,
    SHADOW_ALLOCATION_USD: 5_000,
    LIVE_ALLOCATION_USD: 5_000,
  };
  const config = {
    getOrThrow: (key: keyof ServerConfig) => settings[key],
  } as unknown as ConfigService<ServerConfig, true>;
  const service = new LeadersService(
    prisma as unknown as PrismaService,
    assignment as unknown as AssignmentService,
    events,
    config,
  );
  return { service, wallets, assignment, events, published, prisma };
}

describe('LeadersService.addLeader', () => {
  it('adds an unknown wallet straight into SHADOW as a manual wallet', async () => {
    const { service, wallets, assignment, published } = createService([]);

    const result = await service.addLeader(
      ADDRESS.toUpperCase().replace('0X', '0x'),
    );

    expect(result.outcome).toBe('applied');
    expect(wallets.get(ADDRESS)).toMatchObject({
      status: 'SHADOW',
      source: 'MANUAL',
      statusReason: 'manual_add',
    });
    expect(assignment.requestAssignment).toHaveBeenCalledWith('leader_added');
    expect(published).toEqual([
      {
        type: 'leader',
        wallet: ADDRESS,
        status: 'SHADOW',
        isPaused: false,
        reason: 'manual_add',
      },
    ]);
  });

  it('moves a known candidate into SHADOW and clears its old tracking time', async () => {
    const { service, wallets } = createService([
      wallet({
        status: 'RETIRED',
        trackedSince: new Date('2026-01-01T00:00:00.000Z'),
        retiredAt: new Date('2026-04-10T00:00:00.000Z'),
      }),
    ]);

    await service.addLeader(ADDRESS);

    expect(wallets.get(ADDRESS)).toMatchObject({
      status: 'SHADOW',
      source: 'MANUAL',
      trackedSince: null,
      isPaused: false,
    });
  });

  it('marks a tracked wallet as manual without moving it', async () => {
    const { service, wallets, published } = createService([
      wallet({ status: 'LIVE' }),
    ]);

    await service.addLeader(ADDRESS);

    expect(wallets.get(ADDRESS)).toMatchObject({
      status: 'LIVE',
      source: 'MANUAL',
    });
    expect(published).toEqual([]);
  });

  it('rejects an address that is not one', async () => {
    const { service } = createService([]);

    expect(await service.addLeader('0x1234')).toEqual({
      outcome: 'rejected',
      reason: 'invalid_address',
      details: [],
    });
  });
});

describe('LeadersService lifecycle actions', () => {
  it('pauses and resumes a tracked wallet', async () => {
    const { service, wallets } = createService([wallet({ status: 'SHADOW' })]);

    await service.pauseLeader(ADDRESS);
    expect(wallets.get(ADDRESS)).toMatchObject({
      isPaused: true,
      statusReason: 'manual_pause',
    });

    await service.resumeLeader(ADDRESS);
    expect(wallets.get(ADDRESS)).toMatchObject({
      isPaused: false,
      statusReason: 'manual_resume',
    });
  });

  it('refuses to pause a wallet that is not tracked', async () => {
    const { service } = createService([wallet()]);

    expect(await service.pauseLeader(ADDRESS)).toMatchObject({
      outcome: 'rejected',
      reason: 'wallet_not_tracked',
    });
  });

  it('refuses a promotion that the shadow results do not support', async () => {
    const { service } = createService([
      wallet({
        status: 'SHADOW',
        trackedSince: new Date(Date.now() - 3 * 86_400_000),
      }),
    ]);

    expect(await service.promoteLeader(ADDRESS)).toEqual({
      outcome: 'rejected',
      reason: 'promotion_criteria_not_met',
      details: [
        'shadow_too_short',
        'too_few_closed_copies',
        'shadow_return_not_positive',
        'too_many_rejected_entries',
      ],
    });
  });

  it('refuses a promotion beyond the live limit', async () => {
    const { service } = createService([
      wallet({ status: 'SHADOW' }),
      wallet({ address: '0x1', status: 'LIVE' }),
    ]);

    expect(await service.promoteLeader(ADDRESS)).toMatchObject({
      reason: 'live_limit_reached',
    });
  });

  it('retires a flat wallet at once and frees its collector slot', async () => {
    const { service, wallets, assignment } = createService([
      wallet({ status: 'SHADOW' }),
    ]);

    await service.retireLeader(ADDRESS);

    expect(wallets.get(ADDRESS)).toMatchObject({
      status: 'RETIRED',
      statusReason: 'manual_retire',
      isPaused: false,
    });
    expect(wallets.get(ADDRESS)?.retiredAt).toBeInstanceOf(Date);
    expect(assignment.requestAssignment).toHaveBeenCalledWith('leader_retired');
  });

  it('pauses a wallet with open copies and retires it when its last copy closes', async () => {
    const { service, wallets, prisma, events } = createService(
      [wallet({ status: 'LIVE' })],
      1,
    );
    service.onModuleInit();

    await service.retireLeader(ADDRESS);
    expect(wallets.get(ADDRESS)).toMatchObject({
      status: 'LIVE',
      isPaused: true,
      statusReason: 'manual_retire',
    });

    prisma.copyPosition.count.mockResolvedValue(0);
    events.publish({
      type: 'copy',
      book: 'MAIN',
      positionId: 1n,
      wallet: ADDRESS,
      coin: 'HYPE',
      change: 'closed',
      size: '0',
      realizedPnl: '12.5',
    });
    await vi.waitFor(() =>
      expect(wallets.get(ADDRESS)?.status).toBe('RETIRED'),
    );
    expect(wallets.get(ADDRESS)?.statusReason).toBe('manual_retire');
    service.onModuleDestroy();
  });

  it('skips a change when the wallet moved meanwhile', async () => {
    const { service, published } = createService([wallet()]);

    const transitions = await service.saveChanges([
      {
        before: wallet({ status: 'SHADOW' }),
        after: wallet({ status: 'LIVE' }),
        transition: {
          address: ADDRESS,
          from: 'SHADOW',
          to: 'LIVE',
          isPaused: false,
          reason: 'promoted',
        },
      },
    ]);

    expect(transitions).toEqual([]);
    expect(published).toEqual([]);
  });
});
