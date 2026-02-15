import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  WalletStreamEvent,
  wsWalletConnectionEstablishmentService as wsWCEService,
} from "./wsWalletConnectionEstablishment";

@Injectable()
export class wsWalletManager {
  private readonly wallet: string;
  private readonly wsWCEService: wsWCEService;
  private readonly listeners = new Set<(event: WalletStreamEvent) => void>();
  private Logger = new Logger(wsWalletManager.name);


  constructor(
    wallet: string,
  ) {
    if(!wallet) {
      throw new BadRequestException('Wallet is required for wsWalletManager');
    }

    this.wallet = wallet;
    this.wsWCEService = new wsWCEService(this.wallet, this.handleIncomingEvent);
  }


  async start() {
    this.wsWCEService.establishConnection();
  }

  onEvent(listener: (event: WalletStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly handleIncomingEvent = (event: WalletStreamEvent) => {
    this.Logger.debug(
      `Received wallet event "${event.type}" for wallet ${event.wallet}`,
    );

    for(const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'unknown listener error';
        this.Logger.error(
          `Wallet event listener failed for wallet ${event.wallet}: ${errMessage}`,
        );
      }
    }
  };

}
