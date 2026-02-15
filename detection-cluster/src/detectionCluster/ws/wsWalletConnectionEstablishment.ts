import { Logger } from "@nestjs/common";
import type {
  HyperliquidSubscriptionMessage,
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from "@copy-quant/sdk";
import WebSocket from "ws";

export type WalletStreamEventType = "userFills" | "clearinghouseState";

export type WalletStreamEvent =
  | {
      wallet: string;
      type: "userFills";
      payload: HyperliquidWsUserFillsEvent;
    }
  | {
      wallet: string;
      type: "clearinghouseState";
      payload: HyperliquidWsClearinghouseStateEvent;
    };

export class WsWalletConnectionEstablishmentService {
  private readonly logger = new Logger(
    WsWalletConnectionEstablishmentService.name,
  );
  private readonly wsUrl = "wss://api.hyperliquid.xyz/ws";
  private readonly pingIntervalMs = 45_000;
  private ws: WebSocket;
  private connection: boolean = false;
  private wallet: string;
  private pingTimer?: NodeJS.Timeout;
  private onEvent: (event: WalletStreamEvent) => void;

  constructor(wallet: string, onEvent: (event: WalletStreamEvent) => void) {
    this.wallet = wallet;
    this.onEvent = onEvent;
  }

  async establishConnection() {
    if (this.connection) {
      this.logger.log(
        `WebSocket already established for wallet ${this.wallet}`,
      );
      return;
    }

    this.openConnection();
  }

  openConnection() {
    this.ws = new WebSocket(this.wsUrl);

    if (!this.ws) {
      this.logger.error(`Failed to create WebSocket for wallet ${this.wallet}`);
      return;
    }

    this.ws.on("open", () => {
      this.connection = true;
      this.subscribeToUserFills();
      this.subscribeToClearingHouseState();
      this.startPingLoop();
      this.logger.log(`WebSocket opened for wallet ${this.wallet}`);
    });

    this.ws.on("close", () => {
      this.connection = false;
      this.stopPingLoop();
      this.logger.log(`WebSocket closed for wallet ${this.wallet}`);
    });

    this.ws.on("error", (err) => {
      this.connection = false;
      this.stopPingLoop();
      this.logger.error(
        `WebSocket error for wallet ${this.wallet}: ${err.message}`,
      );
    });

    this.ws.on("message", (rawMessage) => {
      this.handleTrackedEvent(rawMessage.toString());
    });
  }

  closeConnection() {
    if (!this.connection) {
      this.logger.log(`WebSocket already closed for wallet ${this.wallet}`);
      return;
    }

    this.ws.close();
    this.connection = false;
    this.stopPingLoop();
  }

  subscribeToUserFills() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `Skipping user fills subscription; socket not open for wallet ${this.wallet}`,
      );
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

  subscribeToClearingHouseState() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `Skipping clearinghouseState subscription; socket not open for wallet ${this.wallet}`,
      );
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

    this.logger.log(
      `Subscribed to clearinghouse state for wallet ${this.wallet}`,
    );
  }

  ping() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `Skipping ping; socket not open for wallet ${this.wallet}`,
      );
      return;
    }

    this.ws.send(
      JSON.stringify({
        method: "ping",
      }),
    );

    this.logger.log(`Ping sent to wallet ${this.wallet}`);
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      this.ping();
    }, this.pingIntervalMs);
  }

  private stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private handleTrackedEvent(rawMessage: string): void {
    let parsedMessage: unknown;

    try {
      parsedMessage = JSON.parse(rawMessage);
    } catch {
      this.logger.error(`Failed to parse message for wallet ${this.wallet}: ${rawMessage}`);
      return;
    }

    if (
      !parsedMessage ||
      typeof parsedMessage !== "object" ||
      !("channel" in parsedMessage)
    ) {
      this.logger.error(`Invalid message for wallet ${this.wallet}: ${rawMessage}`);
      return;
    }

    const channel = (parsedMessage as { channel?: string }).channel;
    if (channel === "userFills") {
      this.onEvent({
        wallet: this.wallet,
        type: "userFills",
        payload: parsedMessage as HyperliquidWsUserFillsEvent,
      });
      this.logger.log(`User fills event received for wallet ${this.wallet}`);
      return;
    }

    if (channel === "clearinghouseState") {
      this.onEvent({
        wallet: this.wallet,
        type: "clearinghouseState",
        payload: parsedMessage as HyperliquidWsClearinghouseStateEvent,
      });
    }
  }
}
