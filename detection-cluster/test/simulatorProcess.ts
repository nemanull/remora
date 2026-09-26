import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { waitUntil } from './fakeCore';

const SIMULATOR_MAIN = join(
  __dirname,
  '..',
  '..',
  'hyperliquid-sim',
  'dist',
  'main.js',
);

export async function findFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class SimulatorProcess {
  private constructor(
    private readonly child: ChildProcess,
    readonly httpUrl: string,
    readonly wsUrl: string,
    readonly output: string[],
  ) {}

  static async start(
    environment: Record<string, string>,
  ): Promise<SimulatorProcess> {
    if (!existsSync(SIMULATOR_MAIN)) {
      throw new Error(
        `${SIMULATOR_MAIN} is missing, build hyperliquid-sim first`,
      );
    }
    const port = await findFreePort();
    const output: string[] = [];
    const child = spawn(process.execPath, [SIMULATOR_MAIN], {
      env: {
        ...process.env,
        ...environment,
        HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) =>
      output.push(chunk.toString('utf8')),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      output.push(chunk.toString('utf8')),
    );
    const simulator = new SimulatorProcess(
      child,
      `http://127.0.0.1:${port}`,
      `ws://127.0.0.1:${port}/ws`,
      output,
    );
    let isHealthy = false;
    const probe = setInterval(() => {
      fetch(`${simulator.httpUrl}/health`).then(
        (response) => {
          isHealthy = response.ok;
        },
        () => undefined,
      );
    }, 100);
    try {
      await waitUntil(
        () => isHealthy || child.exitCode !== null,
        30_000,
        'the simulator to answer /health',
      );
    } finally {
      clearInterval(probe);
    }
    if (!isHealthy) {
      throw new Error(`the simulator exited early:\n${output.join('')}`);
    }
    return simulator;
  }

  async readJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.httpUrl}${path}`);
    if (!response.ok) {
      throw new Error(`GET ${path} answered ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.httpUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} answered ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }
    const exited = once(this.child, 'exit');
    this.child.kill('SIGTERM');
    await exited;
  }
}
