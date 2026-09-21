import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import { NOTIFICATIONS_QUEUE, SEND_TELEGRAM_JOB } from '../jobs/queues';

const TELEGRAM_API_URL = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10_000;
const TOO_MANY_REQUESTS = 429;

const telegramJobSchema = z.object({ text: z.string().min(1).max(4_096) });

@Processor(NOTIFICATIONS_QUEUE, { limiter: { max: 1, duration: 1_000 } })
export class TelegramProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramProcessor.name);
  private readonly botToken: string | undefined;
  private readonly chatId: string | undefined;

  constructor(config: ConfigService<ServerConfig, true>) {
    super();
    this.botToken = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.chatId = config.get('TELEGRAM_CHAT_ID', { infer: true });
  }

  async process(job: Job): Promise<void> {
    if (job.name !== SEND_TELEGRAM_JOB) {
      throw new UnrecoverableError(`Unknown notification job ${job.name}`);
    }
    if (this.botToken === undefined || this.chatId === undefined) {
      return;
    }
    const parsed = telegramJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new UnrecoverableError('A send-telegram job needs a text');
    }
    try {
      await this.sendMessage(parsed.data.text);
      this.logger.log(
        `Job ${job.name} ${job.id ?? ''} sent a Telegram message`,
      );
    } catch (error) {
      this.logger.error(
        `Job ${job.name} ${job.id ?? ''} failed to send a Telegram message`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private async sendMessage(text: string): Promise<void> {
    const response = await fetch(
      `${TELEGRAM_API_URL}/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      return;
    }
    const description = `Telegram answered ${response.status}: ${await response.text()}`;
    if (response.status >= 500 || response.status === TOO_MANY_REQUESTS) {
      throw new Error(description);
    }
    throw new UnrecoverableError(description);
  }
}
