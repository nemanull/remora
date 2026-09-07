import type { HyperliquidInfoClient, PortfolioResponse } from '@remora/sdk';

export type PortfolioPollerOptions = {
  infoClient: Pick<HyperliquidInfoClient, 'portfolio'>;
  intervalMs: number;
  onPortfolio: (
    wallet: string,
    portfolio: PortfolioResponse,
    receivedAt: number,
  ) => void;
  onError: (wallet: string, error: unknown) => void;
};

export class PortfolioPoller {
  private wallets: string[] = [];
  private nextIndex = 0;
  private timer: NodeJS.Timeout | undefined;
  private isStopped = false;
  private readonly polledAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: PortfolioPollerOptions) {}

  setWallets(wallets: string[]): void {
    if (this.isStopped) {
      return;
    }
    const added = wallets.filter((wallet) => !this.wallets.includes(wallet));
    const isUnchanged =
      added.length === 0 && wallets.length === this.wallets.length;
    if (isUnchanged) {
      return;
    }
    this.wallets = [...wallets];
    for (const wallet of this.polledAt.keys()) {
      if (!this.wallets.includes(wallet)) {
        this.polledAt.delete(wallet);
      }
    }
    this.nextIndex = 0;
    for (const wallet of added) {
      this.poll(wallet);
    }
    this.scheduleNext();
  }

  stop(): void {
    this.isStopped = true;
    clearTimeout(this.timer);
    this.wallets = [];
  }

  private scheduleNext(): void {
    clearTimeout(this.timer);
    if (this.isStopped || this.wallets.length === 0) {
      return;
    }
    this.timer = setTimeout(
      () => this.pollNext(),
      this.options.intervalMs / this.wallets.length,
    );
  }

  private pollNext(): void {
    const wallet = this.wallets[this.nextIndex % this.wallets.length];
    this.nextIndex = (this.nextIndex + 1) % this.wallets.length;
    const lastPolledAt = this.polledAt.get(wallet);
    if (
      lastPolledAt === undefined ||
      Date.now() - lastPolledAt >= this.options.intervalMs / 2
    ) {
      this.poll(wallet);
    }
    this.scheduleNext();
  }

  private poll(wallet: string): void {
    if (this.inFlight.has(wallet)) {
      return;
    }
    this.inFlight.add(wallet);
    this.polledAt.set(wallet, Date.now());
    this.options.infoClient.portfolio(wallet).then(
      (portfolio) => {
        this.inFlight.delete(wallet);
        if (!this.isStopped && this.wallets.includes(wallet)) {
          this.options.onPortfolio(wallet, portfolio, Date.now());
        }
      },
      (error: unknown) => {
        this.inFlight.delete(wallet);
        if (!this.isStopped && this.wallets.includes(wallet)) {
          this.options.onError(wallet, error);
        }
      },
    );
  }
}
