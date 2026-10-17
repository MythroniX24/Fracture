/**
 * A FRACTURE room.
 *
 * Owns one `MatchSim`, the sockets attached to it, reconnect tokens, host
 * ownership and broadcast cadence. The simulation is the single source of truth
 * for lobby membership, phases, scores and match time; this class only moves
 * messages in and out and enforces room-level policy (capacity, host-only
 * actions, reconnect windows, cleanup).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  MATCHMAKING,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MatchSim,
  RECONNECT_WINDOW_MS,
  RESULTS_LINGER_MS,
  type PlayerInput,
  type RoomSummary,
  type ServerMessage,
} from '@fracture/shared';
import type { Logger } from './logger.js';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

const OPEN = 1;

/** Safety cap so a fill can never loop forever. */
const MAX_BOTS_PER_FILL = MAX_PLAYERS;

export interface RoomOptions {
  /**
   * Milliseconds a lone human waits for a real opponent before the server
   * fills the arena with bots and starts anyway. `<= 0` disables the automatic
   * fill entirely (the integration test harness relies on this).
   */
  botFillDelayMs?: number;
}

interface Connection {
  playerId: string;
  token: string;
  socket: SocketLike;
}

export type JoinResult =
  | { ok: true; playerId: string; token: string; reconnected: boolean }
  | { ok: false; code: 'room-full'; message: string };

export class Room {
  readonly code: string;
  readonly sim: MatchSim;
  readonly createdAt = Date.now();

  private readonly connections = new Map<string, Connection>();
  private readonly tokens = new Map<string, string>();
  /** Match index whose results have already been broadcast. */
  private resultsBroadcastFor = -1;
  /** Wall-clock time at which the last socket disappeared. */
  private emptySince: number | null = Date.now();
  /** Wall-clock time the current matchmaking wait began, or null. */
  private matchmakingSince: number | null = null;
  private readonly botFillDelayMs: number;
  private readonly log: Logger;

