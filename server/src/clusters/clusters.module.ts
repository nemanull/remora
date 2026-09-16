import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { MarketModule } from '../market/market.module';
import { AssignmentService } from './assignment.service';
import { ClusterLinkService } from './clusterLink.service';
import { ClusterRegistryService } from './clusterRegistry.service';

@Module({
  imports: [IngestionModule, MarketModule],
  providers: [ClusterRegistryService, AssignmentService, ClusterLinkService],
  exports: [ClusterRegistryService, AssignmentService, ClusterLinkService],
})
export class ClustersModule {}
