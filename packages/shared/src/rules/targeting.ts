/**
 * Server-side targeting rules.
 *
 * Every function here is pure and takes the *current* simulation state; the
 * server never trusts a client-reported hit. All distances are in metres.
 */
import { PLAYER, PLATFORM_BREAK, PUNCH, SHOCKWAVE } from '../config.js';
import {
  addScaled,
  distance,
  dot,
  flatDirFromYaw,
  len,
  normalize,
  rayAabb,
  sub,
  v3,
  type Vec3,
} from '../math.js';
import type { PlatformRuntime, PlayerState } from '../types.js';
import { isBreakable, isSolid } from './platforms.js';

/** Centre-of-mass of a player's collision cylinder. */
export function playerCenter(player: PlayerState): Vec3 {
  return v3(player.position.x, player.position.y + PLAYER.height / 2, player.position.z);
}

/** Eye/aim origin of a player. */
export function playerEye(player: PlayerState): Vec3 {
  return v3(player.position.x, player.position.y + PLAYER.eyeHeight, player.position.z);
}

/** True when the segment is blocked by any solid platform. */
export function segmentBlocked(a: Vec3, b: Vec3, solids: PlatformRuntime[]): boolean {
  const dir = sub(b, a);
  const distanceToTarget = len(dir);
  if (distanceToTarget < 1e-6) return false;
  for (const platform of solids) {
    if (rayAabb(a, dir, platform, distanceToTarget)) return true;
  }
  return false;
}

/**
 * Punch targeting: the nearest enemy inside the reach sphere, inside the aiming
 * cone, and visible (no platform blocking line of sight).
 * Returns at most `PUNCH.maxTargets` targets.
 */
export function findPunchTargets(
  origin: Vec3,
  dir: Vec3,
  attackerId: string,
  players: PlayerState[],
  solids: PlatformRuntime[],
  protectThreshold: (player: PlayerState) => boolean,
): PlayerState[] {
  let best: PlayerState | null = null;
  let bestDistance = Infinity;

  for (const candidate of players) {
    if (candidate.id === attackerId) continue;
    if (!candidate.alive || protectThreshold(candidate)) continue;

    const center = playerCenter(candidate);
    const toTarget = sub(center, origin);
    const dist = len(toTarget);
    if (dist > PUNCH.range) continue;
    if (dist > 1e-6 && dot(normalize(toTarget), dir) < PUNCH.coneCos) continue;
    // Horizontal reach as well, so a punch cannot hit a target far above/below.
    const horizontal = Math.hypot(toTarget.x, toTarget.z);
    if (horizontal > PUNCH.range) continue;
    if (segmentBlocked(origin, center, solids)) continue;

    if (dist < bestDistance) {
      bestDistance = dist;
      best = candidate;
    }
  }

  return best ? [best] : [];
}

/** Shockwave targeting: horizontal radius plus a vertical tolerance band. */
export function findShockwaveTargets(
  attacker: PlayerState,
  players: PlayerState[],
  protectThreshold: (player: PlayerState) => boolean,
): PlayerState[] {
  const results: PlayerState[] = [];
  for (const candidate of players) {
    if (candidate.id === attacker.id) continue;
    if (!candidate.alive || protectThreshold(candidate)) continue;
    const dy = Math.abs(candidate.position.y - attacker.position.y);
    if (dy > SHOCKWAVE.verticalTolerance) continue;
    const horizontal = Math.hypot(
      candidate.position.x - attacker.position.x,
      candidate.position.z - attacker.position.z,
    );
    if (horizontal > SHOCKWAVE.radius) continue;
    results.push(candidate);
    if (results.length >= SHOCKWAVE.maxTargets) break;
  }
  return results;
}

/**
 * Platform Break targeting: the first destructible platform under the aim ray
 * within `PLATFORM_BREAK.range`. Safe and already-collapsing platforms are
 * ignored, and non-destructible decor is never returned.
 */
export function findBreakTarget(
  origin: Vec3,
  dir: Vec3,
  platforms: PlatformRuntime[],
): PlatformRuntime | null {
  let best: PlatformRuntime | null = null;
  let bestT = Infinity;
  for (const platform of platforms) {
    if (!isBreakable(platform)) continue;
    const hit = rayAabb(origin, dir, platform, PLATFORM_BREAK.range);
    if (!hit) continue;
    if (hit.t < bestT) {
      bestT = hit.t;
      best = platform;
    }
  }
  return best;
}

/** Radial outward knockback direction (flattened), falling back to `facing`. */
export function outwardDirection(from: Vec3, to: Vec3, facing: Vec3): Vec3 {
  const delta = { x: to.x - from.x, y: 0, z: to.z - from.z };
  if (Math.hypot(delta.x, delta.z) < 1e-4) {
    return normalize({ x: facing.x, y: 0, z: facing.z });
  }
  return normalize(delta);
}

/** Horizontal direction from `from` toward `to` (used for punch knockback). */
export function pushDirection(from: Vec3, to: Vec3, fallbackYaw: number): Vec3 {
  const delta = sub(to, from);
  const flat = { x: delta.x, y: 0, z: delta.z };
  if (Math.hypot(flat.x, flat.z) < 1e-4) return flatDirFromYaw(fallbackYaw);
  return normalize(flat);
}

/**
 * Sweep a sphere along a segment and return the nearest player hit.
 * Skips the owner, dead players and spawn-protected players.
 */
export function sweepProjectileForPlayer(
  from: Vec3,
  to: Vec3,
  radius: number,
  ownerId: string,
  players: PlayerState[],
  protectThreshold: (player: PlayerState) => boolean,
): PlayerState | null {
  const segment = sub(to, from);
  const segmentLength = len(segment);
  let best: PlayerState | null = null;
  let bestT = Infinity;

  for (const candidate of players) {
    if (candidate.id === ownerId) continue;
    if (!candidate.alive || protectThreshold(candidate)) continue;
    const t = closestApproachOnSegment(from, segment, segmentLength, candidate, radius);
    if (t === null) continue;
    if (t < bestT) {
      bestT = t;
      best = candidate;
    }
  }
  return best;
}

/** Returns the normalized hit parameter along the segment, or null. */
function closestApproachOnSegment(
  from: Vec3,
  segment: Vec3,
  segmentLength: number,
  target: PlayerState,
  radius: number,
): number | null {
  if (segmentLength < 1e-6) return null;
  // Closest point between the projectile segment and the target's vertical axis.
  const axisTop = target.position.y + PLAYER.height;
  const axisBottom = target.position.y;
  // Sample the target axis at a few heights: cheap and robust for a 0.42 m sphere.
  for (let i = 0; i <= 4; i += 1) {
    const y = axisBottom + ((axisTop - axisBottom) * i) / 4;
    const spherePos = { x: target.position.x, y, z: target.position.z };
    const toCenter = sub(spherePos, from);
    const t = clamp01(dot(toCenter, segment) / (segmentLength * segmentLength));
    const closest = addScaled(from, segment, t);
    if (distance(closest, spherePos) <= radius + PLAYER.radius) return t;
  }
  return null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
