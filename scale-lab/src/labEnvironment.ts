import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { ClustersResponse } from '@remora/sdk';
import { Pool } from 'pg';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { LAB_IMAGES, REPOSITORY_ROOT } from './labImages';
import { fetchJson, waitFor } from './waiting';

const POSTGRES_IMAGE = 'postgres:18.4';
const REDIS_IMAGE = 'redis:8.6.3';
const DATABASE_URL = 'postgresql://remora:remora@postgres:5432/remora';
const SIMULATOR_URL = 'http://hyperliquid-sim:3030';
const SERVER_PORT = 3000;
const COLLECTOR_PORT = 3010;
const WALLET_FINDER_PORT = 3020;
const SIMULATOR_PORT = 3030;
const STARTED_LOG = /Nest application successfully started/;
const SERVER_START_TIMEOUT_MS = 120_000;

export type CollectorSettings = {
  clusterId: number;
  maxWallets: number;
  sharesAddressWith?: number;
  startsLater?: boolean;
};

export type SimulatorSettings = {
  speed: number;
  restLagMs: number;
  seed?: number;
  wallets?: number;
};

export type LabSettings = {
  scenario: string;
  collectors: CollectorSettings[];
  simulator: SimulatorSettings;
  serverEnvironment?: Record<string, string>;
  walletFinderEnvironment?: Record<string, string>;
};

type SimConnections = {
  at: number;
  addresses: {
    ip: string;
    connections: number;
    newConnectionsLastMinute: number;
    users: number;
    userFillsSubscribers: string[];
  }[];
};

export function listCollectors(
  count: number,
  maxWallets: number,
): CollectorSettings[] {
  return Array.from({ length: count }, (_, index) => ({
    clusterId: index + 1,
    maxWallets,
  }));
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readRunStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

async function writeContainerLog(id: string, path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const output = createWriteStream(path);
    const child = spawn('docker', ['logs', '--timestamps', id]);
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    child.on('error', () => output.end(resolve));
    child.on('close', () => output.end(resolve));
  });
}

export class Lab {
  readonly logDirectory: string;
  readonly database: Pool;
  private readonly collectors = new Map<number, StartedTestContainer>();
  private readonly stoppedContainers = new Map<string, string>();
  private readonly deadAddresses = new Set<string>();

  private constructor(
    readonly startedAt: Date,
    readonly settings: LabSettings,
    private readonly network: StartedNetwork,
    private readonly postgres: StartedTestContainer,
    private readonly redis: StartedTestContainer,
    private readonly simulator: StartedTestContainer,
    private readonly server: StartedTestContainer,
    private readonly walletFinder: StartedTestContainer,
    readonly serverUrl: string,
    readonly simulatorUrl: string,
    databaseUrl: string,
    private readonly tokens: Map<number, string>,
  ) {
    this.logDirectory = join(
      REPOSITORY_ROOT,
      'scale-lab',
      'logs',
      `${settings.scenario}-${readRunStamp(this.startedAt)}`,
    );
    mkdirSync(this.logDirectory, { recursive: true });
    this.database = new Pool({ connectionString: databaseUrl, max: 4 });
    this.database.on('error', () => undefined);
  }

