import { Controller, Get } from '@nestjs/common';
import { Simulation } from '../simulation';
import type { LeaderboardRow, VaultRow } from '../traders/syntheticHistory';

@Controller('stats/Mainnet')
export class StatsController {
  constructor(private readonly simulation: Simulation) {}

  @Get('leaderboard')
  readLeaderboard(): { leaderboardRows: LeaderboardRow[] } {
    return {
      leaderboardRows: this.simulation.history.readLeaderboard(
        this.simulation.now(),
      ),
    };
  }

  @Get('vaults')
  readVaults(): VaultRow[] {
    return this.simulation.history.readVaults(this.simulation.now());
  }
}
