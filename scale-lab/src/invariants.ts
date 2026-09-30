import { setTimeout as sleep } from 'node:timers/promises';
import type { HyperliquidFill } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import type { Lab } from './labEnvironment';
import { fetchJson } from './waiting';

const MIN_ORDER_NOTIONAL_USD = new Decimal(10);
const FILL_CHECK_ATTEMPTS = 5;
const FILL_CHECK_INTERVAL_MS = 15_000;
const COPY_CHECK_ROUNDS = 12;
const COPY_CHECK_INTERVAL_MS = 10_000;
const QUIET_MS = 20_000;
const MAX_LISTED_VIOLATIONS = 20;
const SHORTFALL_EXPLAINED_BY_REASON = new Set(['copied', 'already_at_target']);

export type InvariantResult = {
  name: string;
  passed: boolean;
  summary: string;
  violations: string[];
};

export type FillKey = { coin: string; tid: string; time: number };

export type DecisionLink = {
  id: string;
  book: string;
  wallet: string;
  coin: string;
  reason: string;
  positionBefore: string;
  positionAfter: string;
};

export type CopyCheck = {
  outcome: 'matches' | 'explained_shortfall' | 'violation';
  detail: string;
};

export type LimitRefusal = {
  at: number;
  ip: string;
  limit: string;
  detail: string;
};

type SimPosition = { wallet: string; coin: string; szi: string };

type MetaUniverse = { universe: { name: string; szDecimals: number }[] };

function toFillKey(fill: {
  coin: string;
  tid: string | number | bigint;
  time: number;
}): FillKey {
  return { coin: fill.coin, tid: String(fill.tid), time: fill.time };
}

function describeFill(wallet: string, fill: FillKey): string {
  return `${wallet} ${fill.coin} tid ${fill.tid} at ${new Date(fill.time).toISOString()}`;
}

function buildResult(
  name: string,
  summary: string,
  violations: string[],
): InvariantResult {
  return {
    name,
    passed: violations.length === 0,
    summary,
    violations:
      violations.length > MAX_LISTED_VIOLATIONS
        ? [
            ...violations.slice(0, MAX_LISTED_VIOLATIONS),
            `and ${violations.length - MAX_LISTED_VIOLATIONS} more`,
          ]
        : violations,
  };
}

export function compareFills(
  truth: FillKey[],
  stored: FillKey[],
): { missing: FillKey[]; unknown: FillKey[] } {
  const keyOf = (fill: FillKey) => `${fill.coin}:${fill.tid}`;
  const storedKeys = new Set(stored.map(keyOf));
  const truthKeys = new Set(truth.map(keyOf));
  return {
    missing: truth.filter((fill) => !storedKeys.has(keyOf(fill))),
    unknown: stored.filter((fill) => !truthKeys.has(keyOf(fill))),
  };
}

export function findBrokenDecisionChains(decisions: DecisionLink[]): string[] {
  const breaks: string[] = [];
  const previousByPair = new Map<string, DecisionLink>();
  for (const decision of decisions) {
    if (decision.reason === 'out_of_order') {
      continue;
    }
    const pair = `${decision.book}:${decision.wallet}:${decision.coin}`;
    const previous = previousByPair.get(pair);
    if (
      previous !== undefined &&
      !new Decimal(previous.positionAfter).equals(decision.positionBefore)
    ) {
      breaks.push(
        `${decision.book} ${decision.wallet} ${decision.coin}: decision ${decision.id} starts at ${decision.positionBefore} but decision ${previous.id} before it ended at ${previous.positionAfter}`,
      );
    }
    previousByPair.set(pair, decision);
  }
  return breaks;
}

export function checkCopyAgainstLeader(input: {
  size: Decimal;
  ratio: Decimal;
  leaderPosition: Decimal;
  mid: Decimal;
  szDecimals: number;
  hasRecordedShortfall: boolean;
}): CopyCheck {
  const { size, ratio, leaderPosition, mid } = input;
  const target = ratio.mul(leaderPosition.abs());
  const comparison = `holds ${size.toFixed()} against k ${ratio.toFixed()} times the leader's ${leaderPosition.toFixed()}, ${target.toDecimalPlaces(input.szDecimals + 2).toFixed()}`;
  if (leaderPosition.isZero()) {
    return {
      outcome: 'violation',
      detail: `is open with ${size.toFixed()} while the leader is flat`,
    };
  }
  if (!size.isZero() && size.isNegative() !== leaderPosition.isNegative()) {
    return {
      outcome: 'violation',
      detail: `is on the wrong side: ${comparison}`,
    };
  }
  const lot = new Decimal(10).pow(-input.szDecimals);
  const tolerance = lot.plus(MIN_ORDER_NOTIONAL_USD.div(mid));
  const difference = size.abs().minus(target);
  if (difference.gt(tolerance)) {
    return {
      outcome: 'violation',
      detail: `holds more than its leader: ${comparison}`,
    };
  }
  if (difference.lt(tolerance.neg())) {
    return input.hasRecordedShortfall
      ? { outcome: 'explained_shortfall', detail: comparison }
      : {
          outcome: 'violation',
          detail: `holds less without a recorded reason: ${comparison}`,
        };
  }
  return { outcome: 'matches', detail: comparison };
}