  static async start(settings: LabSettings): Promise<Lab> {
    const startedAt = new Date();
    const labels = { 'remora-lab': settings.scenario };
    const tokens = new Map(
      settings.collectors.map((collector) => [
        collector.clusterId,
        randomBytes(32).toString('hex'),
      ]),
    );
    const [postgresPort, simulatorPort, serverPort, walletFinderPort] =
      await Promise.all([
        findFreePort(),
        findFreePort(),
        findFreePort(),
        findFreePort(),
      ]);
    const network = await new Network().start();

    const [postgres, redis, simulator] = await Promise.all([
      new GenericContainer(POSTGRES_IMAGE)
        .withNetwork(network)
        .withNetworkAliases('postgres')
        .withLabels(labels)
        .withEnvironment({
          POSTGRES_USER: 'remora',
          POSTGRES_PASSWORD: 'remora',
          POSTGRES_DB: 'remora',
        })
        .withExposedPorts({ container: 5432, host: postgresPort })
        .withHealthCheck({
          test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U remora -d remora'],
          interval: 1_000,
          timeout: 3_000,
          retries: 60,
        })
        .withWaitStrategy(Wait.forHealthCheck())
        .start(),
      new GenericContainer(REDIS_IMAGE)
        .withNetwork(network)
        .withNetworkAliases('redis')
        .withLabels(labels)
        .withCommand([
          'redis-server',
          '--appendonly',
          'yes',
          '--maxmemory-policy',
          'noeviction',
        ])
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
      new GenericContainer(LAB_IMAGES.simulator)
        .withNetwork(network)
        .withNetworkAliases('hyperliquid-sim')
        .withLabels(labels)
        .withEnvironment({
          HOST: '0.0.0.0',
          PORT: String(SIMULATOR_PORT),
          SIM_SEED: String(settings.simulator.seed ?? 1),
          SIM_WALLETS: String(settings.simulator.wallets ?? 300),
          SIM_SPEED: String(settings.simulator.speed),
          SIM_REST_LAG_MS: String(settings.simulator.restLagMs),
        })
        .withExposedPorts({ container: SIMULATOR_PORT, host: simulatorPort })
        .withWaitStrategy(Wait.forHttp('/health', SIMULATOR_PORT))
        .start(),
    ]);

    const migration = await new GenericContainer(LAB_IMAGES.server)
      .withNetwork(network)
      .withLabels(labels)
      .withCommand(['npm', 'run', 'prisma:migrateDeploy'])
      .withEnvironment({ DATABASE_URL })
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(SERVER_START_TIMEOUT_MS)
      .start();
    await migration.stop();

    const tokenHashes = [...tokens]
      .map(([clusterId, token]) => `${clusterId}:${hashToken(token)}`)
      .join(',');
    const [server, walletFinder] = await Promise.all([
      new GenericContainer(LAB_IMAGES.server)
        .withNetwork(network)
        .withNetworkAliases('core')
        .withLabels(labels)
        .withEnvironment({
          DATABASE_URL,
          REDIS_URL: 'redis://redis:6379',
          HOST: '0.0.0.0',
          PORT: String(SERVER_PORT),
          EXECUTION_MODE: 'paper',
          HYPERLIQUID_WS_URL: `ws://hyperliquid-sim:${SIMULATOR_PORT}/ws`,
          HYPERLIQUID_API_URL: SIMULATOR_URL,
          CLUSTER_TOKEN_HASHES: tokenHashes,
          SELECTION_STREAK_RUNS: '1',
          ...settings.serverEnvironment,
        })
        .withExposedPorts({ container: SERVER_PORT, host: serverPort })
        .withWaitStrategy(Wait.forHttp('/health', SERVER_PORT))
        .withStartupTimeout(SERVER_START_TIMEOUT_MS)
        .start(),
      new GenericContainer(LAB_IMAGES.walletFinder)
        .withNetwork(network)
        .withLabels(labels)
        .withEnvironment({
          REDIS_URL: 'redis://redis:6379',
          HOST: '0.0.0.0',
          PORT: String(WALLET_FINDER_PORT),
          HYPERLIQUID_API_URL: SIMULATOR_URL,
          STATS_DATA_URL: `${SIMULATOR_URL}/stats/Mainnet`,
          ...settings.walletFinderEnvironment,
        })
        .withExposedPorts({
          container: WALLET_FINDER_PORT,
          host: walletFinderPort,
        })
        .withWaitStrategy(Wait.forHttp('/health', WALLET_FINDER_PORT))
        .start(),
    ]);

    const lab = new Lab(
      startedAt,
      settings,
      network,
      postgres,
      redis,
      simulator,
      server,
      walletFinder,
      `http://${server.getHost()}:${serverPort}`,
      `http://${simulator.getHost()}:${simulatorPort}`,
      `postgresql://remora:remora@${postgres.getHost()}:${postgresPort}/remora`,
      tokens,
    );
    for (const collector of settings.collectors) {
      if (!collector.startsLater) {
        await lab.startCollector(collector.clusterId);
      }
    }
    await lab.waitUntilOnline(
      settings.collectors
        .filter((collector) => !collector.startsLater)
        .map((collector) => collector.clusterId),
    );
    return lab;
  }

