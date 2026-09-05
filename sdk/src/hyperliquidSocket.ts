import WebSocket from 'ws';
import type {
  HyperliquidPingMessage,
  HyperliquidSubscription,
  HyperliquidSubscriptionMessage,
  HyperliquidWsFrame,
} from './hyperliquid.js';
import { reconnectDelayMs } from './reconnectDelay.js';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const STABLE_SOCKET_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export type SocketState = 'connecting' | 'open' | 'closed';

export type SubscriptionResult = {
  subscription: HyperliquidSubscription;
  error: string | null;
};

export type HyperliquidSocketStats = {
  state: SocketState;
  connectedAt: number | null;
  reconnects: number;
  pingRoundTripMs: number | null;
};

export type HyperliquidSocketOptions = {
  url: string;
  onFrame: (frame: HyperliquidWsFrame) => void;
  onReopen?: () => void;
  onResubscribeResult?: (result: SubscriptionResult) => void;
  onDisconnect?: (reason: string, reconnectInMs: number) => void;
};

type SubscriptionEntry = {
  key: string;
  subscription: HyperliquidSubscription;
  isSent: boolean;
  isAcknowledged: boolean;
  waiters: ((result: SubscriptionResult) => void)[];
};

type PendingRequest =
  | { method: 'subscribe'; entry: SubscriptionEntry; isResubscribe: boolean }
  | { method: 'unsubscribe'; resolve: () => void };

function subscriptionKey(subscription: HyperliquidSubscription): string {
  return JSON.stringify(subscription, Object.keys(subscription).sort());
}

function parseFrame(data: WebSocket.RawData): HyperliquidWsFrame | null {
  let value: unknown;
  try {
    value = JSON.parse((data as Buffer).toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { channel?: unknown }).channel !== 'string'
  ) {
    return null;
  }
  return value as HyperliquidWsFrame;
}

function describeClose(
  code: number,
  reason: string,
  failure: string | null,
): string {
  const detail = reason ? `code ${code}, ${reason}` : `code ${code}`;
  return `${failure ?? 'closed'} (${detail})`;
}

export class HyperliquidSocket {
  private socket: WebSocket | null = null;
  private state: SocketState = 'closed';
  private isStarted = false;
  private isStopped = false;
  private hasOpened = false;
  private isReady = false;
  private connectedAt: number | null = null;
  private attempt = 0;
  private reconnects = 0;
  private pingSentAt: number | null = null;
  private pingRoundTripMs: number | null = null;
  private lastFailure: string | null = null;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  private pendingRequests: PendingRequest[] = [];

  constructor(private readonly options: HyperliquidSocketOptions) {}

  start(): void {
    if (this.isStarted || this.isStopped) {
      return;
    }
    this.isStarted = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    for (const entry of this.subscriptions.values()) {
      this.settle(entry, 'socket_stopped');
    }
    this.subscriptions.clear();
    this.resetPendingRequests();
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.terminate();
    await closed;
  }

  subscribe(
    subscription: HyperliquidSubscription,
  ): Promise<SubscriptionResult> {
    if (this.isStopped) {
      return Promise.resolve({ subscription, error: 'socket_stopped' });
    }
    const key = subscriptionKey(subscription);
    const existing = this.subscriptions.get(key);
    if (existing?.isAcknowledged) {
      return Promise.resolve({
        subscription: existing.subscription,
        error: null,
      });
    }
    const entry = existing ?? this.addEntry(key, subscription);
    const result = new Promise<SubscriptionResult>((resolve) =>
      entry.waiters.push(resolve),
    );
    if (this.isReady && !entry.isSent) {
      this.sendSubscribe(entry, false);
    }
    return result;
  }

