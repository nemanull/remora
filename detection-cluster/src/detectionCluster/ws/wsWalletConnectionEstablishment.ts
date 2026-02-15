import { Logger } from '@nestjs/common';
import type {
  HyperliquidSubscriptionMessage,
  HyperliquidTrackedWsEvent,
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from '@copy-quant/sdk';
import WebSocket from 'ws';

export type WalletStreamEventType = 'userFills' | 'clearinghouseState';

export type WalletStreamEvent =
  | {
      wallet: string;
      type: 'userFills';
      payload: HyperliquidWsUserFillsEvent;
    }
  | {
      wallet: string;
      type: 'clearinghouseState';
      payload: HyperliquidWsClearinghouseStateEvent;
    };

export class wsWalletConnectionEstablishmentService {
  private readonly logger = new Logger(wsWalletConnectionEstablishmentService.name);
  private readonly wsUrl = 'wss://api.hyperliquid.xyz/ws';
  private readonly pingIntervalMs = 45_000;
  private ws: WebSocket;
  private connection: boolean = false;
  private wallet: string;
  private pingTimer?: NodeJS.Timeout;
  private readonly onEvent?: (event: WalletStreamEvent) => void;


  constructor(
    wallet: string,
    onEvent?: (event: WalletStreamEvent) => void,
  ) {
    this.wallet = wallet;
    this.onEvent = onEvent;
  }


  async establishConnection(){
    if(this.connection) {
      this.logger.log(`WebSocket already established for wallet ${this.wallet}`);
      return;
    }

    this.openConnection();
  }

  openConnection() {
    this.ws = new WebSocket(this.wsUrl);

    if(!this.ws) {
      this.logger.error(`Failed to create WebSocket for wallet ${this.wallet}`);
      return;
    }

    this.ws.on('open', () => {
      this.connection = true;
      this.subscribeToUserFills();
      this.subscribeToClearingHouseState();
      this.startPingLoop();
      this.logger.log(`WebSocket opened for wallet ${this.wallet}`);
    });

    this.ws.on('close', () => {
      this.connection = false;
      this.stopPingLoop();
      this.logger.log(`WebSocket closed for wallet ${this.wallet}`);
    });

    this.ws.on('error', (err) => {
      this.connection = false;
      this.stopPingLoop();
      this.logger.error(`WebSocket error for wallet ${this.wallet}: ${err.message}`);
    });

    this.ws.on('message', (rawData) => {
      this.handleIncomingMessage(rawData);
    });
  }


  closeConnection() {
    if(!this.connection) {
      this.logger.log(`WebSocket already closed for wallet ${this.wallet}`);
      return;
    }

    this.ws.close();
    this.connection = false;
    this.stopPingLoop();
  }

  subscribeToUserFills(){
    if(this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Skipping user fills subscription; socket not open for wallet ${this.wallet}`);
      return;
    }

    const message: HyperliquidSubscriptionMessage = {
      method: "subscribe",
      subscription: {
        type: "userFills",
        user: this.wallet,
      },
    };
    this.ws.send(JSON.stringify(message));

    this.logger.log(`Subscribed to user fills for wallet ${this.wallet}`);
  }

  subscribeToClearingHouseState(){
    if(this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Skipping clearinghouseState subscription; socket not open for wallet ${this.wallet}`);
      return;
    }

    const message: HyperliquidSubscriptionMessage = {
      method: "subscribe",
      subscription: {
        type: "clearinghouseState",
        user: this.wallet,
      },
    };
    this.ws.send(JSON.stringify(message));

    this.logger.log(`Subscribed to clearinghouse state for wallet ${this.wallet}`);
  }

  ping(){
    if(this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Skipping ping; socket not open for wallet ${this.wallet}`);
      return;
    }

    this.ws.send(JSON.stringify({
      method: "ping"
    }));

    this.logger.log(`Ping sent to wallet ${this.wallet}`);
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      this.ping();
    }, this.pingIntervalMs);
  }

  private stopPingLoop() {
    if(this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  // Broadcasting events to all listeners
  // ------------------------------------------------

  private handleIncomingMessage(rawData: WebSocket.RawData) {
    const payloadAsString = this.rawDataToString(rawData);
    if(!payloadAsString) {
      return;
    }

    try {
      const parsedPayload = JSON.parse(payloadAsString);
      const typedEvent = this.resolveEventPayload(parsedPayload);
      if(!typedEvent) {
        return;
      }

      if(typedEvent.channel === 'userFills') {
        this.onEvent?.({
          wallet: this.wallet,
          type: 'userFills',
          payload: typedEvent,
        });
        return;
      }

      this.onEvent?.({
        wallet: this.wallet,
        type: 'clearinghouseState',
        payload: typedEvent,
      });
      
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : 'unknown parse error';
      this.logger.warn(`Failed to parse incoming message for wallet ${this.wallet}: ${errMessage}`);
    }
  }

  private rawDataToString(rawData: WebSocket.RawData): string | null {
    if(typeof rawData === 'string') {
      return rawData;
    }

    if(rawData instanceof Buffer) {
      return rawData.toString('utf-8');
    }

    if(Array.isArray(rawData)) {
      return Buffer.concat(rawData).toString('utf-8');
    }

    if(rawData instanceof ArrayBuffer) {
      return Buffer.from(rawData).toString('utf-8');
    }

    return null;
  }

  private resolveEventPayload(payload: unknown): HyperliquidTrackedWsEvent | null {
    if(!this.isRecord(payload)) {
      return null;
    }

    if(this.isUserFillsEvent(payload)) {
      return payload;
    }

    if(this.isClearinghouseStateEvent(payload)) {
      return payload;
    }

    return null;
  }

  private isUserFillsEvent(payload: Record<string, unknown>): payload is HyperliquidWsUserFillsEvent {
    if(payload.channel !== 'userFills' || !this.isRecord(payload.data)) {
      return false;
    }

    const data = payload.data;
    return typeof data.user === 'string' && Array.isArray(data.fills);
  }

  private isClearinghouseStateEvent(
    payload: Record<string, unknown>,
  ): payload is HyperliquidWsClearinghouseStateEvent {
    if(payload.channel !== 'clearinghouseState' || !this.isRecord(payload.data)) {
      return false;
    }

    const data = payload.data;
    return (
      typeof data.user === 'string' &&
      typeof data.dex === 'string' &&
      this.isRecord(data.clearinghouseState)
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }






}
