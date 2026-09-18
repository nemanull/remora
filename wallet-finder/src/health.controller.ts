import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  readHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
