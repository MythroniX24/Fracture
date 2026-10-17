/**
 * Player state creation, colour assignment and match/respawn resets.
 */
import { PLATFORM_BREAK, PLAYER } from '../config.js';
import { v3, type Vec3 } from '../math.js';
import type { PlayerState } from '../types.js';
import { ARENA, spawnPointForSlot, type ArenaDef } from '../arena.js';

/**
 * Fighter accent colours: oxidised metals that read against sandstone and grey
 * rock without breaking the "ancient ruins" palette.
 */
export const PLAYER_COLORS = [0xd4622f, 0x2f7fd9, 0x3fae6a, 0xc9a227, 0x9b59b6, 0xe0e0e0] as const;

export function colorForSlot(slot: number): number {
  return PLAYER_COLORS[slot % PLAYER_COLORS.length]!;
}

export interface CreatePlayerOptions {
  id: string;
  name: string;
  slot: number;
  color?: number;
  arena?: ArenaDef;
  /** True when the server drives this fighter (matchmaking bot). */
  isBot?: boolean;
}

export function createPlayerState(options: CreatePlayerOptions): PlayerState {
  const arena = options.arena ?? ARENA;
  const spawn = spawnPointForSlot(arena, options.slot);
  return {
    id: options.id,
    name: options.name,
    slot: options.slot,
    color: options.color ?? colorForSlot(options.slot),

    position: { ...spawn.position },
    velocity: v3(0, 0, 0),
    yaw: spawn.yaw,
    pitch: 0,
    grounded: true,

    health: PLAYER.maxHealth,
    energy: PLAYER.maxEnergy,
    alive: true,

    score: 0,
    eliminations: 0,
    falls: 0,
    deaths: 0,

    cooldowns: { punch: 0, gravity: 0, shockwave: 0, platformBreak: 0 },
    breakCharges: PLATFORM_BREAK.charges,
    spawnProtectionUntil: 0,
    respawnAtTick: null,
    invulnerable: false,
    dodgeUntil: 0,
    dodgeCooldownUntil: 0,
    dodgeDir: v3(0, 0, 1),
    jumpBufferUntil: 0,
    lastGroundedAt: -Infinity,
    jumpCount: 0,
    jumpCutDone: true,

    lastAttackerId: null,
    lastAttackerAt: -Infinity,

    anim: 'idle',
    animTick: 0,
    lastHitTick: null,

    ready: false,
    connected: true,
    isBot: options.isBot ?? false,
    disconnectedAt: null,
  };
}

export function resetCooldowns(player: PlayerState): void {
  player.cooldowns.punch = 0;
  player.cooldowns.gravity = 0;
  player.cooldowns.shockwave = 0;
  player.cooldowns.platformBreak = 0;
}

export function placeAtSpawn(player: PlayerState, position: Vec3, yaw: number): void {
  player.position = { ...position };
  player.velocity = v3(0, 0, 0);
  player.yaw = yaw;
  player.pitch = 0;
  player.grounded = true;
  player.dodgeUntil = 0;
  player.dodgeCooldownUntil = 0;
  player.dodgeDir = v3(0, 0, 1);
  player.jumpBufferUntil = 0;
  player.lastGroundedAt = -Infinity;
  player.jumpCount = 0;
  player.jumpCutDone = true;
}

/** Full reset used when a match starts or a rematch begins. */
export function resetPlayerForMatch(player: PlayerState, arena: ArenaDef, tick: number): void {
  const spawn = spawnPointForSlot(arena, player.slot);
  placeAtSpawn(player, spawn.position, spawn.yaw);
  player.health = PLAYER.maxHealth;
  player.energy = PLAYER.maxEnergy;
  player.alive = true;
  player.score = 0;
  player.eliminations = 0;
  player.falls = 0;
  player.deaths = 0;
  player.breakCharges = PLATFORM_BREAK.charges;
  resetCooldowns(player);
  player.spawnProtectionUntil = 0;
  player.respawnAtTick = null;
  player.invulnerable = false;
  player.lastAttackerId = null;
  player.lastAttackerAt = -Infinity;
  player.anim = 'idle';
  player.animTick = tick;
  player.lastHitTick = null;
}

/** Reset a player for a fresh life without touching their score. */
export function revivePlayer(
  player: PlayerState,
  position: Vec3,
  yaw: number,
  protectionUntil: number,
  now: number,
  tick: number,
): void {
  placeAtSpawn(player, position, yaw);
  player.health = PLAYER.maxHealth;
  player.energy = PLAYER.maxEnergy;
  player.alive = true;
  player.breakCharges = PLATFORM_BREAK.charges;
  resetCooldowns(player);
  player.spawnProtectionUntil = protectionUntil;
  player.respawnAtTick = null;
  player.invulnerable = protectionUntil > now;
  player.lastAttackerId = null;
  player.lastAttackerAt = -Infinity;
  player.anim = 'idle';
  player.animTick = tick;
  player.lastHitTick = null;
}