  async startCollector(clusterId: number): Promise<void> {
    const collector = this.readCollectorSettings(clusterId);
    const token = this.tokens.get(clusterId) ?? '';
    const sharesAddress = collector.sharesAddressWith !== undefined;
    let container = new GenericContainer(LAB_IMAGES.collector)
      .withLabels({ 'remora-lab': this.settings.scenario })
      .withEnvironment({
        CLUSTER_ID: String(clusterId),
        CLUSTER_TOKEN: token,
        CORE_URL: `ws://core:${SERVER_PORT}/cluster`,
        MAX_WALLETS: String(collector.maxWallets),
        HYPERLIQUID_WS_URL: `ws://hyperliquid-sim:${SIMULATOR_PORT}/ws`,
        HYPERLIQUID_API_URL: SIMULATOR_URL,
        HOST: '0.0.0.0',
        PORT: String(
          sharesAddress ? COLLECTOR_PORT + clusterId : COLLECTOR_PORT,
        ),
      })
      .withWaitStrategy(Wait.forLogMessage(STARTED_LOG));
    if (collector.sharesAddressWith === undefined) {
      container = container.withNetwork(this.network);
    } else {
      const owner = this.collectors.get(collector.sharesAddressWith);
      if (!owner) {
        throw new Error(
          `Collector ${clusterId} shares the address of collector ${collector.sharesAddressWith}, which is not running`,
        );
      }
      container = container.withNetworkMode(`container:${owner.getId()}`);
    }
    const started = await container.start();
    this.collectors.set(clusterId, started);
    if (!sharesAddress) {
      this.deadAddresses.delete(started.getIpAddress(this.network.getName()));
    }
  }

  async killCollector(clusterId: number): Promise<void> {
    const collector = this.collectors.get(clusterId);
    if (!collector) {
      throw new Error(`Collector ${clusterId} is not running`);
    }
    if (this.readCollectorSettings(clusterId).sharesAddressWith === undefined) {
      this.deadAddresses.add(collector.getIpAddress(this.network.getName()));
    }
    this.collectors.delete(clusterId);
    this.stoppedContainers.set(collector.getId(), `collector-${clusterId}`);
    await collector.stop({ timeout: 0, remove: false });
  }

  async restartServer(): Promise<void> {
    await this.server.restart({ timeout: 30 });
    await this.waitUntilServerHealthy();
  }

  async killAndStartServer(): Promise<void> {
    const client = await getContainerRuntimeClient();
    const container = client.container.getById(this.server.getId());
    await container.kill();
    await client.container.start(container);
    await this.waitUntilServerHealthy();
  }

  async stopPostgres(): Promise<void> {
    const client = await getContainerRuntimeClient();
    await client.container.stop(
      client.container.getById(this.postgres.getId()),
      { timeout: 10 },
    );
  }

  async startPostgres(): Promise<void> {
    const client = await getContainerRuntimeClient();
    await client.container.start(
      client.container.getById(this.postgres.getId()),
    );
    await waitFor(
      'Postgres answers again',
      async () => {
        await this.database.query('SELECT 1');
        return true;
      },
      60_000,
    );
  }

  async dropUpstreamSockets(): Promise<number> {
    const result = await fetchJson<{ droppedSockets?: number }>(
      `${this.simulatorUrl}/sim/faults`,
      { method: 'POST', body: JSON.stringify({ type: 'drop_sockets' }) },
    );
    return result.droppedSockets ?? 0;
  }

