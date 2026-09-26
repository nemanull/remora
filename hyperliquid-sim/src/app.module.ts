import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateSimulatorConfig, type SimulatorConfig } from './config';
import { HealthController } from './health.controller';
import { InfoController } from './info/info.controller';
import { IpLimits } from './limits/ipLimits';
import { Simulation } from './simulation';
import { StatsController } from './stats/stats.controller';
import { FaultInjection } from './truth/faultInjection';
import { TruthController } from './truth/truth.controller';
import { SimSocketService } from './ws/simSocket.service';

type SimulatorConfigService = ConfigService<SimulatorConfig, true>;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateSimulatorConfig }),
  ],
  controllers: [
    HealthController,
    InfoController,
    StatsController,
    TruthController,
  ],
  providers: [
    {
      provide: Simulation,
      inject: [ConfigService],
      useFactory: (config: SimulatorConfigService) =>
        new Simulation({
          seed: config.getOrThrow('SIM_SEED', { infer: true }),
          walletCount: config.getOrThrow('SIM_WALLETS', { infer: true }),
          speed: config.getOrThrow('SIM_SPEED', { infer: true }),
          restLagMs: config.getOrThrow('SIM_REST_LAG_MS', { infer: true }),
        }),
    },
    {
      provide: IpLimits,
      inject: [ConfigService],
      useFactory: (config: SimulatorConfigService) =>
        new IpLimits({
          maxConnections: config.getOrThrow('SIM_MAX_CONNECTIONS', {
            infer: true,
          }),
          newConnectionsPerMinute: config.getOrThrow(
            'SIM_NEW_CONNECTIONS_PER_MINUTE',
            {
              infer: true,
            },
          ),
          maxUsers: config.getOrThrow('SIM_MAX_USERS', { infer: true }),
          maxSubscriptions: config.getOrThrow('SIM_MAX_SUBSCRIPTIONS', {
            infer: true,
          }),
          messagesPerMinute: config.getOrThrow('SIM_MESSAGES_PER_MINUTE', {
            infer: true,
          }),
          weightPerMinute: config.getOrThrow('SIM_WEIGHT_PER_MINUTE', {
            infer: true,
          }),
        }),
    },
    { provide: FaultInjection, useFactory: () => new FaultInjection() },
    SimSocketService,
  ],
})
export class AppModule {}
