import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeAddress } from '@remora/sdk';
import { filter, type Subscription } from 'rxjs';
import { AssignmentService } from '../clusters/assignment.service';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import type { Book, Prisma, Wallet } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  admittedFields,
  isRetiring,
  isTracked,
  type LeaderChange,
  type LeaderEvidence,
  type LeaderRecord,
  type LeaderStatus,
  type LeaderTransition,
  listChangedFields,
  listPromotionGaps,
  MANUAL_PAUSE_REASON,
  retiredFields,
} from './leaderSelection';
import {
  type ClosedCopy,
  countNegativeWeeksInRow,
  measureStreamRejectionShare,
  summarizeClosedCopies,
} from './shadowStats';

const ENTRY_ACTIONS = ['OPEN', 'INCREASE', 'FLIP'] as const;
const STREAM_SOURCE = 'stream';

export type LeaderActionResult =
  | { outcome: 'applied'; leader: Wallet }
  | { outcome: 'rejected'; reason: string; details: string[] };

type ClosedCopyEvent = Extract<CopyEvent, { type: 'copy' }>;

function rejected(reason: string, details: string[] = []): LeaderActionResult {
  return { outcome: 'rejected', reason, details };
}

function describeTransition(transition: LeaderTransition): string {
  if (transition.from !== transition.to) {
    return `Wallet ${transition.address} moved from ${transition.from} to ${transition.to} (${transition.reason})`;
  }
  if (transition.isPaused) {
    return `Wallet ${transition.address} paused as ${transition.to} (${transition.reason})`;
  }
  return `Wallet ${transition.address} stays ${transition.to} (${transition.reason})`;
}

function readChangedFields(
  before: LeaderRecord,
  after: LeaderRecord,
): Prisma.WalletUpdateManyMutationInput {
  return Object.fromEntries(
    listChangedFields(before, after).map((field) => [field, after[field]]),
  );
}

