import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import type { WalletStreamEvent } from "./wsWalletConnectionEstablishment";

type Topic = string;

type ClientState = {
  topics: Set<Topic>;
  lastSeenMs: number;
};

@Injectable()
export class WsBroadcastManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsBroadcastManager.name);
  private readonly path = "/ws";
  private readonly host = "127.0.0.1";
  private readonly port = 4444;
  private httpServer?: http.Server;
  private wss?: WebSocketServer;

  private clients = new Map<WebSocket, ClientState>();

  constructor() {}

  onModuleInit(): void {
    this.createHttpServer();
    this.start();
  }

  isRunning(): boolean {
    return !!this.wss;
  }

  createHttpServer(): void {
    this.httpServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("WebSocket server is running");
      }
    });
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: this.path,
    });
  }

  start(): void {
    if (!this.httpServer) {
      throw new Error("Http server was not created");
    }

    if (!this.wss) {
      throw new Error("WebSocket server was not created");
    }

    this.wss.on("connection", (socket) => {
      this.clients.set(socket, { topics: new Set(), lastSeenMs: Date.now() });

      socket.on("message", (rawMessage) =>
        this.handleClientMessage(socket, rawMessage.toString()),
      );
      socket.on("ping", () => socket.pong());
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", (err) =>
        this.logger.warn(`client error: ${String(err)}`),
      );

      socket.send(JSON.stringify({ type: "info", message: "connected" }));
    });

    this.httpServer.listen(this.port, this.host);
    this.logger.log(
      `WebSocket server listening on ws://${this.host}:${this.port}${this.path}`,
    );
  }

  /**
   * Stops the WebSocket server and HTTP server, closing all client connections.
   */
  async stop(): Promise<void> {
    if (!this.wss && !this.httpServer) {
      return;
    }

    return new Promise((resolve) => {
      // Close all client connections first
      for (const [socket] of this.clients) {
        try {
          if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
          ) {
            socket.close();
          }
        } catch (err) {
          this.logger.warn(`Error closing client: ${String(err)}`);
        }
      }
      this.clients.clear();

      const finish = () => {
        this.wss = undefined;
        this.httpServer = undefined;
        this.logger.log("WebSocket server stopped");
        resolve();
      };

      if (this.wss) {
        this.wss.close(() => {
          this.wss = undefined;
          if (this.httpServer) {
            this.httpServer.close(() => {
              this.httpServer = undefined;
              finish();
            });
          } else {
            finish();
          }
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = undefined;
          finish();
        });
      } else {
        finish();
      }
    });
  }

  /**
   * Outbound event format sent to every connected WS client:
   * {
   *   "type": "walletEvent",
   *   "wallet": "0x...",
   *   "eventType": "userFills | clearinghouseState",
   *   "payload": { "...hyperliquid event..." }
   * }
   */
  broadcastWalletEvent(event: WalletStreamEvent): void {
    const message = JSON.stringify({
      type: "walletEvent",
      wallet: event.wallet,
      eventType: event.type,
      payload: event.payload,
    });

    for (const [socket] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      socket.send(message);
    }
  }

  private handleClientMessage(ws: WebSocket, rawMessage: string): void {
    const state = this.clients.get(ws);
    if (!state) {
      return;
    }

    state.lastSeenMs = Date.now();

    if (rawMessage === "health") {
      ws.send(
        JSON.stringify({
          type: "info",
          message: "WebSocket server is running",
        }),
      );
      return;
    }

    if (this.handlePing(ws, rawMessage)) {
      return;
    }
  }

  private handlePing(ws: WebSocket, rawMessage: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      "message" in parsed &&
      (parsed as { type: string; message: string }).type === "info" &&
      (parsed as { type: string; message: string }).message === "ping"
    ) {
      this.sendPong(ws);
      return true;
    }
    return false;
  }

  private sendPong(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        type: "pong",
        timestamp: Date.now(),
        timestampIso: new Date().toISOString(),
      }),
    );
  }

  async onModuleDestroy() {
    await this.stop();
  }
}