export function findUnprovokedRefusals(
  refusals: LimitRefusal[],
  provokedLimits: readonly string[],
): LimitRefusal[] {
  return refusals.filter((refusal) => !provokedLimits.includes(refusal.limit));
}

async function readSimFills(
  lab: Lab,
  wallet: string,
  since: number,
  until?: number,
): Promise<HyperliquidFill[]> {
  const range = until === undefined ? '' : `&until=${until}`;
  const response = await fetchJson<{ fills: HyperliquidFill[] }>(
    `${lab.simulatorUrl}/sim/fills?wallet=${wallet}&since=${since}${range}`,
  );
  return response.fills;
}

export async function checkNoMissingFills(
  lab: Lab,
  wallets: string[],
  until: number,
): Promise<InvariantResult> {
  const name =
    'No fill of a tracked wallet since its tracked_since is missing from Postgres';
  const { rows: trackedRows } = await lab.database.query<{
    address: string;
    tracked_since: Date | null;
  }>(
    'SELECT address, tracked_since FROM "Wallet" WHERE address = ANY($1::text[])',
    [wallets],
  );
  const trackedSince = new Map(
    trackedRows.map((row) => [row.address, row.tracked_since]),
  );
  let violations: string[] = [];
  let truthCount = 0;
  let unknownCount = 0;
  for (let attempt = 1; attempt <= FILL_CHECK_ATTEMPTS; attempt += 1) {
    violations = [];
    truthCount = 0;
    unknownCount = 0;
    for (const wallet of wallets) {
      const since = trackedSince.get(wallet) ?? null;
      if (since === null) {
        violations.push(`${wallet} was never tracked`);
        continue;
      }
      const truth = (
        await readSimFills(lab, wallet, since.getTime(), until)
      ).map(toFillKey);
      const { rows } = await lab.database.query<{
        coin: string;
        tid: string;
        time: Date;
      }>(
        'SELECT coin, tid::text AS tid, time FROM "LeaderFill" WHERE wallet_address = $1 AND time >= $2 AND time <= $3',
        [wallet, since, new Date(until)],
      );
      const stored = rows.map((row) =>
        toFillKey({ coin: row.coin, tid: row.tid, time: row.time.getTime() }),
      );
      const { missing, unknown } = compareFills(truth, stored);
      truthCount += truth.length;
      unknownCount += unknown.length;
      violations.push(
        ...missing.map((fill) => `missing ${describeFill(wallet, fill)}`),
        ...unknown.map(
          (fill) => `not in the simulator ${describeFill(wallet, fill)}`,
        ),
      );
    }
    if (violations.length === 0 || attempt === FILL_CHECK_ATTEMPTS) {
      break;
    }
    await sleep(FILL_CHECK_INTERVAL_MS);
  }
  return buildResult(
    name,
    `${truthCount} simulator fills of ${wallets.length} wallets up to ${new Date(until).toISOString()} compared, ${violations.length - unknownCount} missing, ${unknownCount} unknown`,
    violations,
  );
}

export async function checkNoDuplicateDecisions(
  lab: Lab,
): Promise<InvariantResult> {
  const name =
    'No signal produced two decisions in one book, and no decision produced two entry orders';
  const { rows } = await lab.database.query<{
    id: string;
    book: string;
    wallet: string;
    coin: string;
    reason: string;
    position_before: string;
    position_after: string;
  }>(
    `SELECT id::text AS id, book::text AS book, wallet_address AS wallet, coin, reason,
            position_before::text AS position_before, position_after::text AS position_after
       FROM "CopyDecision"
      ORDER BY book, wallet_address, coin, leader_time, id`,
  );
  const decisions: DecisionLink[] = rows.map((row) => ({
    id: row.id,
    book: row.book,
    wallet: row.wallet,
    coin: row.coin,
    reason: row.reason,
    positionBefore: row.position_before,
    positionAfter: row.position_after,
  }));
  const chainBreaks = findBrokenDecisionChains(decisions);
  const { rows: doubleEntries } = await lab.database.query<{
    decision_id: string;
    entries: string;
  }>(
    `SELECT decision_id::text AS decision_id, count(*)::text AS entries
       FROM "Order"
      WHERE purpose = 'ENTRY' AND decision_id IS NOT NULL
      GROUP BY decision_id
     HAVING count(*) > 1`,
  );
  const outOfOrder = decisions.filter(
    (decision) => decision.reason === 'out_of_order',
  ).length;
  return buildResult(
    name,
    `${decisions.length} decisions in ${new Set(decisions.map((decision) => `${decision.book}:${decision.wallet}:${decision.coin}`)).size} chains of book, wallet and coin, ${chainBreaks.length} breaks, ${outOfOrder} out_of_order records, ${doubleEntries.length} decisions with two entry orders`,
    [
      ...chainBreaks,
      ...doubleEntries.map(
        (row) => `decision ${row.decision_id} has ${row.entries} entry orders`,
      ),
    ],
  );
}

