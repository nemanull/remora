import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from '@remora/sdk';
import {
  ClusterWalletEvent,
  WsClusterConnection,
} from './ws/wsClusterConnection';

@Injectable()
export class DetectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DetectionService.name);
  private readonly clusterUrl = 'ws://127.0.0.1:4444/ws';
  private clusterConnection?: WsClusterConnection;

  onModuleInit() {
    this.clusterConnection = new WsClusterConnection(this.clusterUrl, (event) =>
      this.handleWalletEvent(event),
    );
    this.clusterConnection.connect();
  }

  onModuleDestroy() {
    this.clusterConnection?.disconnect();
  }

  private handleWalletEvent(event: ClusterWalletEvent): void {
    if (event.eventType === 'userFills') {
      this.logUserFills(event.wallet, event.payload);
      return;
    }

    if (event.eventType === 'clearinghouseState') {
      this.logAccountValue(event.wallet, event.payload);
    }
  }

  private logUserFills(
    wallet: string,
    payload: HyperliquidWsUserFillsEvent,
  ): void {
    const fills = payload.data.fills;
    const kind = payload.data.isSnapshot ? 'snapshot' : 'live';
    this.logger.log(`Got ${fills.length} ${kind} fills for wallet ${wallet}`);
  }

  private logAccountValue(
    wallet: string,
    payload: HyperliquidWsClearinghouseStateEvent,
  ): void {
    const { accountValue } = payload.data.clearinghouseState.marginSummary;
    // TODO: save balance snapshots when prisma works
    this.logger.log(`Account value of wallet ${wallet} is ${accountValue}`);
  }
}
