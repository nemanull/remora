import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import {
  describeNotification,
  NotificationsService,
} from './notifications.service';

function createService(settings: Partial<ServerConfig>) {
  const values: Partial<ServerConfig> = {
    EXECUTION_MODE: 'paper',
    ...settings,
  };
  const config = {
    get: (key: keyof ServerConfig) => values[key],
    getOrThrow: (key: keyof ServerConfig) => values[key],
  } as unknown as ConfigService<ServerConfig, true>;
  const events = new CopyEvents();
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const service = new NotificationsService(
    events,
    queue as unknown as Queue,
    config,
  );
  service.onModuleInit();
  return { events, queue, service };
}

const KILL_SWITCH: CopyEvent = {
  type: 'killSwitch',
  book: 'MAIN',
  active: true,
  reason: 'daily_loss_limit',
};

describe('describeNotification', () => {
  it.each<[string, CopyEvent, string | null]>([
    [
      'a main copy that opens',
      {
        type: 'copy',
        book: 'MAIN',
        positionId: 7n,
        wallet: '0xabc',
        coin: 'ETH',
        change: 'opened',
        size: '0.5',
        realizedPnl: '0',
      },
      'Copy opened on ETH with size 0.5 after leader 0xabc',
    ],
    [
      'a main copy that closes',
      {
        type: 'copy',
        book: 'MAIN',
        positionId: 7n,
        wallet: '0xabc',
        coin: 'ETH',
        change: 'closed',
        size: '0',
        realizedPnl: '-12.5',
      },
      'Copy closed on ETH after leader 0xabc with realized PnL -12.5 USD',
    ],
    [
      'a resize',
      {
        type: 'copy',
        book: 'MAIN',
        positionId: 7n,
        wallet: '0xabc',
        coin: 'ETH',
        change: 'resized',
        size: '0.7',
        realizedPnl: '0',
      },
      null,
    ],
    [
      'a shadow copy',
      {
        type: 'copy',
        book: 'SHADOW',
        positionId: 8n,
        wallet: '0xabc',
        coin: 'ETH',
        change: 'opened',
        size: '0.5',
        realizedPnl: '0',
      },
      null,
    ],
    [
      'a rejected order',
      {
        type: 'order',
        book: 'MAIN',
        orderId: 3n,
        cloid: '0x01',
        coin: 'SOL',
        purpose: 'ENTRY',
        status: 'REJECTED',
        error: 'Insufficient margin to place order.',
      },
      'MAIN ENTRY order on SOL was rejected: Insufficient margin to place order.',
    ],
    [
      'a filled order',
      {
        type: 'order',
        book: 'MAIN',
        orderId: 3n,
        cloid: '0x01',
        coin: 'SOL',
        purpose: 'ENTRY',
        status: 'FILLED',
        error: null,
      },
      null,
    ],
    [
      'the kill switch',
      KILL_SWITCH,
      'Kill switch set on the MAIN book: daily_loss_limit',
    ],
    [
      'a cleared kill switch',
      { type: 'killSwitch', book: 'MAIN', active: false, reason: null },
      'Kill switch cleared on the MAIN book',
    ],
    [
      'an alert',
      {
        type: 'alert',
        code: 'collector_silent',
        message: 'Cluster 1 has been silent for 60 s',
        wallet: null,
        clusterId: 1,
      },
      'Alert collector_silent: Cluster 1 has been silent for 60 s',
    ],
    [
      'a heartbeat',
      { type: 'collector', clusterId: 1, change: 'heartbeat', stats: null },
      null,
    ],
  ])('describes %s', (_, event, text) => {
    expect(describeNotification(event)).toBe(text);
  });
});

describe('NotificationsService', () => {
  it('queues nothing while the bot token is unset', () => {
    const { events, queue } = createService({ TELEGRAM_CHAT_ID: '42' });

    events.publish(KILL_SWITCH);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues a message labelled with the execution mode', () => {
    const { events, queue } = createService({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: '42',
    });

    events.publish(KILL_SWITCH);
    events.publish({
      type: 'collector',
      clusterId: 1,
      change: 'heartbeat',
      stats: null,
    });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'send-telegram',
      { text: '[paper] Kill switch set on the MAIN book: daily_loss_limit' },
      expect.objectContaining({ attempts: 5 }),
    );
  });
});
