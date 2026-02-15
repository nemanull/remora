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
    this.wsWCEService = new wsWCEService(this.wallet);
  }


  async start() {
    this.wsWCEService.establishConnection();
  }


}
