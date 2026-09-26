const WINDOW_MS = 60_000;
const MAX_RECORDED_REFUSALS = 10_000;

export type LimitName =
  | 'connections'
  | 'new_connections'
  | 'users'
  | 'subscriptions'
  | 'messages'
  | 'rest_weight';

export type IpLimitSettings = {
  maxConnections: number;
  newConnectionsPerMinute: number;
  maxUsers: number;
  maxSubscriptions: number;
  messagesPerMinute: number;
  weightPerMinute: number;
};

export type LimitRefusal = {
  at: number;
  ip: string;
  limit: LimitName;
  detail: string;
};

export type AddressUsageSummary = {
  ip: string;
  connections: number;
  connectionsOpened: number;
  newConnectionsLastMinute: number;
  users: number;
  subscriptions: number;
  messagesLastMinute: number;
  weightLastMinute: number;
};

type Spend = { at: number; weight: number };

type AddressUsage = {
  connections: number;
  connectionsOpened: number;
  connectionTimes: number[];
  messageTimes: number[];
  weightSpends: Spend[];
  subscriptions: number;
  userSubscriptions: Map<string, number>;
};

export function normalizeSourceAddress(address: string | undefined): string {
  if (!address) {
    return 'unknown';
  }
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function dropOlderThan<T>(
  entries: T[],
  cutoff: number,
  timeOf: (entry: T) => number,
): void {
  while (entries.length > 0 && timeOf(entries[0]) <= cutoff) {
    entries.shift();
  }
}

export class IpLimits {
  private readonly usage = new Map<string, AddressUsage>();
  private readonly refusals: LimitRefusal[] = [];
  private readonly refusalCounts = new Map<LimitName, number>();

  constructor(readonly settings: IpLimitSettings) {}

  admitConnection(ip: string, now: number): boolean {
    const usage = this.readUsage(ip);
    dropOlderThan(usage.connectionTimes, now - WINDOW_MS, (time) => time);
    if (usage.connections >= this.settings.maxConnections) {
      this.refuse(
        now,
        ip,
        'connections',
        `${usage.connections} connections are open`,
      );
      return false;
    }
    if (usage.connectionTimes.length >= this.settings.newConnectionsPerMinute) {
      this.refuse(
        now,
        ip,
        'new_connections',
        `${usage.connectionTimes.length} connections opened in the last minute`,
      );
      return false;
    }
    usage.connections += 1;
    usage.connectionsOpened += 1;
    usage.connectionTimes.push(now);
    return true;
  }

  releaseConnection(ip: string): void {
    const usage = this.readUsage(ip);
    usage.connections = Math.max(0, usage.connections - 1);
  }

  admitMessage(ip: string, now: number): boolean {
    const usage = this.readUsage(ip);
    dropOlderThan(usage.messageTimes, now - WINDOW_MS, (time) => time);
    if (usage.messageTimes.length >= this.settings.messagesPerMinute) {
      this.refuse(
        now,
        ip,
        'messages',
        `${usage.messageTimes.length} messages sent in the last minute`,
      );
      return false;
    }
    usage.messageTimes.push(now);
    return true;
  }

  admitSubscription(
    ip: string,
    user: string | null,
    now: number,
  ): LimitName | null {
    const usage = this.readUsage(ip);
    if (usage.subscriptions >= this.settings.maxSubscriptions) {
      this.refuse(
        now,
        ip,
        'subscriptions',
        `${usage.subscriptions} subscriptions are active`,
      );
      return 'subscriptions';
    }
    if (
      user !== null &&
      !usage.userSubscriptions.has(user) &&
      usage.userSubscriptions.size >= this.settings.maxUsers
    ) {
      this.refuse(
        now,
        ip,
        'users',
        `user ${user} would exceed ${this.settings.maxUsers} tracked users`,
      );
      return 'users';
    }
    usage.subscriptions += 1;
    if (user !== null) {
      usage.userSubscriptions.set(
        user,
        (usage.userSubscriptions.get(user) ?? 0) + 1,
      );
    }
    return null;
  }

  releaseSubscription(ip: string, user: string | null): void {
    const usage = this.readUsage(ip);
    usage.subscriptions = Math.max(0, usage.subscriptions - 1);
    if (user === null) {
      return;
    }
    const remaining = (usage.userSubscriptions.get(user) ?? 0) - 1;
    if (remaining > 0) {
      usage.userSubscriptions.set(user, remaining);
    } else {
      usage.userSubscriptions.delete(user);
    }
  }

  admitWeight(ip: string, weight: number, now: number): boolean {
    const usage = this.readUsage(ip);
    dropOlderThan(usage.weightSpends, now - WINDOW_MS, (spend) => spend.at);
    const used = usage.weightSpends.reduce(
      (sum, spend) => sum + spend.weight,
      0,
    );
    if (used + weight > this.settings.weightPerMinute) {
      this.refuse(
        now,
        ip,
        'rest_weight',
        `${used} weight used in the last minute, ${weight} requested`,
      );
      return false;
    }
    usage.weightSpends.push({ at: now, weight });
    return true;
  }

  chargeWeight(ip: string, weight: number, now: number): void {
    if (weight > 0) {
      this.readUsage(ip).weightSpends.push({ at: now, weight });
    }
  }

  summarizeUsage(now: number): AddressUsageSummary[] {
    return [...this.usage.entries()].map(([ip, usage]) => {
      dropOlderThan(usage.connectionTimes, now - WINDOW_MS, (time) => time);
      dropOlderThan(usage.messageTimes, now - WINDOW_MS, (time) => time);
      dropOlderThan(usage.weightSpends, now - WINDOW_MS, (spend) => spend.at);
      return {
        ip,
        connections: usage.connections,
        connectionsOpened: usage.connectionsOpened,
        newConnectionsLastMinute: usage.connectionTimes.length,
        users: usage.userSubscriptions.size,
        subscriptions: usage.subscriptions,
        messagesLastMinute: usage.messageTimes.length,
        weightLastMinute: usage.weightSpends.reduce(
          (sum, spend) => sum + spend.weight,
          0,
        ),
      };
    });
  }

  readRefusals(since = 0): LimitRefusal[] {
    return this.refusals.filter((refusal) => refusal.at >= since);
  }

  readRefusalCounts(): Record<LimitName, number> {
    return {
      connections: this.refusalCounts.get('connections') ?? 0,
      new_connections: this.refusalCounts.get('new_connections') ?? 0,
      users: this.refusalCounts.get('users') ?? 0,
      subscriptions: this.refusalCounts.get('subscriptions') ?? 0,
      messages: this.refusalCounts.get('messages') ?? 0,
      rest_weight: this.refusalCounts.get('rest_weight') ?? 0,
    };
  }

  private refuse(
    at: number,
    ip: string,
    limit: LimitName,
    detail: string,
  ): void {
    this.refusals.push({ at, ip, limit, detail });
    if (this.refusals.length > MAX_RECORDED_REFUSALS) {
      this.refusals.shift();
    }
    this.refusalCounts.set(limit, (this.refusalCounts.get(limit) ?? 0) + 1);
  }

  private readUsage(ip: string): AddressUsage {
    let usage = this.usage.get(ip);
    if (!usage) {
      usage = {
        connections: 0,
        connectionsOpened: 0,
        connectionTimes: [],
        messageTimes: [],
        weightSpends: [],
        subscriptions: 0,
        userSubscriptions: new Map(),
      };
      this.usage.set(ip, usage);
    }
    return usage;
  }
}
