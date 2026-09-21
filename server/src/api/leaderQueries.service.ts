import type {
  CopyResultsResponse,
  LeaderDetailResponse,
  LeaderResponse,
  WalletStatus,
} from '@remora/sdk';
import { Injectable } from '@nestjs/common';
import { BookStateService } from '../books/bookState.service';
import type { Wallet, WalletScore } from '../generated/prisma/client';
import type { LeaderEvidence } from '../leaders/leaderSelection';
import { LeadersService } from '../leaders/leaders.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  toCopyPositionResponse,
  toDecisionResponse,
  toLeaderFillResponse,
  toLeaderResponse,
  toLeaderStateResponse,
  toWalletScoreResponse,
} from './responses';

const STATUS_RANK: Record<WalletStatus, number> = {
  LIVE: 0,
  SHADOW: 1,
  CANDIDATE: 2,
  RETIRED: 3,
};
const SCORE_HISTORY_LIMIT = 30;
const COPIES_LIMIT = 100;
const RECENT_FILLS_LIMIT = 50;
const RECENT_DECISIONS_LIMIT = 50;

function readCopyResults(
  evidence: LeaderEvidence | undefined,
): CopyResultsResponse | null {
  if (evidence?.live) {
    const { closedCopies, netPnlUsd, returnOnAllocation, maxDrawdown } =
      evidence.live;
    return {
      book: 'MAIN',
      closedCopies,
      netPnlUsd,
      returnOnAllocation,
      maxDrawdown,
    };
  }
  if (evidence?.shadow) {
    const { closedCopies, netPnlUsd, returnOnAllocation, maxDrawdown } =
      evidence.shadow;
    return {
      book: 'SHADOW',
      closedCopies,
      netPnlUsd,
      returnOnAllocation,
      maxDrawdown,
    };
  }
  return null;
}

function compareLeaders(left: Wallet, right: Wallet): number {
  return (
    STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
    (right.score ?? -1) - (left.score ?? -1) ||
    left.address.localeCompare(right.address)
  );
}

@Injectable()
export class LeaderQueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leaders: LeadersService,
    private readonly bookState: BookStateService,
  ) {}

  async listLeaders(
    status: WalletStatus | null,
    limit: number,
  ): Promise<LeaderResponse[]> {
    const byScore = [
      { score: { sort: 'desc', nulls: 'last' } },
      { address: 'asc' },
    ] as const;
    const wallets =
      status === null
        ? [
            ...(await this.prisma.wallet.findMany({
              where: { status: { in: ['LIVE', 'SHADOW'] } },
            })),
            ...(await this.prisma.wallet.findMany({
              where: { status: { in: ['CANDIDATE', 'RETIRED'] } },
              orderBy: [...byScore],
              take: limit,
            })),
          ]
        : await this.prisma.wallet.findMany({
            where: { status },
            orderBy: [...byScore],
            take: limit,
          });
    return this.describeLeaders(wallets.sort(compareLeaders));
  }

  async readLeader(address: string): Promise<LeaderResponse | null> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (wallet === null) {
      return null;
    }
    const [leader] = await this.describeLeaders([wallet]);
    return leader;
  }

  async readLeaderDetail(
    address: string,
  ): Promise<LeaderDetailResponse | null> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (wallet === null) {
      return null;
    }
    const [[leader], state, scores, copies, fills, decisions] =
      await Promise.all([
        this.describeLeaders([wallet]),
        this.prisma.leaderState.findUnique({
          where: { walletAddress: address },
        }),
        this.prisma.walletScore.findMany({
          where: { walletAddress: address },
          orderBy: { createdAt: 'desc' },
          take: SCORE_HISTORY_LIMIT,
        }),
        this.prisma.copyPosition.findMany({
          where: { walletAddress: address },
          orderBy: [{ isOpen: 'desc' }, { openedAt: 'desc' }],
          take: COPIES_LIMIT,
        }),
        this.prisma.leaderFill.findMany({
          where: { walletAddress: address },
          orderBy: [{ time: 'desc' }, { id: 'desc' }],
          take: RECENT_FILLS_LIMIT,
        }),
        this.prisma.copyDecision.findMany({
          where: { walletAddress: address },
          orderBy: { id: 'desc' },
          take: RECENT_DECISIONS_LIMIT,
          include: { orders: { orderBy: { id: 'asc' } } },
        }),
      ]);
    return {
      leader,
      state: state === null ? null : toLeaderStateResponse(state),
      scores: scores.reverse().map(toWalletScoreResponse),
      copies: copies.map((copy) =>
        toCopyPositionResponse(copy, this.bookState.readMark(copy.coin)),
      ),
      recentFills: fills.map(toLeaderFillResponse),
      recentDecisions: decisions.map(toDecisionResponse),
    };
  }

  private async describeLeaders(wallets: Wallet[]): Promise<LeaderResponse[]> {
    if (wallets.length === 0) {
      return [];
    }
    const addresses = wallets.map((wallet) => wallet.address);
    const [lastFills, openCopies, latestScores, evidence] = await Promise.all([
      this.prisma.leaderFill.groupBy({
        by: ['walletAddress'],
        where: { walletAddress: { in: addresses } },
        _max: { time: true },
      }),
      this.prisma.copyPosition.groupBy({
        by: ['walletAddress'],
        where: { walletAddress: { in: addresses }, isOpen: true },
        _count: { _all: true },
      }),
      this.readLatestScores(addresses),
      this.leaders.readEvidence(wallets, new Date()),
    ]);
    const lastFillAt = new Map(
      lastFills.map((row) => [row.walletAddress, row._max.time]),
    );
    const openCopyCounts = new Map(
      openCopies.map((row) => [row.walletAddress, row._count._all]),
    );
    return wallets.map((wallet) =>
      toLeaderResponse(wallet, {
        lastFillAt: lastFillAt.get(wallet.address) ?? null,
        openCopies: openCopyCounts.get(wallet.address) ?? 0,
        copyResults: readCopyResults(evidence.get(wallet.address)),
        latestScore: latestScores.get(wallet.address) ?? null,
      }),
    );
  }

  private async readLatestScores(
    addresses: string[],
  ): Promise<Map<string, WalletScore>> {
    const latest = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT ON (wallet_address) id
      FROM "WalletScore"
      WHERE wallet_address = ANY(${addresses})
      ORDER BY wallet_address, created_at DESC, id DESC`;
    const scores = await this.prisma.walletScore.findMany({
      where: { id: { in: latest.map((row) => row.id) } },
    });
    return new Map(scores.map((score) => [score.walletAddress, score]));
  }
}
