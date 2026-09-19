import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerConfig } from '../config';
import { JobSchedulersService } from './jobSchedulers.service';
import {
  DISCOVERY_QUEUE,
  MAINTENANCE_QUEUE,
  SCORING_RESULTS_QUEUE,
  SELECTION_QUEUE,
} from './queues';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerConfig, true>) => ({
        connection: { url: config.getOrThrow('REDIS_URL', { infer: true }) },
        defaultJobOptions: {
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 1_000 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: MAINTENANCE_QUEUE },
      { name: SELECTION_QUEUE },
      { name: SCORING_RESULTS_QUEUE },
      { name: DISCOVERY_QUEUE },
    ),
  ],
  providers: [JobSchedulersService],
  exports: [BullModule],
})
export class JobsModule {}
