import { describe, expect, it } from 'vitest';
import { parseReplayArguments } from './replayArguments';

describe('parseReplayArguments', () => {
  it('fills the defaults and lowercases the wallet', () => {
    expect(
      parseReplayArguments([
        '--wallet',
        '0x9E6B92CD44167D06B102E683DF3F02E23D932E4F',
      ]),
    ).toEqual({
      wallet: '0x9e6b92cd44167d06b102e683df3f02e23d932e4f',
      days: 30,
      allocationUsd: 5_000,
      latencyMs: 1_200,
      driftBps: 2,
      end: undefined,
    });
  });

  it('reads every option', () => {
    expect(
      parseReplayArguments([
        '--wallet',
        '0x9e6b92cd44167d06b102e683df3f02e23d932e4f',
        '--days',
        '14',
        '--allocation',
        '1000',
        '--latency-ms',
        '900',
        '--drift-bps',
        '5',
        '--end',
        '2026-04-20T00:00:00.000Z',
      ]),
    ).toMatchObject({
      days: 14,
      allocationUsd: 1_000,
      latencyMs: 900,
      driftBps: 5,
      end: new Date('2026-04-20T00:00:00.000Z'),
    });
  });

  it('refuses a missing or malformed wallet', () => {
    expect(() => parseReplayArguments([])).toThrow('Invalid replay arguments');
    expect(() => parseReplayArguments(['--wallet', '0x12'])).toThrow(
      'is not a 0x address',
    );
  });
});
