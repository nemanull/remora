import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClustersModule } from './clusters/clusters.module';
import { validateServerConfig } from './config';
import { CopyModule } from './copy/copy.module';
import { CopyEventsModule } from './copy/copyEvents.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { JobsModule } from './jobs/jobs.module';
import { MaintenanceModule } from './jobs/maintenance.module';
import { LeadersModule } from './leaders/leaders.module';
import { MarketModule } from './market/market.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateServerConfig }),
    PrismaModule,
    MetricsModule,
    CopyEventsModule,
    JobsModule,
    CopyModule,
    MarketModule,
    IngestionModule,
    ClustersModule,
    LeadersModule,
    MaintenanceModule,
  ],
})
export class AppModule {}
