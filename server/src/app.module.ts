import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateServerConfig } from './config';
import { MarketModule } from './market/market.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateServerConfig }),
    PrismaModule,
    MetricsModule,
    MarketModule,
  ],
})
export class AppModule {}
