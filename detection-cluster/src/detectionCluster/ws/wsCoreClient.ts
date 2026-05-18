import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import WebSocket from 'ws';
import type { WalletStreamEvent } from './wsWalletConnectionEstablishment';

@Injectable()
export class WsCoreClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsCoreClient.name);
  private readonly coreUrl = 'ws://127.0.0.1:3000/cluster';
  private readonly reconnectDelayMs = 5_000;
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  onModuleInit(): void {
    this.connect();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
  }

  sendWalletEvent(event: WalletStreamEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `Core is not connected; dropping ${event.type} event for wallet ${event.wallet}`,
      );
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: 'walletEvent',
        wallet: event.wallet,
        eventType: event.type,
        payload: event.payload,
      }),
    );
  }

  private connect(): void {
    // TODO: auth, anyone can connect
    this.ws = new WebSocket(this.coreUrl);

    this.ws.on('open', () => {
      this.logger.log(`Connected to core at ${this.coreUrl}`);
    });

    this.ws.on('close', () => {
      if (this.stopped) {
        return;
      }
      this.logger.warn(
        `Core connection closed; reconnecting in ${this.reconnectDelayMs} ms`,
      );
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        this.reconnectDelayMs,
      );
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Core connection error: ${err.message}`);
    });
  }
}
