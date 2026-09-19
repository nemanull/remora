import { Module } from '@nestjs/common';
import { ClustersModule } from '../clusters/clusters.module';
import { DiscoveryStartService } from './discoveryStart.service';
import { LeadersService } from './leaders.service';
import { ScoreIntakeProcessor } from './scoreIntake.processor';
import { SelectionProcessor } from './selection.processor';

@Module({
  imports: [ClustersModule],
  providers: [
    LeadersService,
    DiscoveryStartService,
    ScoreIntakeProcessor,
    SelectionProcessor,
  ],
  exports: [LeadersService, DiscoveryStartService],
})
export class LeadersModule {}
