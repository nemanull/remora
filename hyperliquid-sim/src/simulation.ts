import { SyntheticMarket } from './market/syntheticMarket';
import { SyntheticHistory } from './traders/syntheticHistory';
import { SyntheticTraders } from './traders/syntheticTraders';
import {
  createSyntheticWallets,
  type SyntheticWallet,
} from './traders/syntheticWallets';

export type SimulationOptions = {
  seed: number;
  walletCount: number;
  speed: number;
  restLagMs?: number;
  startedAt?: number;
  clock?: () => number;
};

export class Simulation {
  readonly seed: number;
  readonly speed: number;
  readonly restLagMs: number;
  readonly startedAt: number;
  readonly market: SyntheticMarket;
  readonly wallets: readonly SyntheticWallet[];
  readonly history: SyntheticHistory;
  readonly traders: SyntheticTraders;
  private readonly clock: () => number;

  constructor(options: SimulationOptions) {
    this.clock = options.clock ?? Date.now;
    this.seed = options.seed;
    this.speed = options.speed;
    this.restLagMs = options.restLagMs ?? 0;
    this.startedAt = options.startedAt ?? this.clock();
    this.market = new SyntheticMarket(this.seed, this.startedAt);
    this.wallets = createSyntheticWallets(
      this.seed,
      options.walletCount,
      this.startedAt,
      this.market.coins,
    );
    this.history = new SyntheticHistory(
      this.seed,
      this.wallets,
      this.startedAt,
    );
    this.traders = new SyntheticTraders(
      this.seed,
      this.speed,
      this.startedAt,
      this.wallets,
      this.market,
      this.history,
    );
  }

  now(): number {
    return this.clock();
  }

  findWallet(address: string): SyntheticWallet | undefined {
    return this.traders.findWallet(address);
  }
}
