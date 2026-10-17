/**
 * Platform durability and collapse rules.
 *
 * State machine: `INTACT → CRACKED → CRITICAL → COLLAPSING → DESTROYED`.
 *
 * Collision is removed at the COLLAPSING → DESTROYED transition (explicit and
 * testable): while collapsing the platform still supports players so they have
 * the full warning window to jump away.
 */
import { PLATFORM } from '../config.js';
import type { PlatformRuntime, PlatformState } from '../types.js';

/** Stage derived from remaining durability. Never returns the transient states. */
export function platformStateFor(durability: number, maxDurability: number): PlatformState {
  if (maxDurability <= 0) return 'INTACT';
  if (durability <= 0) return 'DESTROYED';
  const ratio = durability / maxDurability;
  if (ratio > PLATFORM.crackedRatio) return 'INTACT';
  if (ratio > PLATFORM.criticalRatio) return 'CRACKED';
  return 'CRITICAL';
}

/** Whether the platform can be targeted by Platform Break. */
export function isBreakable(platform: PlatformRuntime): boolean {
  return (
    platform.kind === 'destructible' &&
    platform.destroyedTick === null &&
    platform.state !== 'DESTROYED' &&
    platform.state !== 'COLLAPSING'
  );
}

/** Whether the platform currently blocks movement / supports players. */
export function isSolid(platform: PlatformRuntime): boolean {
  return platform.state !== 'DESTROYED';
}

export interface PlatformDamageResult {
  /** True when any durability was removed. */
  applied: boolean;
  /** True when this hit started the collapse (exactly once per platform). */
  startedCollapse: boolean;
  /** State before -> state after (ignoring the collapse overlay). */
  previousState: PlatformState;
  nextState: PlatformState;
}

/**
 * Apply structural damage. Idempotent for already-collapsing/destroyed
 * platforms, so repeated or simultaneous break attempts cannot double-collapse.
 */
export function damagePlatform(
  platform: PlatformRuntime,
  amount: number,
  tick: number,
): PlatformDamageResult {
  const previousState = platform.state;
  if (!isBreakable(platform) || amount <= 0) {
    return { applied: false, startedCollapse: false, previousState, nextState: previousState };
  }

  platform.durability = Math.max(0, platform.durability - amount);
  const derived = platformStateFor(platform.durability, platform.maxDurability);

  if (platform.durability <= 0) {
    platform.state = 'COLLAPSING';
    platform.collapseStartedTick = tick;
    return { applied: true, startedCollapse: true, previousState, nextState: 'COLLAPSING' };
  }

  platform.state = derived;
  return { applied: true, startedCollapse: false, previousState, nextState: derived };
}

/**
 * Advance a collapsing platform. Returns true only on the tick it finishes, so
 * a single authoritative `platform destroyed` event is emitted per platform.
 */
export function advancePlatform(platform: PlatformRuntime, tick: number, tickMs: number): boolean {
  if (platform.state !== 'COLLAPSING' || platform.collapseStartedTick === null) return false;
  const elapsed = (tick - platform.collapseStartedTick) * tickMs;
  if (elapsed < PLATFORM.collapseDurationMs) return false;
  platform.state = 'DESTROYED';
  platform.destroyedTick = tick;
  return true;
}

/** Milliseconds remaining in the collapse animation (0 when not collapsing). */
export function collapseRemainingMs(platform: PlatformRuntime, tick: number, tickMs: number): number {
  if (platform.state !== 'COLLAPSING' || platform.collapseStartedTick === null) return 0;
  const elapsed = (tick - platform.collapseStartedTick) * tickMs;
  return Math.max(0, PLATFORM.collapseDurationMs - elapsed);
}

/** Reset a platform for a rematch. */
export function resetPlatform(platform: PlatformRuntime): void {
  platform.durability = platform.maxDurability;
  platform.state = 'INTACT';
  platform.collapseStartedTick = null;
  platform.destroyedTick = null;
}
