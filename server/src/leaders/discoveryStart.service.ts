import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { RunDiscoveryJob } from '@remora/sdk';
import { Queue } from 'bullmq';
import { DISCOVERY_QUEUE, RUN_DISCOVERY_JOB } from '../jobs/queues';
import { PrismaService } from '../prisma/prisma.service';

const RUN_DISCOVERY_ATTEMPTS = 3;
const RUN_DISCOVERY_BACKOFF_MS = 60_000;

export function formatRunId(startedAt: Date): string {
  const minute = startedAt.toISOString().slice(0, 16);
  return `run-${minute.replace(/[-:]/g, '')}Z`;
}

@Injectable()
export class DiscoveryStartService {
  private readonly logger = new Logger(DiscoveryStartService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(DISCOVERY_QUEUE) private readonly discoveryQueue: Queue,
  ) {}

  async startDiscovery(startedAt = new Date()): Promise<RunDiscoveryJob> {
    const wallets = await this.prisma.wallet.findMany({
      where: {
        OR: [
          { status: { in: ['SHADOW', 'LIVE'] } },
          { source: 'MANUAL', status: { not: 'RETIRED' } },
        ],
      },
      select: { address: true },
      orderBy: { address: 'asc' },
    });
    const run: RunDiscoveryJob = {
      runId: formatRunId(startedAt),
      startedAt: startedAt.toISOString(),
      trackedAddresses: wallets.map((wallet) => wallet.address),
    };
    await this.discoveryQueue.add(RUN_DISCOVERY_JOB, run, {
      jobId: run.runId,
      attempts: RUN_DISCOVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: RUN_DISCOVERY_BACKOFF_MS },
    });
    this.logger.log(
      `Queued discovery run ${run.runId} with ${run.trackedAddresses.length} tracked wallets`,
    );
    return run;
  }
}
