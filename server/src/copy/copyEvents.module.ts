import { Global, Module } from '@nestjs/common';
import { CopyEvents } from './copyEvents';

@Global()
@Module({
  providers: [CopyEvents],
  exports: [CopyEvents],
})
export class CopyEventsModule {}
