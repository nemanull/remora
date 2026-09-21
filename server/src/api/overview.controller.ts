import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LeaderCountsResponse, OverviewResponse } from '@remora/sdk';
import { BookStateService } from '../books/bookState.service';
import { KillSwitchService } from '../books/killSwitch.service';
import type { ServerConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { toBookSummaryResponse, toScoringRunResponse } from './responses';

@Controller('api/overview')
export class OverviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookState: BookStateService,
    private readonly killSwitch: KillSwitchService,
    private readonly config: ConfigService<ServerConfig, true>,
  ) {}

  @Get()
  async readOverview(): Promise<OverviewResponse> {
    const [main, shadow, killSwitch, lastRun, statusCounts] = await Promise.all(
      [
        this.bookState.readBookSummary('MAIN'),
        this.bookState.readBookSummary('SHADOW'),
        this.killSwitch.readKillSwitch(),
        this.prisma.scoringRun.findFirst({
          orderBy: { startedAt: 'desc' },
          include: { _count: { select: { scores: true } } },
        }),
        this.prisma.wallet.groupBy({ by: ['status'], _count: { _all: true } }),
      ],
    );
    const leaderCounts: LeaderCountsResponse = {
      CANDIDATE: 0,
      SHADOW: 0,
      LIVE: 0,
      RETIRED: 0,
    };
    for (const row of statusCounts) {
      leaderCounts[row.status] = row._count._all;
    }
    return {
      mode: this.config.getOrThrow('EXECUTION_MODE', { infer: true }),
      promotionMode: this.config.getOrThrow('PROMOTION_MODE', { infer: true }),
      books: [toBookSummaryResponse(main), toBookSummaryResponse(shadow)],
      killSwitch,
      lastScoringRun:
        lastRun === null
          ? null
          : toScoringRunResponse(lastRun, lastRun._count.scores),
      leaderCounts,
    };
  }
}
