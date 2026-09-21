import { Module } from '@nestjs/common';
import { BooksModule } from '../books/books.module';
import { LeadersModule } from '../leaders/leaders.module';
import { BooksController } from './books.controller';
import { ClustersController } from './clusters.controller';
import { DecisionsController } from './decisions.controller';
import { DiscoveryController } from './discovery.controller';
import { EventsController } from './events.controller';
import { HealthController } from './health.controller';
import { LeaderQueriesService } from './leaderQueries.service';
import { LeadersController } from './leaders.controller';
import { OverviewController } from './overview.controller';

@Module({
  imports: [BooksModule, LeadersModule],
  controllers: [
    HealthController,
    OverviewController,
    LeadersController,
    DecisionsController,
    BooksController,
    ClustersController,
    DiscoveryController,
    EventsController,
  ],
  providers: [LeaderQueriesService],
})
export class ApiModule {}
