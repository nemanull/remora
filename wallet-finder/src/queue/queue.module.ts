import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SCORING_QUEUE, ScoringWorker } from './scoring.worker';

@Module({
  imports: [BullModule.registerQueue({ name: SCORING_QUEUE })],
  providers: [ScoringWorker],
})
export class QueueModule {}
