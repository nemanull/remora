import { Controller, Get, Param } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('scores')
  getScores() {
    return this.appService.rankWallets();
  }

  @Get('score/:wallet')
  getScore(@Param('wallet') wallet: string) {
    return this.appService.scoreWallet(wallet);
  }
}
