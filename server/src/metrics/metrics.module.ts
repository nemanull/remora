import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobTimingService } from './jobTiming.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [MetricsController],
  providers: [MetricsService, JobTimingService],
  exports: [MetricsService],
})
export class MetricsModule {}
