import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Subscription } from 'rxjs';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import { NOTIFICATIONS_QUEUE, SEND_TELEGRAM_JOB } from '../jobs/queues';

const SEND_ATTEMPTS = 5;
const SEND_BACKOFF_MS = 5_000;

export type TelegramJob = { text: string };

export function describeNotification(event: CopyEvent): string | null {
  switch (event.type) {
    case 'copy':
      if (event.book !== 'MAIN' || event.change === 'resized') {
        return null;
      }
      return event.change === 'opened'
        ? `Copy opened on ${event.coin} with size ${event.size} after leader ${event.wallet}`
        : `Copy closed on ${event.coin} after leader ${event.wallet} with realized PnL ${event.realizedPnl} USD`;
    case 'order':
      return event.status === 'REJECTED'
        ? `${event.book} ${event.purpose} order on ${event.coin} was rejected: ${event.error ?? 'no error text'}`
        : null;
    case 'killSwitch':
      return event.active
        ? `Kill switch set on the ${event.book} book: ${event.reason ?? 'no reason given'}`
        : `Kill switch cleared on the ${event.book} book`;
    case 'alert':
      return `Alert ${event.code}: ${event.message}`;
    default:
      return null;
  }
}

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly isEnabled: boolean;
  private readonly executionMode: string;
  private subscription: Subscription | undefined;

  constructor(
    private readonly events: CopyEvents,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.isEnabled =
      config.get('TELEGRAM_BOT_TOKEN', { infer: true }) !== undefined &&
      config.get('TELEGRAM_CHAT_ID', { infer: true }) !== undefined;
    this.executionMode = config.getOrThrow('EXECUTION_MODE', { infer: true });
  }

  onModuleInit(): void {
    if (!this.isEnabled) {
      this.logger.log(
        'Telegram notifications are off because TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is unset',
      );
      return;
    }
    this.subscription = this.events.events$.subscribe((event) => {
      const text = describeNotification(event);
      if (text !== null) {
        this.enqueue(`[${this.executionMode}] ${text}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private enqueue(text: string): void {
    const job: TelegramJob = { text };
    this.queue
      .add(SEND_TELEGRAM_JOB, job, {
        attempts: SEND_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_BACKOFF_MS },
      })
      .catch((error) =>
        this.logger.error(
          `Failed to queue the Telegram message "${text}"`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }
}
