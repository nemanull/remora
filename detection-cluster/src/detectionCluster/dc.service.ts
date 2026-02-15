import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { resolveClusterIdFromEnv } from './dc.tokens';
import { WsBroadcastManager } from './ws/wsBroadcastManager';
import { WsWalletConnectionEstablishmentService } from './ws/wsWalletConnectionEstablishment';

@Injectable()
export class DetectionClusterService implements OnModuleDestroy {
  private readonly logger = new Logger(DetectionClusterService.name);
  private readonly clusterId = resolveClusterIdFromEnv();
  private readonly walletConnections = new Map<
    string,
    WsWalletConnectionEstablishmentService
  >();

  constructor(private readonly wsBroadcastManager: WsBroadcastManager) {}

  async startDetectionForAllWallets(wallets: string[]) {
    this.logger.log(
      `Starting detection for cluster ${this.clusterId} with ${wallets.length} wallets`,
    );

    for (const wallet of wallets) {
      if (this.walletConnections.has(wallet)) {
        this.logger.debug(`Wallet ${wallet} is already connected; skipping`);
        continue;
      }

      this.logger.log(`Opening upstream WS connection for wallet ${wallet}`);
      const walletConnection = new WsWalletConnectionEstablishmentService(wallet, (event) => {
        try {
          this.wsBroadcastManager.broadcastWalletEvent(event);
        } catch (error) {
          this.logger.error(
            `Failed to broadcast ${event.type} event for wallet ${wallet}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      });

      this.walletConnections.set(wallet, walletConnection);

      try {
        await walletConnection.establishConnection();
        this.logger.log(`Connection setup completed for wallet ${wallet}`);
      } catch (error) {
        this.walletConnections.delete(wallet);
        this.logger.error(
          `Failed to establish WS connection for wallet ${wallet}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log(
      `Shutting down ${this.walletConnections.size} wallet WS connection(s)`,
    );

    for (const [wallet, connection] of this.walletConnections) {
      try {
        connection.closeConnection();
      } catch (error) {
        this.logger.error(
          `Failed to close WS connection for wallet ${wallet}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    this.walletConnections.clear();
    this.logger.log('All wallet WS connections cleared');
  }
}
