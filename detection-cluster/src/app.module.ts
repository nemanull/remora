import { Module } from '@nestjs/common';
import { DetectionClusterModule } from './detectionCluster/dc.module';

@Module({
  imports: [DetectionClusterModule],
})
export class AppModule {}
