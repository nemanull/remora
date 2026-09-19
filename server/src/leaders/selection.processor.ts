import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { AssignmentService } from '../clusters/assignment.service';
import type { ServerConfig } from '../config';
import {
  SELECT_LEADERS_JOB,
  SELECTION_QUEUE,
  START_DISCOVERY_JOB,
} from '../jobs/queues';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoveryStartService } from './discoveryStart.service';
import {
  COOLDOWN_DAYS,
  isTracked,
  type LeaderTransition,
  planSelection,
  type SelectionSettings,
} from './leaderSelection';
import { LeadersService } from './leaders.service';

const DAY_MS = 86_400_000;

const selectLeadersSchema = z.object({ runId: z.string().min(1) });

export type SelectionSummary = {
  runId: string;
  scores: number;
  updatedWallets: number;
  transitions: LeaderTransition[];
};

@Processor(SELECTION_QUEUE, { concurrency: 1 })
export class SelectionProcessor extends WorkerHost {
  private readonly logger = new Logger(SelectionProcessor.name);
  private readonly settings: SelectionSettings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaders: LeadersService,
    private readonly discoveryStart: DiscoveryStartService,
    private readonly assignment: AssignmentService,
    config: ConfigService<ServerConfig, true>,
  ) {
    super();
    this.settings = {
      trackedTarget: config.getOrThrow('TRACKED_TARGET', { infer: true }),
      streakRuns: config.getOrThrow('SELECTION_STREAK_RUNS', { infer: true }),
      maxLiveLeaders: config.getOrThrow('MAX_LIVE_LEADERS', { infer: true }),
      promotionMode: config.getOrThrow('PROMOTION_MODE', { infer: true }),
    };
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`Job ${job.name} ${job.id ?? ''} started`);
    try {
      const result = await this.handle(job);
      this.logger.log(`Job ${job.name} ${job.id ?? ''} finished`);
      return result;
    } catch (error) {
      this.logger.error(
        `Job ${job.name} ${job.id ?? ''} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private handle(job: Job): Promise<unknown> {
    if (job.name === START_DISCOVERY_JOB) {
      return this.discoveryStart.startDiscovery(new Date());
    }
    if (job.name === SELECT_LEADERS_JOB) {
      const parsed = selectLeadersSchema.safeParse(job.data);
      if (!parsed.success) {
        throw new UnrecoverableError('A select-leaders job needs a run id');
      }
      return this.selectLeaders(parsed.data.runId, new Date());
    }
    throw new UnrecoverableError(`Unknown selection job ${job.name}`);
  }

  async selectLeaders(runId: string, now: Date): Promise<SelectionSummary> {
    const scores = await this.prisma.walletScore.findMany({
      where: { runId },
      select: {
        walletAddress: true,
        passed: true,
        composite: true,
        gateFailures: true,
      },
    });
    const leaders = await this.prisma.wallet.findMany({
      where: {
        OR: [
          { address: { in: scores.map((score) => score.walletAddress) } },
          { status: { in: ['SHADOW', 'LIVE'] } },
          {
            status: 'RETIRED',
            retiredAt: {
              lte: new Date(now.getTime() - COOLDOWN_DAYS * DAY_MS),
            },
          },
          { status: 'CANDIDATE', topStreak: { gt: 0 } },
        ],
      },
    });
    const evidence = await this.leaders.readEvidence(
      leaders.filter(isTracked),
      now,
    );
    const changes = planSelection({
      now,
      settings: this.settings,
      leaders,
      evidence,
      scores,
    });
    const transitions = await this.leaders.saveChanges(changes);
    if (transitions.length > 0) {
      this.assignment.requestAssignment('leader_selection');
    }
    this.logger.log(
      `Selected leaders for run ${runId}: ${scores.length} scores, ${changes.length} wallets updated, ${transitions.length} lifecycle changes`,
    );
    return {
      runId,
      scores: scores.length,
      updatedWallets: changes.length,
      transitions,
    };
  }
}