  async addLeaders(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      await fetchJson(`${this.serverUrl}/api/leaders`, {
        method: 'POST',
        body: JSON.stringify({ address }),
      });
    }
  }

  async readClusters(): Promise<ClustersResponse> {
    return fetchJson<ClustersResponse>(`${this.serverUrl}/api/clusters`);
  }

  async readConnections(): Promise<SimConnections> {
    return fetchJson<SimConnections>(`${this.simulatorUrl}/sim/connections`);
  }

  async readSubscribedWallets(): Promise<Set<string>> {
    const connections = await this.readConnections();
    return new Set(
      connections.addresses
        .filter((address) => !this.deadAddresses.has(address.ip))
        .flatMap((address) => address.userFillsSubscribers),
    );
  }

  async waitUntilOnline(clusterIds: number[]): Promise<void> {
    await waitFor(
      `clusters ${clusterIds.join(', ')} are online`,
      async () => {
        const { clusters } = await this.readClusters();
        const online = new Set(
          clusters
            .filter((cluster) => cluster.isOnline)
            .map((cluster) => cluster.id),
        );
        return clusterIds.every((id) => online.has(id)) ? true : null;
      },
      120_000,
    );
  }

  async waitUntilSubscribed(
    addresses: string[],
    timeoutMs: number,
  ): Promise<number> {
    const startedAt = Date.now();
    await waitFor(
      `all ${addresses.length} wallets are subscribed at the simulator`,
      async () => {
        const subscribed = await this.readSubscribedWallets();
        return addresses.every((address) => subscribed.has(address))
          ? true
          : null;
      },
      timeoutMs,
      250,
    );
    return Date.now() - startedAt;
  }

  async waitUntilSynced(
    addresses: string[],
    after: Date,
    timeoutMs: number,
  ): Promise<number> {
    const startedAt = Date.now();
    await waitFor(
      `all ${addresses.length} wallets report a synced backfill after ${after.toISOString()}`,
      async () => {
        const synced = await this.readSyncedWallets(after);
        return addresses.every((address) => synced.has(address)) ? true : null;
      },
      timeoutMs,
      1_000,
    );
    return Date.now() - startedAt;
  }

  async readSyncedWallets(after: Date): Promise<Set<string>> {
    const { clusters } = await this.readClusters();
    const synced = new Set<string>();
    for (const cluster of clusters) {
      if (
        !cluster.isOnline ||
        cluster.stats === null ||
        cluster.lastHeartbeatAt === null ||
        cluster.connectedAt === null ||
        new Date(cluster.lastHeartbeatAt) <= after ||
        new Date(cluster.lastHeartbeatAt) <= new Date(cluster.connectedAt)
      ) {
        continue;
      }
      const assigned = new Set(cluster.wallets.map((wallet) => wallet.address));
      for (const wallet of cluster.stats.wallets) {
        if (wallet.backfill === 'synced' && assigned.has(wallet.address)) {
          synced.add(wallet.address);
        }
      }
    }
    return synced;
  }

  async readServerLog(): Promise<string> {
    const path = join(this.logDirectory, 'server-now.log');
    await writeContainerLog(this.server.getId(), path);
    return readFile(path, 'utf8');
  }

  async stop(): Promise<void> {
    const running: [string, StartedTestContainer][] = [
      ['postgres', this.postgres],
      ['redis', this.redis],
      ['hyperliquid-sim', this.simulator],
      ['server', this.server],
      ['wallet-finder', this.walletFinder],
      ...[...this.collectors].map(
        ([clusterId, container]): [string, StartedTestContainer] => [
          `collector-${clusterId}`,
          container,
        ],
      ),
    ];
    await Promise.all([
      ...running.map(([name, container]) =>
        writeContainerLog(
          container.getId(),
          join(this.logDirectory, `${name}.log`),
        ),
      ),
      ...[...this.stoppedContainers].map(([id, name]) =>
        writeContainerLog(id, join(this.logDirectory, `${name}.log`)),
      ),
    ]);
    await this.database.end();
    const sharingCollectors = running.filter(([name]) =>
      this.settings.collectors.some(
        (collector) =>
          collector.sharesAddressWith !== undefined &&
          name === `collector-${collector.clusterId}`,
      ),
    );
    for (const [, container] of sharingCollectors) {
      await container.stop({ timeout: 5 });
    }
    await Promise.all(
      running
        .filter((entry) => !sharingCollectors.includes(entry))
        .map(([, container]) => container.stop({ timeout: 5 })),
    );
    const client = await getContainerRuntimeClient();
    await Promise.all(
      [...this.stoppedContainers.keys()].map((id) =>
        client.container.remove(client.container.getById(id)),
      ),
    );
    await this.network.stop();
  }

  private readCollectorSettings(clusterId: number): CollectorSettings {
    const collector = this.settings.collectors.find(
      (entry) => entry.clusterId === clusterId,
    );
    if (!collector) {
      throw new Error(`The lab defines no collector ${clusterId}`);
    }
    return collector;
  }

  private async waitUntilServerHealthy(): Promise<void> {
    await waitFor(
      'the server answers /health',
      async () => {
        const response = await fetch(`${this.serverUrl}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok ? true : null;
      },
      SERVER_START_TIMEOUT_MS,
    );
  }
}
