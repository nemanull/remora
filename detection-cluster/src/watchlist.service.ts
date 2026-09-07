import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HyperliquidInfoClient,
  HyperliquidSocket,
  PROTOCOL_VERSION,
  WeightBudget,
  normalizeAddress,
  type AssignMessage,
  type BackfillState,
  type CollectorStats,
  type HyperliquidClearinghouseStateData,
  type HyperliquidFill,
  type HyperliquidSubscription,
  type HyperliquidUserFillsData,
  type HyperliquidWsFrame,
  type PortfolioResponse,
  type SocketState,
  type SubscriptionResult,
} from '@remora/sdk';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { buildCollectorStats } from './collectorStats';
import { readCollectorVersion, type CollectorConfig } from './config';
import { CoreLink, type CoreLinkState } from './coreLink';
import { BACKFILL_LAG_LIMIT_MS, readFillsSince } from './fillBackfill';
import { PortfolioPoller } from './portfolioPoller';

const USER_LIMIT_PREFIX = 'Cannot track more than';

type WatchedWallet = {
  address: string;
  fillsSince: number;
  hasFillsSubscription: boolean;
  hasStateSubscription: boolean;
  subscribedAt: number | null;
  lastEventAt: number | null;
  lastSentFillTime: number | null;
  backfill: BackfillState;
  backfillFrom: number | null;
  backfillCursor: number;
  isBackfillTruncated: boolean;
  backfillTarget: number | null;
  backfillRun: AbortController | null;
};

type WalletFailure = { address: string; reason: string };

export type WalletHealth = {
  address: string;
  isSubscribed: boolean;
  backfill: BackfillState;
};

export type CollectorHealth = {
  isHealthy: boolean;
  coreLink: CoreLinkState;
  upstream: SocketState;
  wallets: WalletHealth[];
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newestFillTime(fills: HyperliquidFill[]): number | null {
  return fills.length === 0
    ? null
    : Math.max(...fills.map((fill) => fill.time));
}

function oldestFillTime(fills: HyperliquidFill[]): number | null {
  return fills.length === 0
    ? null
    : Math.min(...fills.map((fill) => fill.time));
}

function isBackfillComplete(state: BackfillState): boolean {
  return state === 'synced' || state === 'truncated' || state === 'lagging';
}

function classifyRefusal(error: string): string {
  return error.startsWith(USER_LIMIT_PREFIX)
    ? 'user_limit'
    : 'subscription_refused';
}

function userFillsSubscription(address: string): HyperliquidSubscription {
  return { type: 'userFills', user: address };
}

function clearinghouseStateSubscription(
  address: string,
): HyperliquidSubscription {
  return { type: 'clearinghouseState', user: address };
}

function isUserFillsData(value: unknown): value is HyperliquidUserFillsData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { user?: unknown }).user === 'string' &&
    Array.isArray((value as { fills?: unknown }).fills)
  );
}

function isClearinghouseStateData(
  value: unknown,
): value is HyperliquidClearinghouseStateData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { user?: unknown }).user === 'string' &&
    typeof (value as { clearinghouseState?: unknown }).clearinghouseState ===
      'object'
  );
}

