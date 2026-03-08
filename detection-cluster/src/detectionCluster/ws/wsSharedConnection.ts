import { Logger } from "@nestjs/common";
import type {
  HyperliquidSubscriptionMessage,
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from "@remora/sdk";
import WebSocket from "ws";
import type { WalletStreamEvent } from "./wsWalletConnectionEstablishment";

// hl allows 10 users per ip, keep it at 8
const MAX_WALLETS_PER_SOCKET = 8;

// TODO: switch dc.service to this
export class WsSharedConnection {
  private readonly logger = new Logger(WsSharedConnection.name);
  private readonly wsUrl = "wss://api.hyperliquid.xyz/ws";
  private readonly reconnectDelayMs = 5_000;
  private readonly wallets = new Set<string>();
  private ws?: WebSocket;
  private shouldReconnect = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private readonly onEvent: (event: WalletStreamEvent) => void) {}

  hasRoom(): boolean {
    return this.wallets.size < MAX_WALLETS_PER_SOCKET;
  }

  openConnection() {
    this.shouldReconnect = true;
    this.ws = new WebSocket(this.wsUrl);

    // TODO: ping, hl drops the socket after 60s without traffic
    this.ws.on("open", () => {
      this.logger.log(
        `Shared WebSocket opened for ${this.wallets.size} wallets`,
      );
      for (const wallet of this.wallets) {
        this.sendSubscriptions(wallet, "subscribe");
      }
    });

    this.ws.on("close", () => {
      this.logger.log("Shared WebSocket closed");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(
          () => this.openConnection(),
          this.reconnectDelayMs,
        );
      }
    });

    this.ws.on("error", (err: Error) => {
      this.logger.error(`Shared WebSocket error: ${err.message}`);
    });

    this.ws.on("message", (rawMessage: WebSocket.RawData) => {
      this.handleMessage(rawMessage.toString());
    });
  }

  closeConnection() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
  }

  subscribeWallet(wallet: string): boolean {
    if (this.wallets.has(wallet)) {
      return true;
    }

    if (!this.hasRoom()) {
      this.logger.warn(`Shared socket is full; skipping wallet ${wallet}`);
      return false;
    }

    this.wallets.add(wallet);
    this.sendSubscriptions(wallet, "subscribe");
    return true;
  }

  unsubscribeWallet(wallet: string) {
    if (!this.wallets.delete(wallet)) {
      return;
    }

    this.sendSubscriptions(wallet, "unsubscribe");
  }

  private sendSubscriptions(
    wallet: string,
    method: HyperliquidSubscriptionMessage["method"],
  ) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    const messages: HyperliquidSubscriptionMessage[] = [
      { method, subscription: { type: "userFills", user: wallet } },
      { method, subscription: { type: "clearinghouseState", user: wallet } },
    ];
    for (const message of messages) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(rawMessage: string): void {
    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(rawMessage);
    } catch {
      this.logger.error(`Failed to parse shared socket message: ${rawMessage}`);
      return;
    }

    if (
      !parsedMessage ||
      typeof parsedMessage !== "object" ||
      !("channel" in parsedMessage)
    ) {
      return;
    }

    const channel = (parsedMessage as { channel?: string }).channel;
    if (channel === "userFills") {
      const payload = parsedMessage as HyperliquidWsUserFillsEvent;
      this.onEvent({ wallet: payload.data.user, type: "userFills", payload });
      return;
    }

    if (channel === "clearinghouseState") {
      const payload = parsedMessage as HyperliquidWsClearinghouseStateEvent;
      this.onEvent({
        wallet: payload.data.user,
        type: "clearinghouseState",
        payload,
      });
    }
  }
}