  async unsubscribe(subscription: HyperliquidSubscription): Promise<void> {
    const key = subscriptionKey(subscription);
    const entry = this.subscriptions.get(key);
    if (!entry) {
      return;
    }
    this.subscriptions.delete(key);
    this.settle(entry, 'unsubscribed');
    if (!this.isReady || !entry.isSent) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.pendingRequests.push({ method: 'unsubscribe', resolve });
      this.sendMessage({
        method: 'unsubscribe',
        subscription: entry.subscription,
      });
    });
  }

  readStats(): HyperliquidSocketStats {
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      reconnects: this.reconnects,
      pingRoundTripMs: this.pingRoundTripMs,
    };
  }

  private connect(): void {
    this.state = 'connecting';
    const socket = new WebSocket(this.options.url, {
      family: 4,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.socket = socket;
    socket.on('open', () => this.handleOpen(socket));
    socket.on('message', (data) => {
      if (this.socket === socket) {
        this.handleMessage(data);
      }
    });
    socket.on('error', (error) => {
      this.lastFailure = error.message;
    });
    socket.on('close', (code, reason) =>
      this.handleClose(socket, code, reason.toString()),
    );
  }

  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.state = 'open';
    this.connectedAt = Date.now();
    this.lastFailure = null;
    this.startHeartbeat(socket);
    const isReopen = this.hasOpened;
    this.hasOpened = true;
    try {
      if (isReopen) {
        this.options.onReopen?.();
      }
    } finally {
      if (this.socket === socket && !this.isStopped) {
        this.isReady = true;
        for (const entry of this.subscriptions.values()) {
          if (!entry.isSent) {
            this.sendSubscribe(entry, isReopen);
          }
        }
      }
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    const frame = parseFrame(data);
    if (!frame) {
      return;
    }
    if (frame.channel === 'pong') {
      this.handlePong();
      return;
    }
    if (frame.channel === 'subscriptionResponse') {
      this.answerOldestRequest(null);
      return;
    }
    if (frame.channel === 'error' && this.pendingRequests.length > 0) {
      this.answerOldestRequest(String(frame.data));
      return;
    }
    this.options.onFrame(frame);
  }

  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.state = 'closed';
    this.isReady = false;
    this.stopHeartbeat();
    const wasStable =
      this.connectedAt !== null &&
      Date.now() - this.connectedAt >= STABLE_SOCKET_MS;
    this.connectedAt = null;
    this.resetPendingRequests();
    if (this.isStopped) {
      return;
    }
    if (wasStable) {
      this.attempt = 0;
    }
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnects += 1;
    this.options.onDisconnect?.(
      describeClose(code, reason, this.lastFailure),
      delay,
    );
    this.lastFailure = null;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private answerOldestRequest(error: string | null): void {
    const request = this.pendingRequests.shift();
    if (!request) {
      return;
    }
    if (request.method === 'unsubscribe') {
      request.resolve();
      return;
    }
    const { entry } = request;
    const isCurrent = this.subscriptions.get(entry.key) === entry;
    if (isCurrent && error === null) {
      entry.isAcknowledged = true;
    } else if (isCurrent) {
      this.subscriptions.delete(entry.key);
    }
    this.settle(entry, error);
    if (request.isResubscribe && isCurrent) {
      this.options.onResubscribeResult?.({
        subscription: entry.subscription,
        error,
      });
    }
  }

  private addEntry(
    key: string,
    subscription: HyperliquidSubscription,
  ): SubscriptionEntry {
    const entry: SubscriptionEntry = {
      key,
      subscription,
      isSent: false,
      isAcknowledged: false,
      waiters: [],
    };
    this.subscriptions.set(key, entry);
    return entry;
  }

  private sendSubscribe(
    entry: SubscriptionEntry,
    isResubscribe: boolean,
  ): void {
    entry.isSent = true;
    this.pendingRequests.push({ method: 'subscribe', entry, isResubscribe });
    this.sendMessage({ method: 'subscribe', subscription: entry.subscription });
  }

  private sendMessage(
    message: HyperliquidSubscriptionMessage | HyperliquidPingMessage,
  ): void {
    this.socket?.send(JSON.stringify(message));
  }

  private settle(entry: SubscriptionEntry, error: string | null): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const resolve of waiters) {
      resolve({ subscription: entry.subscription, error });
    }
  }

  private resetPendingRequests(): void {
    for (const request of this.pendingRequests) {
      if (request.method === 'unsubscribe') {
        request.resolve();
      }
    }
    this.pendingRequests = [];
    for (const entry of this.subscriptions.values()) {
      entry.isSent = false;
      entry.isAcknowledged = false;
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.sendPing(socket), PING_INTERVAL_MS);
  }

  private sendPing(socket: WebSocket): void {
    this.pingSentAt = Date.now();
    this.sendMessage({ method: 'ping' });
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.lastFailure = `no pong within ${PONG_TIMEOUT_MS} ms`;
      socket.terminate();
    }, PONG_TIMEOUT_MS);
  }

  private handlePong(): void {
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    if (this.pingSentAt !== null) {
      this.pingRoundTripMs = Date.now() - this.pingSentAt;
      this.pingSentAt = null;
    }
  }

  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    this.pingSentAt = null;
  }
}
