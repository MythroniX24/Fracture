/**
 * Browser network layer.
 *
 * Responsibilities:
 *  - own the WebSocket, reconnect with backoff, and re-claim the room slot with
 *    the stored reconnect token
 *  - buffer authoritative snapshots for interpolation and expose a lookup by
 *    render time
 *  - sequence and send input frames at a fixed rate (never positions)
 *
 * The renderer reads from here every frame; React only subscribes to the
 * lightweight HUD store.
 */
import {
  emptyInput,
  parseServerMessage,
  type ErrorCode,
  type MatchResults,
  type PlayerInput,
  type RoomSummary,
  type ServerMessage,
  type Snapshot,
} from '@fracture/shared';

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface TimedSnapshot {
  snapshot: Snapshot;
  /** performance.now() when the snapshot arrived. */
  arrival: number;
}

export interface NetClientHandlers {
  onStatus?: (status: ConnectionStatus) => void;
  onRoom?: (room: RoomSummary) => void;
  onSnapshot?: (snapshot: Snapshot) => void;
  onResults?: (results: MatchResults) => void;
  onError?: (code: ErrorCode, message: string) => void;
  onJoined?: (playerId: string, code: string) => void;
  /** Transient user-facing notice; `null` clears it. */
  onNotice?: (message: string | null) => void;
}

const MAX_BUFFERED_SNAPSHOTS = 40;
const TOKEN_KEY_PREFIX = 'fracture.token.';