  constructor(code: string, log: Logger, options: RoomOptions = {}) {
    this.code = code;
    this.sim = new MatchSim();
    this.botFillDelayMs = options.botFillDelayMs ?? MATCHMAKING.botFillDelayMs;
    this.log = log.child(`room:${code}`);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  get openSockets(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.socket.readyState === OPEN) count += 1;
    }
    return count;
  }

  get hasSockets(): boolean {
    return this.openSockets > 0;
  }

  get finishedAt(): number | null {
    if (this.sim.phase !== 'results' || !this.sim.results) return null;
    return this.sim.results.finishedAt;
  }

  hasPlayer(playerId: string): boolean {
    return this.sim.getPlayer(playerId) !== undefined;
  }

  socketFor(playerId: string): SocketLike | undefined {
    return this.connections.get(playerId)?.socket;
  }

  summary(): RoomSummary {
    const host = this.sim.isHostCandidate();
    return {
      code: this.code,
      phase: this.sim.phase,
      hostId: host?.id ?? null,
      maxPlayers: this.sim.maxPlayers,
      countdownRemainingMs: Math.round(this.sim.countdownRemainingMs),
      matchRemainingMs: Math.round(this.sim.matchRemainingMs),
      matchmakingRemainingMs: Math.round(this.matchmakingRemainingMs(Date.now())),
      humans: this.sim.humanCount,
      tick: this.sim.tick,
      players: this.sim.orderedPlayers().map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        ready: player.ready,
        connected: player.connected,
        host: host?.id === player.id,
        bot: player.isBot,
        slot: player.slot,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /**
   * Attach a fresh socket. A valid reconnect token reclaims the previous
   * fighter; otherwise a new player is created when a slot is free.
   */
  join(socket: SocketLike, name: string, token?: string): JoinResult {
    if (token) {
      const existingId = this.tokens.get(token);
      if (existingId && this.sim.hasPlayer(existingId)) {
        this.attach(socket, existingId, token);
        this.sim.markReconnected(existingId);
        this.emptySince = null;
        this.log.info('player reconnected', { playerId: existingId });
        return { ok: true, playerId: existingId, token, reconnected: true };
      }
    }

    if (this.sim.full) {
      return { ok: false, code: 'room-full', message: 'This room is full' };
    }

    const playerId = randomUUID();
    const newToken = randomBytes(18).toString('base64url');
    this.sim.addPlayer(playerId, name);
    this.tokens.set(newToken, playerId);
    this.attach(socket, playerId, newToken);
    this.emptySince = null;
    this.log.info('player joined', { playerId, name, players: this.sim.players.length });
    return { ok: true, playerId, token: newToken, reconnected: false };
  }

  private attach(socket: SocketLike, playerId: string, token: string): void {
    this.connections.set(playerId, { playerId, token, socket });
  }

  /**
   * Socket closed or player left. `permanent` removes the fighter at once;
   * otherwise the slot is held for the reconnect window.
   */
  leave(playerId: string, permanent: boolean): void {
    this.connections.delete(playerId);

    if (!this.sim.hasPlayer(playerId)) return;

    if (permanent) {
      this.forgetTokens(playerId);
      this.sim.removePlayer(playerId);
      this.log.info('player left', { playerId, players: this.sim.players.length });
    } else {
      this.sim.markDisconnected(playerId);
      this.log.info('player disconnected', { playerId, reconnectWindowMs: RECONNECT_WINDOW_MS });
    }

    if (!this.hasSockets && this.emptySince === null) this.emptySince = Date.now();
  }

  private forgetTokens(playerId: string): void {
    for (const [token, id] of [...this.tokens]) {
      if (id === playerId) this.tokens.delete(token);
    }
  }

  sendTo(playerId: string, message: ServerMessage): void {
    const connection = this.connections.get(playerId);
    if (!connection || connection.socket.readyState !== OPEN) return;
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (error) {
      this.log.warn('send failed', { playerId, error: (error as Error).message });
    }
  }

  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      if (connection.socket.readyState !== OPEN) continue;
      try {
        connection.socket.send(payload);
      } catch (error) {
        this.log.warn('broadcast failed', { error: (error as Error).message });
      }
    }
  }

  broadcastRoom(): void {
    this.broadcast({ t: 'room', room: this.summary() });
  }

  // -------------------------------------------------------------------------
  // Player actions
  // -------------------------------------------------------------------------

  handleInput(playerId: string, input: PlayerInput): void {
    this.sim.setInput(playerId, input);
  }

  setReady(playerId: string, ready: boolean): boolean {
    const changed = this.sim.setReady(playerId, ready);
    if (changed) this.broadcastRoom();
    return changed;
  }

  isHost(playerId: string): boolean {
    return this.sim.isHostCandidate()?.id === playerId;
  }

  /**
   * Host-only start. A solo host launches immediately against bots rather than
   * being told to invite someone; with two or more humans it starts as usual.
   */
  requestStart(playerId: string): { ok: boolean; error?: string } {
    if (this.sim.phase !== 'lobby') return { ok: false, error: 'wrong-phase' };
    if (!this.isHost(playerId)) return { ok: false, error: 'not-host' };
    if (this.sim.humanCount < MIN_PLAYERS) this.fillWithBots();
    if (this.sim.connectedCount < MIN_PLAYERS) return { ok: false, error: 'not-enough-players' };
    if (!this.sim.startMatch()) return { ok: false, error: 'not-enough-players' };
    this.matchmakingSince = null;
    this.log.info('match started', {
      matchIndex: this.sim.matchIndex,
      humans: this.sim.humanCount,
      bots: this.sim.botCount,
    });
    this.broadcastRoom();
    return { ok: true };
  }

  /** Host-only rematch from the results screen. */
  requestRematch(playerId: string): { ok: boolean; error?: string } {
    if (this.sim.phase !== 'results') return { ok: false, error: 'wrong-phase' };
    if (!this.isHost(playerId)) return { ok: false, error: 'not-host' };
    // Keep a bot-filled arena populated if every bot somehow left.
    if (this.sim.connectedCount < MIN_PLAYERS) this.fillWithBots();
    if (!this.sim.startMatch()) return { ok: false, error: 'not-enough-players' };
    this.log.info('rematch started', {
      matchIndex: this.sim.matchIndex,
      humans: this.sim.humanCount,
      bots: this.sim.botCount,
    });
    this.broadcastRoom();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Matchmaking
  // -------------------------------------------------------------------------

  /**
   * Nobody should ever stare at an empty lobby. While exactly one human is
   * waiting, a countdown runs; when it expires the server tops the arena up
   * with ultra-tier bots and starts the match itself. A second human arriving
   * cancels the countdown, so friends always get to play together.
   */
  private updateMatchmaking(now: number): void {
    if (this.botFillDelayMs <= 0 || this.sim.phase !== 'lobby') {
      this.matchmakingSince = null;
      return;
    }

    if (this.sim.humanCount >= MIN_PLAYERS) {
      if (this.matchmakingSince !== null) {
        this.matchmakingSince = null;
        this.log.info('matchmaking cancelled — human opponent joined', {
          humans: this.sim.humanCount,
        });
        this.broadcastRoom();
      }
      return;
    }

    if (this.sim.humanCount === 0) return;

    if (this.matchmakingSince === null) {
      this.matchmakingSince = now;
      this.log.info('matchmaking started', { botFillDelayMs: this.botFillDelayMs });
      this.broadcastRoom();
      return;
    }

    if (now - this.matchmakingSince < this.botFillDelayMs) return;

    this.matchmakingSince = null;
    const added = this.fillWithBots();
    if (this.sim.startMatch()) {
      this.log.info('match started against bots', { bots: added, humans: this.sim.humanCount });
    }
    this.broadcastRoom();
  }

  /** Milliseconds left on the matchmaking countdown, 0 when not waiting. */
  private matchmakingRemainingMs(now: number): number {
    if (this.botFillDelayMs <= 0 || this.matchmakingSince === null) return 0;
    return Math.max(0, this.botFillDelayMs - (now - this.matchmakingSince));
  }

  /** Top the arena up to `MATCHMAKING.fillToPlayers` with bots. */
  private fillWithBots(): number {
    const target = Math.min(this.sim.maxPlayers, MATCHMAKING.fillToPlayers);
    let added = 0;
    while (this.sim.connectedCount < target && added < MAX_BOTS_PER_FILL) {
      this.sim.addBot();
      added += 1;
    }
    return added;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  tick(): void {
    if (this.hasSockets) this.emptySince = null;

    this.updateMatchmaking(Date.now());

    const phaseBefore = this.sim.phase;
    this.sim.tickOnce();

    if (this.sim.shouldBroadcast()) {
      this.broadcast({ t: 'snapshot', snapshot: this.sim.buildSnapshot() });
    }

    if (this.sim.phase !== phaseBefore) {
      this.log.info('phase change', { from: phaseBefore, to: this.sim.phase });
      this.broadcastRoom();
    }

    if (this.sim.phase === 'results' && this.sim.results) {
      if (this.resultsBroadcastFor !== this.sim.matchIndex) {
        this.resultsBroadcastFor = this.sim.matchIndex;
        this.broadcast({ t: 'results', results: this.sim.results });
      }
    }

    this.sweepDisconnects();
  }

  /** Drop fighters whose reconnect window elapsed. */
  private sweepDisconnects(): void {
    const expired = this.sim.expiredDisconnects(RECONNECT_WINDOW_MS);
    for (const player of expired) {
      this.forgetTokens(player.id);
      this.sim.removePlayer(player.id);
      this.log.info('reconnect window expired', { playerId: player.id });
      this.broadcastRoom();
    }
  }

  /** True when the room may be destroyed (abandoned long enough, or old results). */
  shouldBeDestroyed(now: number, emptyTtlMs: number): boolean {
    if (this.hasSockets) return false;
    if (this.emptySince === null) {
      this.emptySince = now;
      return false;
    }
    if (this.finishedAt !== null) return now - this.finishedAt > RESULTS_LINGER_MS;
    return now - this.emptySince > emptyTtlMs;
  }

  describe(): string {
    return `${this.code} [${this.sim.phase}] players=${this.sim.players.length} tick=${this.sim.tick}`;
  }
}
