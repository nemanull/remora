import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { TelegramProcessor } from './telegram.processor';

@Module({
  providers: [NotificationsService, TelegramProcessor],
})
export class NotificationsModule {}