@Injectable()
export class LeadersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadersService.name);
  private readonly maxLiveLeaders: number;
  private readonly shadowAllocationUsd: number;
  private readonly liveAllocationUsd: number;
  private closedCopies: Subscription | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
    private readonly events: CopyEvents,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.maxLiveLeaders = config.getOrThrow('MAX_LIVE_LEADERS', {
      infer: true,
    });
    this.shadowAllocationUsd = config.getOrThrow('SHADOW_ALLOCATION_USD', {
      infer: true,
    });
    this.liveAllocationUsd = config.getOrThrow('LIVE_ALLOCATION_USD', {
      infer: true,
    });
  }

  onModuleInit(): void {
    this.closedCopies = this.events.events$
      .pipe(
        filter(
          (event): event is ClosedCopyEvent =>
            event.type === 'copy' && event.change === 'closed',
        ),
      )
      .subscribe((event) => {
        this.completeRetirementIfFlat(event.wallet).catch((error) =>
          this.logger.error(
            `Failed to finish the retirement of wallet ${event.wallet}`,
            error instanceof Error ? error.stack : String(error),
          ),
        );
      });
  }

  onModuleDestroy(): void {
    this.closedCopies?.unsubscribe();
  }

  async readEvidence(
    leaders: LeaderRecord[],
    now: Date,
  ): Promise<Map<string, LeaderEvidence>> {
    const addresses = leaders.map((leader) => leader.address);
    const [openCopies, lastFills] = await Promise.all([
      this.prisma.copyPosition.groupBy({
        by: ['walletAddress'],
        where: { walletAddress: { in: addresses }, isOpen: true },
        _count: { _all: true },
      }),
      this.prisma.leaderFill.groupBy({
        by: ['walletAddress'],
        where: { walletAddress: { in: addresses } },
        _max: { time: true },
      }),
    ]);
    const withOpenCopies = new Set(openCopies.map((row) => row.walletAddress));
    const lastFillAt = new Map(
      lastFills.map((row) => [row.walletAddress, row._max.time]),
    );
    const evidence = new Map<string, LeaderEvidence>();
    for (const leader of leaders) {
      evidence.set(leader.address, {
        hasOpenCopies: withOpenCopies.has(leader.address),
        lastFillAt: lastFillAt.get(leader.address) ?? null,
        shadow:
          leader.status === 'SHADOW' && leader.trackedSince !== null
            ? await this.readShadowEvidence(leader.address, leader.trackedSince)
            : null,
        live:
          leader.status === 'LIVE' && leader.liveSince !== null
            ? await this.readLiveEvidence(leader.address, leader.liveSince, now)
            : null,
      });
    }
    return evidence;
  }

  async saveChanges(changes: LeaderChange[]): Promise<LeaderTransition[]> {
    if (changes.length === 0) {
      return [];
    }
    const results = await this.prisma.$transaction(
      changes.map(({ before, after, transition }) =>
        this.prisma.wallet.updateMany({
          where:
            transition === null
              ? { address: before.address }
              : {
                  address: before.address,
                  status: before.status,
                  isPaused: before.isPaused,
                },
          data: readChangedFields(before, after),
        }),
      ),
    );
    const applied: LeaderTransition[] = [];
    changes.forEach(({ before, transition }, index) => {
      if (transition === null) {
        return;
      }
      if (results[index].count === 0) {
        this.logger.warn(
          `Skipped moving wallet ${before.address} to ${transition.to} because it changed meanwhile`,
        );
        return;
      }
      applied.push(transition);
      this.announce(transition);
    });
    return applied;
  }

  async addLeader(input: string): Promise<LeaderActionResult> {
    const address = normalizeAddress(input);
    if (address === null) {
      return rejected('invalid_address');
    }
    const created = await this.prisma.wallet.createMany({
      data: [
        {
          address,
          source: 'MANUAL',
          status: 'SHADOW',
          statusReason: 'manual_add',
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 1) {
      this.announce({
        address,
        from: 'CANDIDATE',
        to: 'SHADOW',
        isPaused: false,
        reason: 'manual_add',
      });
      this.assignment.requestAssignment('leader_added');
      return this.readResult(address);
    }
    const leader = await this.prisma.wallet.findUniqueOrThrow({
      where: { address },
    });
    if (isTracked(leader)) {
      if (leader.source !== 'MANUAL') {
        await this.prisma.wallet.update({
          where: { address },
          data: { source: 'MANUAL' },
        });
      }
      return this.readResult(address);
    }
    return this.applyChange(
      leader,
      'SHADOW',
      { source: 'MANUAL', topStreak: 0, ...admittedFields('manual_add') },
      'leader_added',
    );
  }

  async pauseLeader(input: string): Promise<LeaderActionResult> {
    const leader = await this.findLeader(input);
    if (leader === null) {
      return rejected('wallet_not_found');
    }
    if (!isTracked(leader)) {
      return rejected('wallet_not_tracked');
    }
    if (leader.isPaused) {
      return rejected('already_paused');
    }
    return this.applyChange(leader, leader.status, {
      isPaused: true,
      statusReason: MANUAL_PAUSE_REASON,
    });
  }

  async resumeLeader(input: string): Promise<LeaderActionResult> {
    const leader = await this.findLeader(input);
    if (leader === null) {
      return rejected('wallet_not_found');
    }
    if (!isTracked(leader) || !leader.isPaused) {
      return rejected('not_paused');
    }
    return this.applyChange(leader, leader.status, {
      isPaused: false,
      statusReason: 'manual_resume',
    });
  }

  async promoteLeader(input: string): Promise<LeaderActionResult> {
    const leader = await this.findLeader(input);
    if (leader === null) {
      return rejected('wallet_not_found');
    }
    if (leader.status !== 'SHADOW') {
      return rejected('not_shadow');
    }
    if (leader.isPaused) {
      return rejected('leader_paused');
    }
    const liveCount = await this.prisma.wallet.count({
      where: { status: 'LIVE' },
    });
    if (liveCount >= this.maxLiveLeaders) {
      return rejected('live_limit_reached');
    }
    const now = new Date();
    const evidence = await this.readEvidence([leader], now);
    const gaps = listPromotionGaps(
      leader,
      evidence.get(leader.address) ?? {
        hasOpenCopies: false,
        lastFillAt: null,
        shadow: null,
        live: null,
      },
      now,
    );
    if (gaps.length > 0) {
      return rejected('promotion_criteria_not_met', gaps);
    }
    return this.applyChange(
      leader,
      'LIVE',
      { liveSince: now, statusReason: 'manual_promotion' },
      'leader_promoted',
    );
  }

  async retireLeader(input: string): Promise<LeaderActionResult> {
    const leader = await this.findLeader(input);
    if (leader === null) {
      return rejected('wallet_not_found');
    }
    if (leader.status === 'RETIRED') {
      return rejected('already_retired');
    }
    if (isRetiring(leader)) {
      return rejected('already_retiring');
    }
    const now = new Date();
    if (leader.status === 'CANDIDATE') {
      return this.applyChange(leader, 'RETIRED', {
        statusReason: 'manual_retire',
        ...retiredFields(now),
      });
    }
    const openCopies = await this.prisma.copyPosition.count({
      where: { walletAddress: leader.address, isOpen: true },
    });
    if (openCopies > 0) {
      return this.applyChange(leader, leader.status, {
        isPaused: true,
        statusReason: 'manual_retire',
      });
    }
    return this.applyChange(
      leader,
      'RETIRED',
      { statusReason: 'manual_retire', ...retiredFields(now) },
      'leader_retired',
    );
  }

  async completeRetirementIfFlat(address: string): Promise<void> {
    const leader = await this.prisma.wallet.findUnique({ where: { address } });
    if (leader === null || !isRetiring(leader)) {
      return;
    }
    const openCopies = await this.prisma.copyPosition.count({
      where: { walletAddress: address, isOpen: true },
    });
    if (openCopies === 0) {
      await this.applyChange(
        leader,
        'RETIRED',
        retiredFields(new Date()),
        'leader_retired',
      );
    }
  }

  private async applyChange(
    leader: Wallet,
    status: LeaderStatus,
    fields: Partial<LeaderRecord>,
    assignmentReason?: string,
  ): Promise<LeaderActionResult> {
    const after: LeaderRecord = { ...leader, ...fields, status };
    const [transition] = await this.saveChanges([
      {
        before: leader,
        after,
        transition: {
          address: leader.address,
          from: leader.status,
          to: status,
          isPaused: after.isPaused,
          reason: after.statusReason ?? status.toLowerCase(),
        },
      },
    ]);
    if (transition === undefined) {
      return rejected('wallet_changed_meanwhile');
    }
    if (assignmentReason !== undefined) {
      this.assignment.requestAssignment(assignmentReason);
    }
    return this.readResult(leader.address);
  }

  private announce(transition: LeaderTransition): void {
    this.logger.log(describeTransition(transition));
    this.events.publish({
      type: 'leader',
      wallet: transition.address,
      status: transition.to,
      isPaused: transition.isPaused,
      reason: transition.reason,
    });
  }

  private findLeader(input: string): Promise<Wallet | null> {
    const address = normalizeAddress(input);
    if (address === null) {
      return Promise.resolve(null);
    }
    return this.prisma.wallet.findUnique({ where: { address } });
  }

  private async readResult(address: string): Promise<LeaderActionResult> {
    const leader = await this.prisma.wallet.findUniqueOrThrow({
      where: { address },
    });
    return { outcome: 'applied', leader };
  }

  private async readClosedCopies(
    address: string,
    book: Book,
    since: Date,
  ): Promise<ClosedCopy[]> {
    const copies = await this.prisma.copyPosition.findMany({
      where: {
        walletAddress: address,
        book,
        isOpen: false,
        closedAt: { gte: since },
      },
      select: {
        closedAt: true,
        realizedPnl: true,
        feesUsd: true,
        fundingUsd: true,
      },
    });
    return copies.map((copy) => ({
      closedAt: copy.closedAt ?? since,
      realizedPnl: copy.realizedPnl.toNumber(),
      feesUsd: copy.feesUsd.toNumber(),
      fundingUsd: copy.fundingUsd.toNumber(),
    }));
  }

  private async readShadowEvidence(
    address: string,
    since: Date,
  ): Promise<LeaderEvidence['shadow']> {
    const [copies, entries] = await Promise.all([
      this.readClosedCopies(address, 'SHADOW', since),
      this.prisma.copyDecision.groupBy({
        by: ['reason'],
        where: {
          walletAddress: address,
          book: 'SHADOW',
          signalSource: STREAM_SOURCE,
          action: { in: [...ENTRY_ACTIONS] },
          decidedAt: { gte: since },
        },
        _count: { _all: true },
      }),
    ]);
    return {
      ...summarizeClosedCopies(copies, this.shadowAllocationUsd),
      rejectionShare: measureStreamRejectionShare(
        entries.map((entry) => ({
          reason: entry.reason,
          count: entry._count._all,
        })),
      ),
    };
  }

  private async readLiveEvidence(
    address: string,
    since: Date,
    now: Date,
  ): Promise<LeaderEvidence['live']> {
    const copies = await this.readClosedCopies(address, 'MAIN', since);
    return {
      ...summarizeClosedCopies(copies, this.liveAllocationUsd),
      negativeWeeks: countNegativeWeeksInRow(copies, since, now),
    };
  }
}
