import {
  parseCoreFrame,
  reconnectDelayMs,
  type AssignMessage,
  type CollectorMessage,
  type CollectorStats,
  type HelloMessage,
} from '@remora/sdk';
import WebSocket from 'ws';

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
export const MAX_SEND_BUFFER_BYTES = 16 * 1024 * 1024;
const STABLE_LINK_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export type CoreLinkState = 'connecting' | 'open' | 'closed';

export type CoreLinkOptions = {
  url: string;
  token: string;
  createHello: () => HelloMessage;
  readStats: () => CollectorStats;
  onOpen: () => void;
  onAssign: (assign: AssignMessage) => void;
  onClose: (reason: string, reconnectInMs: number) => void;
  onInvalidFrame: (reason: string) => void;
};

export class CoreLink {
  private socket: WebSocket | null = null;
  private state: CoreLinkState = 'closed';
  private isStarted = false;
  private isStopped = false;
  private attempt = 0;
  private openedAt: number | null = null;
  private clockOffsetMs: number | null = null;
  private lastFailure: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private ackTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: CoreLinkOptions) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  readState(): CoreLinkState {
    return this.state;
  }

  readClockOffsetMs(): number | null {
    return this.clockOffsetMs;
  }

  start(): void {
    if (this.isStarted || this.isStopped) {
      return;
    }
    this.isStarted = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.terminate();
    await closed;
  }

  send(message: CollectorMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    if (socket.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
      this.lastFailure = `send buffer passed ${MAX_SEND_BUFFER_BYTES} bytes`;
      socket.terminate();
    }
    return true;
  }

  private connect(): void {
    this.state = 'connecting';
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.socket = socket;
    socket.on('open', () => this.handleOpen(socket));
    socket.on('message', (data: Buffer) => {
      if (this.socket === socket) {
        this.handleMessage(data.toString('utf8'));
      }
    });
    socket.on('error', (error) => {
      this.lastFailure = error.message;
    });
    socket.on('close', (code, reason) =>
      this.handleClose(socket, code, reason.toString()),
    );
  }

  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.state = 'open';
    this.openedAt = Date.now();
    this.lastFailure = null;
    socket.send(JSON.stringify(this.options.createHello()));
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );
    this.armAckTimer(socket);
    this.options.onOpen();
  }

  private handleMessage(raw: string): void {
    const parsed = parseCoreFrame(raw);
    if (!parsed.ok) {
      this.options.onInvalidFrame(parsed.reason);
      return;
    }
    const message = parsed.message;
    if (message.type === 'assign') {
      this.options.onAssign(message);
      return;
    }
    const receivedAt = Date.now();
    const roundTripMs = receivedAt - message.sentAt;
    this.clockOffsetMs =
      message.serverTime - (message.sentAt + roundTripMs / 2);
    if (this.socket) {
      this.armAckTimer(this.socket);
    }
  }

  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.state = 'closed';
    this.stopHeartbeat();
    const wasStable =
      this.openedAt !== null && Date.now() - this.openedAt >= STABLE_LINK_MS;
    this.openedAt = null;
    if (this.isStopped) {
      return;
    }
    if (wasStable) {
      this.attempt = 0;
    }
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    const detail = reason ? `code ${code}, ${reason}` : `code ${code}`;
    this.options.onClose(`${this.lastFailure ?? 'closed'} (${detail})`, delay);
    this.lastFailure = null;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private sendHeartbeat(): void {
    this.send({
      type: 'heartbeat',
      sentAt: Date.now(),
      stats: this.options.readStats(),
    });
  }

  private armAckTimer(socket: WebSocket): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.lastFailure = `no heartbeatAck within ${HEARTBEAT_ACK_TIMEOUT_MS} ms`;
      socket.terminate();
    }, HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.ackTimer);
    this.heartbeatTimer = undefined;
    this.ackTimer = undefined;
  }
}
