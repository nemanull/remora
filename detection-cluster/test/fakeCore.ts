import {
  parseCollectorFrame,
  type AssignMessage,
  type CollectorMessage,
  type WalletAssignment,
} from '@remora/sdk';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

export type FakeCoreOptions = {
  token: string;
  assignOnHello?: WalletAssignment[];
};

export async function waitUntil(
  condition: () => boolean,
  timeoutMs = 10_000,
  describe = 'condition',
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${describe}`);
    }
    await delay(2);
  }
}

export class FakeCore {
  readonly frames: CollectorMessage[] = [];
  readonly invalidFrames: string[] = [];
  readonly sessions: WebSocket[] = [];
  rejectedUpgrades = 0;
  acknowledgesHeartbeats = true;
  serverTimeOffsetMs = 0;
  assignOnHello: WalletAssignment[] | null;
  private assignVersion = 0;
  private readonly server = new WebSocketServer({ noServer: true });

  private constructor(
    private readonly http: Server,
    private readonly token: string,
    readonly url: string,
    assignOnHello: WalletAssignment[] | undefined,
  ) {
    this.assignOnHello = assignOnHello ?? null;
    http.on(
      'upgrade',
      (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        this.handleUpgrade(request, socket, head),
    );
  }

  static async start(options: FakeCoreOptions): Promise<FakeCore> {
    const http = createServer();
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const { port } = http.address() as AddressInfo;
    return new FakeCore(
      http,
      options.token,
      `ws://127.0.0.1:${port}/cluster`,
      options.assignOnHello,
    );
  }

  get currentSession(): WebSocket | undefined {
    return this.sessions.at(-1);
  }

  framesOf<T extends CollectorMessage['type']>(
    type: T,
  ): Extract<CollectorMessage, { type: T }>[] {
    return this.frames.filter(
      (frame): frame is Extract<CollectorMessage, { type: T }> =>
        frame.type === type,
    );
  }

  sendAssign(wallets: WalletAssignment[]): AssignMessage {
    this.assignVersion += 1;
    const assign: AssignMessage = {
      type: 'assign',
      version: this.assignVersion,
      wallets,
    };
    this.currentSession?.send(JSON.stringify(assign));
    return assign;
  }

  async waitForFrame(
    predicate: (frame: CollectorMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<number> {
    let index = -1;
    await waitUntil(
      () => {
        index = this.frames.findIndex(predicate);
        return index >= 0;
      },
      timeoutMs,
      'a matching collector frame',
    );
    return index;
  }

  dropSession(): void {
    this.currentSession?.terminate();
  }

  async close(): Promise<void> {
    for (const session of this.sessions) {
      session.terminate();
    }
    this.server.close();
    this.http.closeAllConnections();
    await new Promise((resolve) => this.http.close(resolve));
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      this.rejectedUpgrades += 1;
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    this.server.handleUpgrade(request, socket, head, (session) => {
      this.sessions.push(session);
      session.on('message', (data: Buffer) =>
        this.handleFrame(session, data.toString('utf8')),
      );
    });
  }

  private handleFrame(session: WebSocket, raw: string): void {
    const parsed = parseCollectorFrame(raw);
    if (!parsed.ok) {
      this.invalidFrames.push(parsed.reason);
      return;
    }
    const message = parsed.message;
    this.frames.push(message);
    if (message.type === 'hello' && this.assignOnHello !== null) {
      this.sendAssign(this.assignOnHello);
    }
    if (message.type === 'heartbeat' && this.acknowledgesHeartbeats) {
      session.send(
        JSON.stringify({
          type: 'heartbeatAck',
          sentAt: message.sentAt,
          serverTime: Date.now() + this.serverTimeOffsetMs,
        }),
      );
    }
  }
}