@Injectable()
export class WatchlistService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WatchlistService.name);
  private readonly wallets = new Map<string, WatchedWallet>();
  private readonly failures = new Map<string, string>();
  private readonly clusterId: number;
  private readonly maxWallets: number;
  private readonly sessionId = randomUUID();
  private readonly version = readCollectorVersion();
  private readonly budget: WeightBudget;
  private readonly infoClient: HyperliquidInfoClient;
  private readonly socket: HyperliquidSocket;
  private readonly link: CoreLink;
  private readonly poller: PortfolioPoller;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private session = 0;
  private hasAssignInSession = false;
  private assignVersion: number | null = null;
  private assignments: Promise<void> = Promise.resolve();

  constructor(config: ConfigService<CollectorConfig, true>) {
    this.clusterId = config.getOrThrow('CLUSTER_ID', { infer: true });
    this.maxWallets = config.getOrThrow('MAX_WALLETS', { infer: true });
    this.budget = new WeightBudget(
      config.getOrThrow('HYPERLIQUID_WEIGHT_PER_MINUTE', { infer: true }),
    );
    this.infoClient = new HyperliquidInfoClient(
      config.getOrThrow('HYPERLIQUID_API_URL', { infer: true }),
      this.budget,
    );
    this.socket = new HyperliquidSocket({
      url: config.getOrThrow('HYPERLIQUID_WS_URL', { infer: true }),
      onFrame: (frame) => this.handleUpstreamFrame(frame),
      onReopen: () => this.handleUpstreamReopen(),
      onResubscribeResult: (result) => this.handleResubscribeResult(result),
      onDisconnect: (reason, reconnectInMs) =>
        this.handleUpstreamDisconnect(reason, reconnectInMs),
    });
    this.link = new CoreLink({
      url: config.getOrThrow('CORE_URL', { infer: true }),
      token: config.getOrThrow('CLUSTER_TOKEN', { infer: true }),
      createHello: () => ({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clusterId: this.clusterId,
        sessionId: this.sessionId,
        maxWallets: this.maxWallets,
        version: this.version,
      }),
      readStats: () => this.readStats(),
      onOpen: () => this.handleLinkOpen(),
      onAssign: (assign) => this.handleAssign(assign),
      onClose: (reason, reconnectInMs) =>
        this.handleLinkClose(reason, reconnectInMs),
      onInvalidFrame: (reason) =>
        this.logger.warn(`Dropped an invalid frame from the core: ${reason}`),
    });
    this.poller = new PortfolioPoller({
      infoClient: this.infoClient,
      intervalMs: config.getOrThrow('PORTFOLIO_POLL_MS', { infer: true }),
      onPortfolio: (wallet, portfolio, receivedAt) =>
        this.forwardPortfolio(wallet, portfolio, receivedAt),
      onError: (wallet, error) =>
        this.logger.warn(
          `Portfolio poll of wallet ${wallet} failed: ${describeError(error)}`,
        ),
    });
  }

  onApplicationBootstrap(): void {
    this.eventLoopDelay.enable();
    this.socket.start();
    this.link.start();
    this.logger.log(
      `Collector ${this.clusterId} started session ${this.sessionId} for at most ${this.maxWallets} wallets`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.poller.stop();
    for (const wallet of this.wallets.values()) {
      this.abortBackfill(wallet);
    }
    await Promise.all([this.link.stop(), this.socket.stop()]);
    this.eventLoopDelay.disable();
  }

  readHealth(): CollectorHealth {
    const wallets = [...this.wallets.values()].map((wallet) => ({
      address: wallet.address,
      isSubscribed: wallet.subscribedAt !== null,
      backfill: wallet.backfill,
    }));
    return {
      isHealthy:
        this.link.isOpen && wallets.every((wallet) => wallet.isSubscribed),
      coreLink: this.link.readState(),
      upstream: this.socket.readStats().state,
      wallets,
    };
  }

  readStats(): CollectorStats {
    return buildCollectorStats({
      socket: this.socket.readStats(),
      clockOffsetMs: this.link.readClockOffsetMs(),
      eventLoopDelay: this.eventLoopDelay,
      budget: this.budget,
      wallets: [...this.wallets.values()].map((wallet) => ({
        address: wallet.address,
        subscribedAt: wallet.subscribedAt,
        lastEventAt: wallet.lastEventAt,
        backfill: wallet.backfill,
      })),
    });
  }

  private handleLinkOpen(): void {
    this.session += 1;
    this.hasAssignInSession = false;
    this.assignVersion = null;
    this.failures.clear();
    for (const wallet of this.wallets.values()) {
      this.abortBackfill(wallet);
      wallet.backfill = 'pending';
      wallet.backfillFrom = null;
      wallet.lastSentFillTime = null;
      wallet.isBackfillTruncated = false;
    }
    this.logger.log(
      `Core link of cluster ${this.clusterId} opened session ${this.session}`,
    );
  }

  private handleLinkClose(reason: string, reconnectInMs: number): void {
    for (const wallet of this.wallets.values()) {
      this.raiseBackfillTarget(wallet, wallet.lastSentFillTime);
      this.abortBackfill(wallet);
      wallet.backfill = 'pending';
      wallet.backfillFrom = null;
    }
    this.logger.warn(
      `Core link of cluster ${this.clusterId} closed: ${reason}, reconnecting in ${Math.round(reconnectInMs)} ms`,
    );
  }

  private handleAssign(assign: AssignMessage): void {
    const session = this.session;
    this.assignments = this.assignments
      .then(() => this.applyAssignment(assign, session))
      .catch((error: unknown) =>
        this.logger.error(
          `Applying assign version ${assign.version} failed`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }

  private async applyAssignment(
    assign: AssignMessage,
    session: number,
  ): Promise<void> {
    if (session !== this.session) {
      return;
    }
    const isFirstOfSession = !this.hasAssignInSession;
    this.hasAssignInSession = true;
    this.assignVersion = assign.version;
    this.failures.clear();
    const unique = [
      ...new Map(
        assign.wallets.map((entry) => [entry.address, entry]),
      ).values(),
    ];
    const accepted = unique.slice(0, this.maxWallets);
    for (const entry of unique.slice(this.maxWallets)) {
      this.failures.set(entry.address, 'over_capacity');
    }
    const acceptedAddresses = new Set(accepted.map((entry) => entry.address));
    const removed = [...this.wallets.keys()].filter(
      (address) => !acceptedAddresses.has(address),
    );
    for (const address of removed) {
      this.removeWallet(address);
    }
    const added: string[] = [];
    for (const entry of accepted) {
      let wallet = this.wallets.get(entry.address);
      if (!wallet) {
        wallet = this.createWallet(entry.address, entry.fillsSince);
        this.wallets.set(entry.address, wallet);
        added.push(entry.address);
      }
      if (isFirstOfSession || added.includes(entry.address)) {
        this.abortBackfill(wallet);
        wallet.fillsSince = entry.fillsSince;
        wallet.backfillFrom = entry.fillsSince;
        wallet.backfillCursor = entry.fillsSince;
        wallet.backfill = 'pending';
      }
    }
    this.poller.setWallets([...this.wallets.keys()]);
    this.logger.log(
      `Applying assign version ${assign.version} of cluster ${this.clusterId}: ${accepted.length} wallets, ${added.length} added, ${removed.length} removed, ${this.failures.size} over capacity`,
    );
    const failures = await Promise.all(
      added.map((address) => this.subscribeWallet(address)),
    );
    for (const failure of failures) {
      if (failure) {
        this.failWallet(failure.address, failure.reason, false);
      }
    }
    if (session !== this.session) {
      return;
    }
    this.sendAssigned();
    this.startPendingBackfills();
  }

  private createWallet(address: string, fillsSince: number): WatchedWallet {
    return {
      address,
      fillsSince,
      hasFillsSubscription: false,
      hasStateSubscription: false,
      subscribedAt: null,
      lastEventAt: null,
      lastSentFillTime: null,
      backfill: 'pending',
      backfillFrom: null,
      backfillCursor: fillsSince,
      isBackfillTruncated: false,
      backfillTarget: null,
      backfillRun: null,
    };
  }

  private async subscribeWallet(
    address: string,
  ): Promise<WalletFailure | null> {
    const results = await Promise.all([
      this.socket.subscribe(userFillsSubscription(address)),
      this.socket.subscribe(clearinghouseStateSubscription(address)),
    ]);
    const wallet = this.wallets.get(address);
    if (!wallet) {
      return null;
    }
    const error =
      results.find((result) => result.error !== null)?.error ?? null;
    if (error === 'unsubscribed' || error === 'socket_stopped') {
      return null;
    }
    if (error !== null) {
      return { address, reason: classifyRefusal(error) };
    }
    for (const result of results) {
      this.markSubscribed(wallet, result.subscription);
    }
    return null;
  }

  private markSubscribed(
    wallet: WatchedWallet,
    subscription: HyperliquidSubscription,
  ): void {
    if (subscription.type === 'userFills') {
      wallet.hasFillsSubscription = true;
    } else if (subscription.type === 'clearinghouseState') {
      wallet.hasStateSubscription = true;
    }
    if (
      wallet.hasFillsSubscription &&
      wallet.hasStateSubscription &&
      wallet.subscribedAt === null
    ) {
      wallet.subscribedAt = Date.now();
    }
  }

  private failWallet(
    address: string,
    reason: string,
    shouldReport: boolean,
  ): void {
    if (!this.wallets.has(address)) {
      return;
    }
    this.removeWallet(address);
    this.failures.set(address, reason);
    this.poller.setWallets([...this.wallets.keys()]);
    this.logger.warn(
      `Hyperliquid refused wallet ${address} of cluster ${this.clusterId}: ${reason}`,
    );
    if (shouldReport) {
      this.sendAssigned();
    }
  }

  private removeWallet(address: string): void {
    const wallet = this.wallets.get(address);
    if (!wallet) {
      return;
    }
    this.abortBackfill(wallet);
    this.wallets.delete(address);
    for (const subscription of [
      userFillsSubscription(address),
      clearinghouseStateSubscription(address),
    ]) {
      this.socket
        .unsubscribe(subscription)
        .catch((error: unknown) =>
          this.logger.warn(
            `Unsubscribing wallet ${address} failed: ${describeError(error)}`,
          ),
        );
    }
  }

  private sendAssigned(): void {
    if (this.assignVersion === null) {
      return;
    }
    this.link.send({
      type: 'assigned',
      version: this.assignVersion,
      subscribed: [...this.wallets.keys()],
      failed: [...this.failures].map(([address, reason]) => ({
        address,
        reason,
      })),
    });
  }

  private handleUpstreamFrame(frame: HyperliquidWsFrame): void {
    const receivedAt = Date.now();
    if (frame.channel === 'userFills' && isUserFillsData(frame.data)) {
      const wallet = this.findWallet(frame.data.user);
      if (!wallet) {
        return;
      }
      wallet.lastEventAt = receivedAt;
      const fills = frame.data.fills;
      const isSnapshot = frame.data.isSnapshot === true;
      if (isSnapshot) {
        this.raiseBackfillTarget(wallet, oldestFillTime(fills));
      }
      const isSent =
        this.canForward() &&
        this.link.send({
          type: 'event',
          wallet: wallet.address,
          channel: 'userFills',
          source: isSnapshot ? 'snapshot' : 'stream',
          receivedAt,
          payload: frame.data,
        });
      if (!isSent) {
        this.raiseBackfillTarget(wallet, newestFillTime(fills));
        return;
      }
      this.recordSentFills(wallet, fills);
      if (isSnapshot && isBackfillComplete(wallet.backfill)) {
        wallet.backfillTarget = null;
      }
      return;
    }
    if (
      frame.channel === 'clearinghouseState' &&
      isClearinghouseStateData(frame.data)
    ) {
      const wallet = this.findWallet(frame.data.user);
      if (!wallet) {
        return;
      }
      wallet.lastEventAt = receivedAt;
      if (this.canForward()) {
        this.link.send({
          type: 'event',
          wallet: wallet.address,
          channel: 'clearinghouseState',
          source: 'stream',
          receivedAt,
          payload: frame.data,
        });
      }
      return;
    }
    if (frame.channel === 'error') {
      this.logger.warn(
        `Hyperliquid sent an error no request was waiting for: ${String(frame.data)}`,
      );
    }
  }

  private handleUpstreamReopen(): void {
    if (!this.link.isOpen || !this.hasAssignInSession) {
      this.logger.log(
        'Hyperliquid socket reopened while the core link is down, the next session backfills every wallet',
      );
      return;
    }
    this.link.send({ type: 'syncStarted', wallets: [...this.wallets.keys()] });
    for (const wallet of this.wallets.values()) {
      const resumeFrom = this.readResumeTime(wallet);
      this.abortBackfill(wallet);
      wallet.backfillFrom = resumeFrom;
      wallet.backfill = 'pending';
    }
    this.logger.log(
      `Hyperliquid socket reopened, resyncing ${this.wallets.size} wallets of cluster ${this.clusterId}`,
    );
  }

  private handleResubscribeResult(result: SubscriptionResult): void {
    if (!('user' in result.subscription)) {
      return;
    }
    const wallet = this.findWallet(result.subscription.user);
    if (!wallet) {
      return;
    }
    if (result.error !== null) {
      this.failWallet(
        wallet.address,
        classifyRefusal(result.error),
        this.hasAssignInSession,
      );
      return;
    }
    this.markSubscribed(wallet, result.subscription);
    this.startPendingBackfills();
  }

  private handleUpstreamDisconnect(
    reason: string,
    reconnectInMs: number,
  ): void {
    for (const wallet of this.wallets.values()) {
      wallet.hasFillsSubscription = false;
      wallet.hasStateSubscription = false;
      wallet.subscribedAt = null;
    }
    this.logger.warn(
      `Hyperliquid socket of cluster ${this.clusterId} closed: ${reason}, reconnecting in ${Math.round(reconnectInMs)} ms`,
    );
  }

  private readResumeTime(wallet: WatchedWallet): number {
    if (wallet.backfillFrom !== null) {
      return wallet.backfillFrom;
    }
    if (isBackfillComplete(wallet.backfill)) {
      return Math.max(
        wallet.backfillCursor,
        wallet.lastSentFillTime ?? wallet.backfillCursor,
      );
    }
    return wallet.backfillCursor;
  }

  private raiseBackfillTarget(
    wallet: WatchedWallet,
    time: number | null,
  ): void {
    if (
      time !== null &&
      (wallet.backfillTarget === null || time > wallet.backfillTarget)
    ) {
      wallet.backfillTarget = time;
    }
  }

  private startPendingBackfills(): void {
    if (!this.canForward()) {
      return;
    }
    for (const wallet of this.wallets.values()) {
      if (
        wallet.backfillFrom !== null &&
        wallet.hasFillsSubscription &&
        wallet.backfillRun === null
      ) {
        const from = wallet.backfillFrom;
        const run = new AbortController();
        wallet.backfillFrom = null;
        wallet.backfillRun = run;
        wallet.backfill = 'running';
        wallet.backfillCursor = from;
        wallet.isBackfillTruncated = false;
        void this.runBackfill(wallet, from, run);
      }
    }
  }

  private async runBackfill(
    wallet: WatchedWallet,
    from: number,
    run: AbortController,
  ): Promise<void> {
    this.logger.log(
      `Backfilling wallet ${wallet.address} from ${new Date(from).toISOString()}`,
    );
    let pages = 0;
    let fills = 0;
    let isLagging = false;
    try {
      for await (const page of readFillsSince(
        this.infoClient,
        wallet.address,
        from,
        {
          signal: run.signal,
          onRetry: (error, attempt, delayMs) => {
            if (run.signal.aborted) {
              return;
            }
            wallet.backfill = 'retrying';
            this.logger.warn(
              `Backfill page of wallet ${wallet.address} failed on attempt ${attempt}, retrying in ${Math.round(delayMs)} ms: ${describeError(error)}`,
            );
          },
          readTargetTime: () => wallet.backfillTarget,
          onLagWait: (coveredUntil, targetTime, delayMs) => {
            if (!run.signal.aborted) {
              this.logger.log(
                `REST fills of wallet ${wallet.address} end at ${new Date(coveredUntil).toISOString()} before ${new Date(targetTime).toISOString()}, reading again in ${Math.round(delayMs)} ms`,
              );
            }
          },
        },
      )) {
        if (run.signal.aborted) {
          return;
        }
        wallet.backfill = 'running';
        pages += 1;
        if (page.fills.length > 0) {
          const isSent = this.link.send({
            type: 'event',
            wallet: wallet.address,
            channel: 'userFills',
            source: 'backfill',
            receivedAt: page.receivedAt,
            payload: page.fills,
          });
          if (isSent) {
            this.recordSentFills(wallet, page.fills);
          }
          fills += page.fills.length;
        }
        wallet.backfillCursor = page.nextStartTime;
        wallet.isBackfillTruncated ||= page.isTruncated;
        isLagging ||= page.isLagging;
      }
      if (run.signal.aborted) {
        return;
      }
      wallet.backfillRun = null;
      wallet.backfillTarget = null;
      if (isLagging) {
        wallet.backfill = 'lagging';
      } else {
        wallet.backfill = wallet.isBackfillTruncated ? 'truncated' : 'synced';
      }
      this.link.send({ type: 'synced', wallet: wallet.address });
      const message = `Wallet ${wallet.address} synced after ${pages} backfill pages with ${fills} fills`;
      if (isLagging) {
        this.logger.warn(
          `${message}, while REST still lagged the newest fill it must cover after ${BACKFILL_LAG_LIMIT_MS} ms`,
        );
      } else if (wallet.isBackfillTruncated) {
        this.logger.warn(`${message}, truncated at the 10,000 fill horizon`);
      } else {
        this.logger.log(message);
      }
    } catch (error) {
      if (run.signal.aborted) {
        return;
      }
      wallet.backfillRun = null;
      wallet.backfill = 'pending';
      wallet.backfillFrom = wallet.backfillCursor;
      this.logger.error(
        `Backfill of wallet ${wallet.address} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private forwardPortfolio(
    address: string,
    portfolio: PortfolioResponse,
    receivedAt: number,
  ): void {
    if (!this.wallets.has(address) || !this.canForward()) {
      return;
    }
    this.link.send({
      type: 'event',
      wallet: address,
      channel: 'portfolio',
      source: 'poll',
      receivedAt,
      payload: portfolio,
    });
  }

  private recordSentFills(
    wallet: WatchedWallet,
    fills: HyperliquidFill[],
  ): void {
    for (const fill of fills) {
      if (
        wallet.lastSentFillTime === null ||
        fill.time > wallet.lastSentFillTime
      ) {
        wallet.lastSentFillTime = fill.time;
      }
    }
  }

  private abortBackfill(wallet: WatchedWallet): void {
    wallet.backfillRun?.abort();
    wallet.backfillRun = null;
  }

  private findWallet(user: string): WatchedWallet | undefined {
    const address = normalizeAddress(user);
    return address === null ? undefined : this.wallets.get(address);
  }

  private canForward(): boolean {
    return this.link.isOpen && this.hasAssignInSession;
  }
}
