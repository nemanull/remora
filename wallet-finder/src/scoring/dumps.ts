import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HyperliquidClearinghouseState,
  HyperliquidWsClearinghouseStateEvent,
  HyperliquidWsFill,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';

const DUMPS_DIR = join(process.cwd(), 'data', 'dumps');

type FillsFrame = {
  channel: string;
  data: {
    fills: HyperliquidWsFill[];
  };
};

type StateDump =
  | HyperliquidWsClearinghouseStateEvent
  | HyperliquidClearinghouseState;

function fillsPath(wallet: string): string {
  return join(DUMPS_DIR, `${wallet}.fills.json`);
}

function statePath(wallet: string): string {
  return join(DUMPS_DIR, `${wallet}.state.json`);
}

export function hasDump(wallet: string): boolean {
  return existsSync(fillsPath(wallet));
}

export function loadFills(wallet: string): HyperliquidWsFill[] {
  const frames = JSON.parse(
    readFileSync(fillsPath(wallet), 'utf8'),
  ) as FillsFrame[];

  const fillsByTid = new Map<number, HyperliquidWsFill>();
  for (const fill of frames.flatMap((frame) => frame.data.fills)) {
    fillsByTid.set(fill.tid, fill);
  }

  return [...fillsByTid.values()];
}

export function loadAccountValue(wallet: string): Decimal | null {
  if (!existsSync(statePath(wallet))) {
    return null;
  }

  const dump = JSON.parse(readFileSync(statePath(wallet), 'utf8')) as StateDump;
  const state = 'channel' in dump ? dump.data.clearinghouseState : dump;

  return new Decimal(state.marginSummary.accountValue);
}
