import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type {
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from '@remora/sdk';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

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

type WalletEventHandler = (event: ClusterWalletEvent) => void;

@Injectable()
export class ClusterSocket implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClusterSocket.name);
  private readonly path = '/cluster';
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly handlers: WalletEventHandler[] = [];
  private httpServer?: Server;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onWalletEvent(handler: WalletEventHandler): void {
    this.handlers.push(handler);
  }

  onApplicationBootstrap(): void {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer.on('upgrade', this.handleUpgrade);
    this.logger.log(`Waiting for collectors on ${this.path}`);
  }

  onModuleDestroy(): void {
    this.httpServer?.off('upgrade', this.handleUpgrade);
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.wss.close();
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (request.url !== this.path) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) =>
      this.handleConnection(ws, request.socket.remoteAddress),
    );
  };

  private handleConnection(ws: WebSocket, address?: string): void {
    this.logger.log(`Collector connected from ${address}`);

    ws.on('message', (rawMessage: WebSocket.RawData) => {
      this.handleMessage(rawMessage.toString());
    });

    ws.on('close', () => {
      this.logger.warn(`Collector from ${address} disconnected`);
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`Collector socket error: ${err.message}`);
    });
  }

  private handleMessage(rawMessage: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      this.logger.error(`Failed to parse collector message: ${rawMessage}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      this.logger.error(`Invalid collector message: ${rawMessage}`);
      return;
    }

    const type = (parsed as { type?: string }).type;
    if (type !== 'walletEvent') {
      this.logger.warn(`Unhandled collector message type ${type}`);
      return;
    }

    for (const handler of this.handlers) {
      handler(parsed as ClusterWalletEvent);
    }
  }
}
