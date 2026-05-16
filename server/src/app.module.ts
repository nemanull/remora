import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DetectionModule } from './detection/detection.module';
import { PrismaService } from './prisma.service';

@Module({
  imports: [DetectionModule],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
