import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' },
    }),
    QueueModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
