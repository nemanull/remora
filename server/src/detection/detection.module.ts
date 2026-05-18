import { Module } from '@nestjs/common';
import { ClusterSocket } from './clusterSocket';
import { DetectionController } from './detection.controller';
import { DetectionService } from './detection.service';

@Module({
  controllers: [DetectionController],
  providers: [DetectionService, ClusterSocket],
  exports: [DetectionService],
})
export class DetectionModule {}
