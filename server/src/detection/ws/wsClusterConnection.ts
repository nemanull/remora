import { Logger } from '@nestjs/common';
import type {
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from '@copy-quant/sdk';
import WebSocket from 'ws';

export type ClusterWalletEvent =
  | {
      type: 'walletEvent';
      wallet: string;
      eventType: 'userFills';
      payload: HyperliquidWsUserFillsEvent;
    }
  | {
      type: 'walletEvent';
      wallet: string;
      eventType: 'clearinghouseState';
      payload: HyperliquidWsClearinghouseStateEvent;
    };

export class WsClusterConnection {
  private readonly logger = new Logger(WsClusterConnection.name);
  private readonly pingIntervalMs = 30_000;
  private readonly reconnectDelayMs = 5_000;
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onWalletEvent: (event: ClusterWalletEvent) => void,
  ) {}

  connect() {
    this.stopped = false;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.logger.log(`Connected to cluster at ${this.url}`);
      this.startPingLoop();
    });

    this.ws.on('message', (rawMessage: WebSocket.RawData) => {
      this.handleMessage(rawMessage.toString());
    });

    this.ws.on('close', () => {
      this.stopPingLoop();
      if (this.stopped) {
        return;
      }
      // TODO: backoff
      this.logger.warn(
        `Cluster connection closed; reconnecting in ${this.reconnectDelayMs} ms`,
      );
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        this.reconnectDelayMs,
      );
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Cluster connection error: ${err.message}`);
    });
  }

  disconnect() {
    this.stopped = true;
    this.stopPingLoop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
  }

  private handleMessage(rawMessage: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      this.logger.error(`Failed to parse cluster message: ${rawMessage}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      this.logger.error(`Invalid cluster message: ${rawMessage}`);
      return;
    }

    const type = (parsed as { type?: string }).type;
    if (type === 'walletEvent') {
      this.onWalletEvent(parsed as ClusterWalletEvent);
      return;
    }

    if (type === 'info') {
      const message = (parsed as { message?: string }).message;
      this.logger.log(`Cluster says: ${message}`);
    }
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      this.ws.send(JSON.stringify({ type: 'info', message: 'ping' }));
    }, this.pingIntervalMs);
  }

  private stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
