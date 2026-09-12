import { describe, expect, it } from 'vitest';
import { type CopyEvent, CopyEvents } from './copyEvents';

const KILL_SWITCH_ON: CopyEvent = {
  type: 'killSwitch',
  book: 'MAIN',
  active: true,
  reason: 'daily_loss_limit',
};
const KILL_SWITCH_OFF: CopyEvent = {
  ...KILL_SWITCH_ON,
  active: false,
  reason: null,
};

describe('CopyEvents', () => {
  it('delivers published events to every subscriber in order', () => {
    const events = new CopyEvents();
    const first: CopyEvent[] = [];
    const second: CopyEvent[] = [];
    events.events$.subscribe((event) => first.push(event));
    events.events$.subscribe((event) => second.push(event));

    events.publish(KILL_SWITCH_ON);
    events.publish(KILL_SWITCH_OFF);

    expect(first).toEqual([KILL_SWITCH_ON, KILL_SWITCH_OFF]);
    expect(second).toEqual(first);
  });

  it('completes the stream when the module shuts down', () => {
    const events = new CopyEvents();
    let isComplete = false;
    events.events$.subscribe({ complete: () => (isComplete = true) });

    events.onModuleDestroy();

    expect(isComplete).toBe(true);
  });
});
