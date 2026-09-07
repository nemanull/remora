import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateCollectorConfig } from './config';
import { HealthController } from './health.controller';
import { WatchlistService } from './watchlist.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateCollectorConfig }),
  ],
  controllers: [HealthController],
  providers: [WatchlistService],
})
export class AppModule {}
