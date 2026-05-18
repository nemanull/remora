import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsUserFillsEvent,
} from '@remora/sdk';
import { ClusterSocket, ClusterWalletEvent } from './clusterSocket';

@Injectable()
export class DetectionService implements OnModuleInit {
  private readonly logger = new Logger(DetectionService.name);

  constructor(private readonly clusterSocket: ClusterSocket) {}

  onModuleInit() {
    this.clusterSocket.onWalletEvent((event) => this.handleWalletEvent(event));
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
    // TODO: save balance snapshots
    this.logger.log(`Account value of wallet ${wallet} is ${accountValue}`);
  }
}