type OpenCopy = {
  id: string;
  book: string;
  wallet: string;
  coin: string;
  ratio: string;
  opened_at: Date;
};

export class CopyFollowCheck {
  readonly name =
    'Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed';
  private readonly outcomes = {
    matches: 0,
    explained_shortfall: 0,
    violation: 0,
  };
  private readonly violations: string[] = [];
  private readonly copies = new Set<string>();
  private moments = 0;
  private szDecimals: Map<string, number> | null = null;

  constructor(private readonly lab: Lab) {}

  async inspect(skip: ReadonlySet<string> = new Set()): Promise<{
    checked: string[];
    inMotion: string[];
  }> {
    const at = Date.now();
    const { rows } = await this.lab.database.query<OpenCopy>(
      `SELECT id::text AS id, book::text AS book, wallet_address AS wallet, coin,
              ratio::text AS ratio, opened_at
         FROM "CopyPosition" WHERE is_open`,
    );
    const pending = rows.filter((copy) => !skip.has(copy.id));
    if (pending.length === 0) {
      return { checked: [], inMotion: [] };
    }
    const szDecimals = await this.readSzDecimals();
    const positions = await fetchJson<{ positions: SimPosition[] }>(
      `${this.lab.simulatorUrl}/sim/positions?at=${at}`,
    );
    const leaderPositions = new Map(
      positions.positions.map((position) => [
        `${position.wallet}:${position.coin}`,
        new Decimal(position.szi),
      ]),
    );
    const mids = await fetchJson<Record<string, string>>(
      `${this.lab.simulatorUrl}/info`,
      { method: 'POST', body: JSON.stringify({ type: 'allMids' }) },
    );
    const quietSizes = await this.readQuietSizes(pending, at);
    const checked: string[] = [];
    const inMotion: string[] = [];
    for (const copy of pending) {
      const pair = `${copy.wallet}:${copy.coin}`;
      const size = quietSizes.get(copy.id);
      if (size === undefined) {
        inMotion.push(copy.id);
        continue;
      }
      const mid = mids[copy.coin];
      const decimals = szDecimals.get(copy.coin);
      checked.push(copy.id);
      this.copies.add(copy.id);
      if (mid === undefined || decimals === undefined) {
        this.outcomes.violation += 1;
        this.violations.push(
          `${copy.book} copy ${copy.id} of ${pair} is on a coin the simulator does not list`,
        );
        continue;
      }
      const check = checkCopyAgainstLeader({
        size: new Decimal(size),
        ratio: new Decimal(copy.ratio),
        leaderPosition: leaderPositions.get(pair) ?? new Decimal(0),
        mid: new Decimal(mid),
        szDecimals: decimals,
        hasRecordedShortfall: await hasRecordedShortfall(this.lab, copy),
      });
      this.outcomes[check.outcome] += 1;
      if (check.outcome === 'violation') {
        this.violations.push(
          `${copy.book} copy ${copy.id} of ${pair} at ${new Date(at).toISOString()} ${check.detail}`,
        );
      }
    }
    if (checked.length > 0) {
      this.moments += 1;
    }
    return { checked, inMotion };
  }

  async finish(): Promise<InvariantResult> {
    const checkedAtEnd = new Set<string>();
    let inMotion: string[] = [];
    for (let round = 1; round <= COPY_CHECK_ROUNDS; round += 1) {
      const result = await this.inspect(checkedAtEnd);
      result.checked.forEach((id) => checkedAtEnd.add(id));
      inMotion = result.inMotion;
      if (inMotion.length === 0) {
        break;
      }
      await sleep(COPY_CHECK_INTERVAL_MS);
    }
    const checks =
      this.outcomes.matches +
      this.outcomes.explained_shortfall +
      this.outcomes.violation;
    return buildResult(
      this.name,
      `${checks} checks of ${this.copies.size} distinct open copies at ${this.moments} moments while their leader was quiet: ${this.outcomes.matches} at k times the leader, ${this.outcomes.explained_shortfall} below it with a recorded clip, rejection, deferral or partial fill, ${this.outcomes.violation} violations, and ${inMotion.length} copies still in motion at the end`,
      this.violations,
    );
  }

