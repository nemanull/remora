import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { DiscoveryStartService, formatRunId } from './discoveryStart.service';

Logger.overrideLogger(false);

describe('formatRunId', () => {
  it('names the run by its UTC minute without a colon', () => {
    expect(formatRunId(new Date('2026-09-01T02:00:41.123Z'))).toBe(
      'run-20260901T0200Z',
    );
  });
});

describe('DiscoveryStartService', () => {
  it('queues run-discovery under the run id with the tracked and manual wallets', async () => {
    const prisma = {
      wallet: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { address: '0x24fb52e17e3d4fd62a119b8f53c1a3f3bfe65c2f' },
            { address: '0xad5455057feac38a2dd2210d0fac0854d1eb6203' },
          ]),
      },
    };
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const service = new DiscoveryStartService(
      prisma as unknown as PrismaService,
      queue as unknown as Queue,
    );

    const run = await service.startDiscovery(
      new Date('2026-04-20T02:00:00.000Z'),
    );

    expect(prisma.wallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { status: { in: ['SHADOW', 'LIVE'] } },
            { source: 'MANUAL', status: { not: 'RETIRED' } },
          ],
        },
      }),
    );
    expect(run).toEqual({
      runId: 'run-20260420T0200Z',
      startedAt: '2026-04-20T02:00:00.000Z',
      trackedAddresses: [
        '0x24fb52e17e3d4fd62a119b8f53c1a3f3bfe65c2f',
        '0xad5455057feac38a2dd2210d0fac0854d1eb6203',
      ],
    });
    expect(queue.add).toHaveBeenCalledWith('run-discovery', run, {
      jobId: 'run-20260420T0200Z',
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    });
  });
});
