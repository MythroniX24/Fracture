/**
 * Shared domain + wire types.
 *
 * These types are used by the authoritative server, the client renderer and
 * the test-suite. Wire messages are plain JSON objects (see `protocol.ts`,
 * which validates and clamps every inbound field).
 */
import type { Vec3 } from './math.js';

// ---------------------------------------------------------------------------
// Arenas and platforms
// ---------------------------------------------------------------------------

export type PlatformKind = 'safe' | 'destructible' | 'static';

/**
 * `INTACT → CRACKED → CRITICAL → COLLAPSING → DESTROYED`
 *
 * `static` decor (ruins, pillars) reports `INTACT` forever and can never be
 * targeted by Platform Break.
 */
export type PlatformState = 'INTACT' | 'CRACKED' | 'CRITICAL' | 'COLLAPSING' | 'DESTROYED';

export interface PlatformDef {
  id: string;
  kind: PlatformKind;
  label: string;
  /** Box centre in world space. */
  center: Vec3;
  /** Full extents: x = width, y = height, z = depth. */
  size: Vec3;
  /** Starting durability; 0 for non-destructible platforms. */
  durability: number;
  /** Whether the platform can be used as a spawn point. */
  spawn?: boolean;
}

export interface PlatformRuntime extends PlatformDef {
  maxDurability: number;
  state: PlatformState;
  /** Simulation tick at which the collapse started, or null. */
  collapseStartedTick: number | null;
  /** Simulation tick at which the platform became/becomes destroyed. */
  destroyedTick: number | null;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export type AbilityId = 'punch' | 'gravity' | 'shockwave' | 'platformBreak';

export type AnimationState =
  | 'idle'
  | 'move'
  | 'jump'
  | 'fall'
  | 'punch'
  | 'hit'
  | 'dodge'
  | 'down';

export interface PlayerInput {
  /** Monotonic input sequence number from the client. */
  seq: number;
  /** Movement intent in the range [-1, 1]. */
  moveX: number;
  moveZ: number;
  /** Aim angles in radians. */
  yaw: number;
  pitch: number;
  /** Held buttons. */
  jump: boolean;
  dodge: boolean;
  /** Edge-triggered by the server (one activation per press). */
  punch: boolean;
  gravity: boolean;
  shockwave: boolean;
  breakPlatform: boolean;
}

export function emptyInput(seq = 0): PlayerInput {
  return {
    seq,
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    dodge: false,
    punch: false,
    gravity: false,
    shockwave: false,
    breakPlatform: false,
  };
}

export interface AbilityCooldowns {
  punch: number;
  gravity: number;
  shockwave: number;
  platformBreak: number;
}

export interface PlayerState {
  id: string;
  name: string;
  /** Stable slot index (0-3) used for colours and deterministic ordering. */
  slot: number;
  /** Hex colour of this player's fighter accents. */
  color: number;

  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;

  health: number;
  energy: number;
  alive: boolean;

  score: number;
  eliminations: number;
  falls: number;
  deaths: number;

  /** Absolute simulation times in milliseconds. */
  cooldowns: AbilityCooldowns;
  /** Remaining Platform Break charges for the current life. */
  breakCharges: number;
  spawnProtectionUntil: number;
  respawnAtTick: number | null;
  invulnerable: boolean;
  dodgeUntil: number;
  dodgeCooldownUntil: number;
  dodgeDir: Vec3;
  /** Absolute time until which a buffered jump press stays valid. */
  jumpBufferUntil: number;
  /** Absolute time of the last grounded frame (drives coyote time). */
  lastGroundedAt: number;
  /** Consecutive jumps since last touching ground (limits air jumps). */
  jumpCount: number;
  /** True once the current jump's upward velocity has been cut on release. */
  jumpCutDone: boolean;

  /** Last player who dealt valid damage, plus when (ms). */
  lastAttackerId: string | null;
  lastAttackerAt: number;

  /** Client-side presentation hints (server-authoritative). */
  anim: AnimationState;
  /** Tick at which the current animation hint started. */
  animTick: number;
  /** Tick of the last time this player took damage (for hit flash). */
  lastHitTick: number | null;