  private async readSzDecimals(): Promise<Map<string, number>> {
    if (this.szDecimals === null) {
      const meta = await fetchJson<MetaUniverse>(
        `${this.lab.simulatorUrl}/info`,
        { method: 'POST', body: JSON.stringify({ type: 'meta' }) },
      );
      this.szDecimals = new Map(
        meta.universe.map((asset) => [asset.name, asset.szDecimals]),
      );
    }
    return this.szDecimals;
  }

  private async readQuietSizes(
    copies: OpenCopy[],
    at: number,
  ): Promise<Map<string, string>> {
    const latestFills = new Map<string, HyperliquidFill>();
    const openedBefore = new Map<string, number>();
    for (const copy of copies) {
      const since = copy.opened_at.getTime() - QUIET_MS;
      openedBefore.set(
        copy.wallet,
        Math.min(openedBefore.get(copy.wallet) ?? since, since),
      );
    }
    for (const [wallet, since] of openedBefore) {
      for (const fill of await readSimFills(this.lab, wallet, since)) {
        const pair = `${wallet}:${fill.coin}`;
        const latest = latestFills.get(pair);
        if (latest === undefined || fill.time >= latest.time) {
          latestFills.set(pair, fill);
        }
      }
    }
    const quiet = new Map<string, string>();
    for (const copy of copies) {
      const pair = `${copy.wallet}:${copy.coin}`;
      const latest = latestFills.get(pair);
      if (latest !== undefined && latest.time > at - QUIET_MS) {
        continue;
      }
      const { rows } = await this.lab.database.query<{ size: string }>(
        `SELECT size::text AS size FROM "CopyPosition"
          WHERE id = $1::bigint AND is_open
            AND NOT EXISTS (
                  SELECT 1 FROM "Order"
                   WHERE position_id = $1::bigint AND status = 'SUBMITTED' AND purpose <> 'STOP')
            AND ($2::bigint IS NULL OR EXISTS (
                  SELECT 1 FROM "LeaderFill"
                   WHERE wallet_address = $3 AND coin = $4 AND tid = $2::bigint
                     AND signalled_at IS NOT NULL))`,
        [
          copy.id,
          latest === undefined ? null : String(latest.tid),
          copy.wallet,
          copy.coin,
        ],
      );
      if (rows.length > 0) {
        quiet.set(copy.id, rows[0].size);
      }
    }
    return quiet;
  }
}

async function hasRecordedShortfall(
  lab: Lab,
  copy: {
    id: string;
    book: string;
    wallet: string;
    coin: string;
    opened_at: Date;
  },
): Promise<boolean> {
  const { rows } = await lab.database.query<{ reason: string }>(
    `SELECT DISTINCT reason FROM "CopyDecision"
      WHERE book = $1::"Book" AND wallet_address = $2 AND coin = $3 AND decided_at >= $4`,
    [copy.book, copy.wallet, copy.coin, copy.opened_at],
  );
  if (rows.some((row) => !SHORTFALL_EXPLAINED_BY_REASON.has(row.reason))) {
    return true;
  }
  const { rows: incomplete } = await lab.database.query(
    `SELECT 1 FROM "Order"
      WHERE position_id = $1::bigint AND purpose <> 'STOP' AND status <> 'FILLED'
      LIMIT 1`,
    [copy.id],
  );
  return incomplete.length > 0;
}

export async function checkNoUnprovokedRefusals(
  lab: Lab,
  provokedLimits: readonly string[],
): Promise<InvariantResult> {
  const name =
    'The simulator recorded no limit refusal that the scenario did not provoke';
  const response = await fetchJson<{ refusals: LimitRefusal[] }>(
    `${lab.simulatorUrl}/sim/refusals?since=${lab.startedAt.getTime()}`,
  );
  const unprovoked = findUnprovokedRefusals(response.refusals, provokedLimits);
  const provoked = response.refusals.length - unprovoked.length;
  return buildResult(
    name,
    `${response.refusals.length} refusals recorded, ${provoked} provoked on purpose${provokedLimits.length > 0 ? ` (${provokedLimits.join(', ')})` : ''}, ${unprovoked.length} unprovoked`,
    unprovoked.map(
      (refusal) =>
        `${refusal.limit} refusal for ${refusal.ip} at ${new Date(refusal.at).toISOString()}: ${refusal.detail}`,
    ),
  );
}
