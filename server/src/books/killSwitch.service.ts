import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import type { ServerConfig } from '../config';
import { CopyEvents } from '../copy/copyEvents';
import type { BookView } from '../copy/types';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookChains } from './bookChains';
import { startOfUtcDay } from './bookEquity';
import { BookStateService } from './bookState.service';

export const DAILY_LOSS_REASON = 'daily_loss_limit';

export type KillSwitchState = {
  active: boolean;
  reason: string | null;
};

export function isBelowDailyLossLimit(
  equityUsd: Decimal,
  dayStartEquity: Decimal | null,
  dailyLossLimit: number,
): boolean {
  if (dayStartEquity === null || dayStartEquity.lte(0)) {
    return false;
  }
  return equityUsd.lte(
    dayStartEquity.mul(new Decimal(1).minus(dailyLossLimit)),
  );
}

@Injectable()
export class KillSwitchService implements OnModuleInit {
  private readonly logger = new Logger(KillSwitchService.name);
  private readonly dailyLossLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookState: BookStateService,
    private readonly chains: BookChains,
    private readonly events: CopyEvents,
    private readonly metrics: MetricsService,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.dailyLossLimit = config.getOrThrow('DAILY_LOSS_LIMIT', {
      infer: true,
    });
  }

  async onModuleInit(): Promise<void> {
    const state = await this.prisma.bookState.findUnique({
      where: { book: 'MAIN' },
    });
    const dayStart = startOfUtcDay(new Date());
    if (state === null || state.dayStartedAt < dayStart) {
      await this.startTradingDay(dayStart);
      return;
    }
    this.metrics.killSwitchActive.set(
      { book: 'MAIN' },
      state.killSwitchActive ? 1 : 0,
    );
  }

  async setKillSwitch(active: boolean, reason: string | null): Promise<void> {
    const storedReason = active ? reason : null;
    await this.prisma.bookState.update({
      where: { book: 'MAIN' },
      data: { killSwitchActive: active, killSwitchReason: storedReason },
    });
    this.metrics.killSwitchActive.set({ book: 'MAIN' }, active ? 1 : 0);
    this.events.publish({
      type: 'killSwitch',
      book: 'MAIN',
      active,
      reason: storedReason,
    });
    this.logger.warn(
      active
        ? `Kill switch set on the MAIN book${storedReason === null ? '' : `: ${storedReason}`}`
        : 'Kill switch cleared on the MAIN book',
    );
  }

  async readKillSwitch(): Promise<KillSwitchState> {
    const state = await this.prisma.bookState.findUniqueOrThrow({
      where: { book: 'MAIN' },
    });
    return { active: state.killSwitchActive, reason: state.killSwitchReason };
  }

  async enforceDailyLossLimit(view: BookView): Promise<BookView> {
    if (
      view.book !== 'MAIN' ||
      view.killSwitchActive ||
      !isBelowDailyLossLimit(
        view.equityUsd,
        view.dayStartEquity,
        this.dailyLossLimit,
      )
    ) {
      return view;
    }
    const reason = `${DAILY_LOSS_REASON}: equity ${view.equityUsd.toFixed(2)} USD against the day's start ${view.dayStartEquity?.toFixed(2)} USD`;
    await this.setKillSwitch(true, reason);
    return { ...view, killSwitchActive: true, killSwitchReason: reason };
  }

  rollTradingDay(now: Date): Promise<void> {
    return this.chains.run('MAIN', '', () =>
      this.startTradingDay(startOfUtcDay(now)),
    );
  }

  private async startTradingDay(dayStart: Date): Promise<void> {
    const equity = await this.bookState.readMainEquity();
    const previous = await this.prisma.bookState.findUnique({
      where: { book: 'MAIN' },
    });
    const clearsDailyLoss =
      previous?.killSwitchActive === true &&
      (previous.killSwitchReason ?? '').startsWith(DAILY_LOSS_REASON);
    const active = clearsDailyLoss
      ? false
      : (previous?.killSwitchActive ?? false);
    const reason = active ? (previous?.killSwitchReason ?? null) : null;
    await this.prisma.bookState.upsert({
      where: { book: 'MAIN' },
      create: {
        book: 'MAIN',
        dayStartedAt: dayStart,
        dayStartEquity: equity.toFixed(2),
        killSwitchActive: false,
      },
      update: {
        dayStartedAt: dayStart,
        dayStartEquity: equity.toFixed(2),
        killSwitchActive: active,
        killSwitchReason: reason,
      },
    });
    this.metrics.killSwitchActive.set({ book: 'MAIN' }, active ? 1 : 0);
    this.logger.log(
      `Trading day ${dayStart.toISOString().slice(0, 10)} started with MAIN equity ${equity.toFixed(2)} USD`,
    );
    if (clearsDailyLoss) {
      this.events.publish({
        type: 'killSwitch',
        book: 'MAIN',
        active: false,
        reason: null,
      });
      this.logger.warn('Kill switch cleared by the new trading day');
    }
  }
}
