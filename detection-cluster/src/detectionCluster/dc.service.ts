import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLUSTER_ID_TOKEN } from './dc.module';
import { WsBroadcastManager } from './ws/wsBroadcastManager';
import { WsWalletConnectionEstablishmentService } from './ws/wsWalletConnectionEstablishment';

@Injectable()
export class DetectionClusterService implements OnModuleDestroy {
  private readonly logger = new Logger(DetectionClusterService.name);
  private readonly walletConnections = new Map<
    string,
    WsWalletConnectionEstablishmentService
  >();

  constructor(
    @Inject(CLUSTER_ID_TOKEN) private readonly clusterId: number,
    private readonly wsBroadcastManager: WsBroadcastManager,
  ) {}

  async startDetectionForAllWallets(wallets: string[]) {
    this.logger.log(
      `Starting detection for cluster ${this.clusterId} with ${wallets.length} wallets`,
    );

    for (const wallet of wallets) {
      if (this.walletConnections.has(wallet)) {
        continue;
      }

      const walletConnection = new WsWalletConnectionEstablishmentService(
        wallet,
        (event) => this.wsBroadcastManager.broadcastWalletEvent(event),
      );
      this.walletConnections.set(wallet, walletConnection);
      await walletConnection.establishConnection();
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [, connection] of this.walletConnections) {
      connection.closeConnection();
    }
    this.walletConnections.clear();
  }
}
