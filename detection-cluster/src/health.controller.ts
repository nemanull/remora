import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { WatchlistService, type CollectorHealth } from './watchlist.service';

export type HealthBody = Omit<CollectorHealth, 'isHealthy'> & {
  status: 'ok' | 'unavailable';
};

@Controller('health')
export class HealthController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  readHealth(): HealthBody {
    const { isHealthy, ...health } = this.watchlist.readHealth();
    if (!isHealthy) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        ...health,
      });
    }
    return { status: 'ok', ...health };
  }
}