function websocketUrl(): string {
  const configured = import.meta.env.VITE_SERVER_WS_URL as string | undefined;
  if (configured && configured.length > 0) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export class NetClient {
  status: ConnectionStatus = 'idle';
  room: RoomSummary | null = null;
  results: MatchResults | null = null;
  playerId: string | null = null;
  code: string | null = null;
  pingMs = 0;
  /** True once the socket is open (before joining a room). */
  lastError: { code: ErrorCode; message: string } | null = null;

  private socket: WebSocket | null = null;
  private buffer: TimedSnapshot[] = [];
  private inputSeq = 0;
  private handlers = new Set<NetClientHandlers>();
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private shouldReconnect = false;
  private pendingJoin: { mode: 'create' | 'join'; name: string; code?: string } | null = null;
  private name = 'Fighter';

/**
   * Register a handler set. Multiple subscribers are supported: the renderer
   * listens for snapshots while React listens for room/status changes.
   * Returns an unsubscribe function.
   */
  subscribe(handlers: NetClientHandlers): () => void {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }

  private emit<K extends keyof NetClientHandlers>(
    key: K,
    ...args: Parameters<NonNullable<NetClientHandlers[K]>>
  ): void {
    for (const handlers of this.handlers) {
      const callback = handlers[key];
      if (callback) (callback as (...params: unknown[]) => void)(...args);
    }
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get latestSnapshot(): Snapshot | null {
    return this.buffer.at(-1)?.snapshot ?? null;
  }

  setName(name: string): void {
    this.name = name;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  createRoom(name: string): void {
    this.name = name;
    this.pendingJoin = { mode: 'create', name };
    this.open(true);
  }

  joinRoom(code: string, name: string): void {
    this.name = name;
    this.pendingJoin = { mode: 'join', name, code: code.trim().toUpperCase() };
    this.open(true);
  }

  private open(fresh: boolean): void {
    if (fresh) {
      this.closeSocket();
      this.buffer = [];
      this.setStatus(this.socket ? 'reconnecting' : 'connecting');
    }
    if (this.connected) return;

    try {
      this.socket = new WebSocket(websocketUrl());
    } catch (error) {
      this.emit('onError', 'server-error', (error as Error).message);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      const pending = this.pendingJoin;
      if (!pending) return;
      if (pending.mode === 'create') {
        this.sendRaw({ t: 'create', name: pending.name });
      } else {
        const token = this.storedToken(pending.code!);
        this.sendRaw({
          t: 'join',
          name: pending.name,
          code: pending.code!,
          ...(token ? { token } : {}),
        });
      }
    };

    this.socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      this.handle(message);
    };

    this.socket.onerror = () => {
      // The close handler drives recovery; avoid double reporting.
    };

    this.socket.onclose = () => {
      this.socket = null;
      if (this.shouldReconnect) {
        this.setStatus('reconnecting');
        this.scheduleReconnect();
      } else {
        this.setStatus('offline');
      }
    };

    this.shouldReconnect = true;
  }

  private scheduleReconnect(): void {
    if (!this.pendingJoin) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(8000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open(false);
    }, delay);
    this.emit('onNotice', `Connection lost — reconnecting (attempt ${this.reconnectAttempts})…`);
  }

  /** Close the socket and stop trying to reconnect. */
  disconnect(): void {
    this.shouldReconnect = false;
    this.pendingJoin = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.buffer = [];
    this.room = null;
    this.results = null;
    this.playerId = null;
    this.setStatus('offline');
  }

  private closeSocket(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Protocol
  // -------------------------------------------------------------------------

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'joined': {
        this.playerId = message.playerId;
        this.code = message.code;
        this.room = message.room;
        this.storeToken(message.code, message.token);
        this.setStatus('online');
        this.emit('onJoined', message.playerId, message.code);
        this.emit('onRoom', message.room);
        this.startPing();
        this.emit('onNotice', null);
        break;
      }
      case 'room':
        this.room = message.room;
        this.emit('onRoom', message.room);
        break;
      case 'snapshot': {
        const arrival = performance.now();
        this.buffer.push({ snapshot: message.snapshot, arrival });
        if (this.buffer.length > MAX_BUFFERED_SNAPSHOTS) this.buffer.shift();
        this.emit('onSnapshot', message.snapshot);
        break;
      }
      case 'results':
        this.results = message.results;
        this.emit('onResults', message.results);
        break;
      case 'error':
        this.lastError = { code: message.code, message: message.message };
        this.emit('onError', message.code, message.message);
        break;
      case 'left':
        this.room = null;
        this.results = null;
        this.playerId = null;
        this.setStatus('idle');
        break;
      case 'pong':
        this.pingMs = Math.max(0, Date.now() - message.ts);
        break;
      default:
        break;
    }
  }

  private startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = window.setInterval(() => {
      if (this.connected) this.sendRaw({ t: 'ping', ts: Date.now() });
    }, 2000);
  }

  private sendRaw(payload: unknown): void {
    if (!this.connected) return;
    try {
      this.socket!.send(JSON.stringify(payload));
    } catch {
      /* the close handler will pick this up */
    }
  }

  setReady(ready: boolean): void {
    this.sendRaw({ t: 'ready', ready });
  }

  requestStart(): void {
    this.sendRaw({ t: 'start' });
  }

  requestRematch(): void {
    this.sendRaw({ t: 'rematch' });
  }

  leaveRoom(): void {
    this.sendRaw({ t: 'leave' });
    if (this.code) {
      window.localStorage.removeItem(TOKEN_KEY_PREFIX + this.code);
    }
    this.room = null;
    this.results = null;
    this.playerId = null;
    this.code = null;
    this.buffer = [];
  }

  /** Send a fully-sequenced input frame. Positions are never sent. */
  sendInput(partial: Partial<PlayerInput>): void {
    if (!this.connected) return;
    this.inputSeq += 1;
    const input: PlayerInput = { ...emptyInput(this.inputSeq), ...partial, seq: this.inputSeq };
    this.sendRaw({ t: 'input', input });
  }

  // -------------------------------------------------------------------------
  // Interpolation
  // -------------------------------------------------------------------------

  /**
   * Snapshots bracketing `renderTime` (server simulation ms), or the newest
   * snapshot when the render time is ahead of the buffer.
   */
  samplesFor(renderTime: number): { from: TimedSnapshot; to: TimedSnapshot } | null {
    if (this.buffer.length === 0) return null;
    if (this.buffer.length === 1) {
      const only = this.buffer[0]!;
      return { from: only, to: only };
    }
    for (let i = this.buffer.length - 1; i > 0; i -= 1) {
      const to = this.buffer[i]!;
      const from = this.buffer[i - 1]!;
      if (from.snapshot.time <= renderTime && renderTime <= to.snapshot.time) {
        return { from, to };
      }
    }
    const newest = this.buffer.at(-1)!;
    const oldest = this.buffer[0]!;
    if (renderTime < oldest.snapshot.time) return { from: oldest, to: oldest };
    return { from: newest, to: newest };
  }

  /** Current interpolation delay: one and a half snapshots plus measured jitter. */
  get renderTime(): number {
    const newest = this.buffer.at(-1);
    if (!newest) return 0;
    const elapsed = performance.now() - newest.arrival;
    // Never extrapolate more than a quarter second ahead of the last snapshot.
    return newest.snapshot.time - 110 + Math.min(elapsed, 250);
  }

  // -------------------------------------------------------------------------
  // Reconnect tokens
  // -------------------------------------------------------------------------

  private tokenKey(code: string): string {
    return TOKEN_KEY_PREFIX + code;
  }

  private storeToken(code: string, token: string): void {
    try {
      window.localStorage.setItem(this.tokenKey(code), token);
    } catch {
      /* storage can be unavailable in private modes */
    }
  }

  storedToken(code: string): string | null {
    try {
      return window.localStorage.getItem(this.tokenKey(code));
    } catch {
      return null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('onStatus', status);
  }
}
