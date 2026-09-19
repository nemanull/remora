import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { ServerConfig } from '../config';
import { listJobSchedulers, type ScheduledQueue } from './jobSchedulers';
import {
  MAINTENANCE_QUEUE,
  RECONCILE_LIVE_ACCOUNT_JOB,
  SELECTION_QUEUE,
} from './queues';

@Injectable()
export class JobSchedulersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobSchedulersService.name);

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue,
    @InjectQueue(SELECTION_QUEUE) private readonly selectionQueue: Queue,
    private readonly config: ConfigService<ServerConfig, true>,
  ) {}

  onApplicationBootstrap(): void {
    this.upsertSchedulers().catch((error) =>
      this.logger.error(
        'Failed to upsert the job schedulers',
        error instanceof Error ? error.stack : String(error),
      ),
    );
  }

  private async upsertSchedulers(): Promise<void> {
    const executionMode = this.config.getOrThrow('EXECUTION_MODE', {
      infer: true,
    });
    const schedulers = listJobSchedulers(
      this.config.getOrThrow('DISCOVERY_CRON', { infer: true }),
      executionMode,
    );
    const queues: Record<ScheduledQueue, Queue> = {
      [MAINTENANCE_QUEUE]: this.maintenanceQueue,
      [SELECTION_QUEUE]: this.selectionQueue,
    };
    for (const scheduler of schedulers) {
      await queues[scheduler.queue].upsertJobScheduler(
        scheduler.job,
        scheduler.repeat,
        { name: scheduler.job },
      );
    }
    if (executionMode !== 'live') {
      await this.maintenanceQueue.removeJobScheduler(
        RECONCILE_LIVE_ACCOUNT_JOB,
      );
    }
    this.logger.log(
      `Upserted ${schedulers.length} job schedulers for ${executionMode} mode`,
    );
  }
}