  /** Lobby flags. */
  ready: boolean;
  connected: boolean;
  /**
   * True for server-controlled fighters. Bots are ordinary players in every
   * other respect: they own a slot, a colour, a score and can never be a host.
   */
  isBot: boolean;
  /** Simulation time at which the player disconnected (ms), or null. */
  disconnectedAt: number | null;
}

export interface Projectile {
  id: string;
  ownerId: string;
  /** Colour of the owning player's fighter. */
  color: number;
  position: Vec3;
  velocity: Vec3;
  /** Ticks the projectile has existed. */
  ageTick: number;
  lifetimeTicks: number;
  distanceTravelled: number;
  radius: number;
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export type MatchPhase = 'lobby' | 'countdown' | 'combat' | 'results';

export type GameEventType =
  | 'hit'
  | 'elimination'
  | 'respawn'
  | 'ability'
  | 'ability-denied'
  | 'platform'
  | 'phase'
  | 'match-end';

export interface GameEvent {
  type: GameEventType;
  /** Simulation tick at which the event happened. */
  tick: number;
  /** Acting player. */
  sourceId?: string;
  /** Affected player. */
  targetId?: string;
  /** Damage dealt / durability removed. */
  amount?: number;
  /** For `elimination`: 'damage' | 'fall'. */
  cause?: string;
  /** Machine-readable detail (ability id, platform id, denial reason...). */
  detail?: string;
  /** Platform involved in the event. */
  platformId?: string;
  /** World position to anchor a visual effect. */
  position?: Vec3;
}

export interface ScoreEntry {
  playerId: string;
  name: string;
  color: number;
  score: number;
  eliminations: number;
  falls: number;
  deaths: number;
  /** 1-based rank; equal scores share a rank. */
  rank: number;
}

export interface MatchResults {
  finishedAt: number;
  durationMs: number;
  scores: ScoreEntry[];
  /** Player ids that share rank 1 (more than one on a tie). */
  winners: string[];
  /** True when several players share rank 1. */
  tie: boolean;
}

// ---------------------------------------------------------------------------
// Lobby / room
// ---------------------------------------------------------------------------

export interface RoomPlayerSummary {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  host: boolean;
  bot: boolean;
  slot: number;
}

export interface RoomSummary {
  code: string;
  phase: MatchPhase;
  hostId: string | null;
  players: RoomPlayerSummary[];
  maxPlayers: number;
  /** Milliseconds until the match starts during the countdown phase. */
  countdownRemainingMs: number;
  /** Milliseconds left in the match during combat. */
  matchRemainingMs: number;
  /**
   * Milliseconds until bots fill the arena and the match starts on its own.
   * 0 when nobody is waiting (two or more humans are already connected).
   */
  matchmakingRemainingMs: number;
  /** Connected human fighters (bots excluded). */
  humans: number;
  /** Server tick of the current match. */
  tick: number;
}

// ---------------------------------------------------------------------------
// Snapshots (server -> client)
// ---------------------------------------------------------------------------

export interface PlayerSnapshot {
  id: string;
  slot: number;
  color: number;
  name: string;
  p: [number, number, number];
  v: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
  en: number;
  alive: boolean;
  grounded: boolean;
  score: number;
  kills: number;
  falls: number;
  deaths: number;
  /** Absolute ms timestamps relevant to the HUD (cooldowns etc.). */
  cd: [number, number, number, number];
  charges: number;
  prot: boolean;
  shieldMs: number;
  respawnInMs: number;
  anim: AnimationState;
  animTick: number;
  hitTick: number | null;
  connected: boolean;
  /** True when the server controls this fighter (matchmaking bot). */
  bot: boolean;
}

export interface PlatformSnapshot {
  id: string;
  state: PlatformState;
  durability: number;
  maxDurability: number;
  /** True while the platform still blocks movement / supports players. */
  solid: boolean;
  /** Milliseconds remaining in the collapse animation, 0 when not collapsing. */
  collapseMs: number;
}

export interface ProjectileSnapshot {
  id: string;
  ownerId: string;
  color: number;
  p: [number, number, number];
}

export interface Snapshot {
  /** Server tick this snapshot describes. */
  tick: number;
  /** Simulation time of the snapshot (ms). */
  time: number;
  phase: MatchPhase;
  matchRemainingMs: number;
  countdownRemainingMs: number;
  players: PlayerSnapshot[];
  platforms: PlatformSnapshot[];
  projectiles: ProjectileSnapshot[];
  events: GameEvent[];
}

// ---------------------------------------------------------------------------
// Network protocol
// ---------------------------------------------------------------------------

export interface ClientCreateMessage {
  t: 'create';
  name: string;
  /** Reconnect token for reclaiming a slot after a drop. */
  token?: string;
  /** Client build identifier, for diagnostics only. */
  version?: string;
}

export interface ClientJoinMessage {
  t: 'join';
  name: string;
  /** Private room code, always normalised to upper case. */
  code: string;
  token?: string;
}

export interface ClientReadyMessage {
  t: 'ready';
  ready: boolean;
}

export interface ClientStartMessage {
  t: 'start';
}

export interface ClientInputMessage {
  t: 'input';
  input: PlayerInput;
}

export interface ClientRematchMessage {
  t: 'rematch';
}

export interface ClientLeaveMessage {
  t: 'leave';
}

export interface ClientPingMessage {
  t: 'ping';
  /** Client clock, echoed back in `pong`. */
  ts: number;
}

export type ClientMessage =
  | ClientCreateMessage
  | ClientJoinMessage
  | ClientReadyMessage
  | ClientStartMessage
  | ClientInputMessage
  | ClientRematchMessage
  | ClientLeaveMessage
  | ClientPingMessage;

export interface ServerJoinedMessage {
  t: 'joined';
  playerId: string;
  code: string;
  /** Store this and send it back on `join` to reclaim the slot. */
  token: string;
  room: RoomSummary;
}

export type ErrorCode =
  | 'bad-message'
  | 'rate-limited'
  | 'room-not-found'
  | 'room-full'
  | 'name-invalid'
  | 'already-in-room'
  | 'not-in-room'
  | 'not-host'
  | 'not-enough-players'
  | 'wrong-phase'
  | 'match-in-progress'
  | 'server-error';

export interface ServerErrorMessage {
  t: 'error';
  code: ErrorCode;
  message: string;
}

export interface ServerRoomMessage {
  t: 'room';
  room: RoomSummary;
}

export interface ServerSnapshotMessage {
  t: 'snapshot';
  snapshot: Snapshot;
}

export interface ServerResultsMessage {
  t: 'results';
  results: MatchResults;
}

export interface ServerLeftMessage {
  t: 'left';
  reason: string;
}

export interface ServerPongMessage {
  t: 'pong';
  ts: number;
  serverTime: number;
}

export type ServerMessage =
  | ServerJoinedMessage
  | ServerErrorMessage
  | ServerRoomMessage
  | ServerSnapshotMessage
  | ServerResultsMessage
  | ServerLeftMessage
  | ServerPongMessage;
