import { COUNTDOWN_MS, MatchSim, PLAYER, TICK_MS, emptyInput } from '../src/index.js';
import type { PlayerInput, PlayerState } from '../src/index.js';

export const COUNTDOWN_TICKS = Math.ceil(COUNTDOWN_MS / TICK_MS);
/** Ticks needed for the initial spawn protection to expire after combat starts. */
export const PROTECTION_TICKS = Math.ceil(PLAYER.spawnProtectionMs / TICK_MS) + 1;

let seqCounter = 1;

/** Build an input frame with a fresh, strictly increasing sequence number. */
export function inputFrame(overrides: Partial<PlayerInput> = {}): PlayerInput {
  seqCounter += 1;
  return { ...emptyInput(seqCounter), ...overrides };
}

export function resetSeq(): void {
  seqCounter = 1;
}

/**
 * Create a match with `count` players, run through the countdown into combat
 * and wait out the initial 1.5 s spawn protection so damage tests start from a
 * clean, unprotected state.
 */
export function startCombat(count = 2): MatchSim {
  const sim = new MatchSim();
  for (let i = 0; i < count; i += 1) sim.addPlayer(`p${i + 1}`, `P${i + 1}`);
  sim.startMatch();
  for (let i = 0; i < COUNTDOWN_TICKS + PROTECTION_TICKS; i += 1) sim.tickOnce();
  return sim;
}

export function advance(sim: MatchSim, ticks: number, onTick?: (tick: number) => void): void {
  for (let i = 0; i < ticks; i += 1) {
    onTick?.(sim.tick);
    sim.tickOnce();
  }
}

/** Teleport a player, clearing velocity so the next tick starts clean. */
export function place(player: PlayerState, x: number, y: number, z: number, yaw = 0): void {
  player.position.x = x;
  player.position.y = y;
  player.position.z = z;
  player.velocity.x = 0;
  player.velocity.y = 0;
  player.velocity.z = 0;
  player.yaw = yaw;
  player.pitch = 0;
  player.grounded = true;
}

export function player(sim: MatchSim, id: string): PlayerState {
  const found = sim.getPlayer(id);
  if (!found) throw new Error(`missing player ${id}`);
  return found;
}

/** Absolute simulation time in ms at the sim's current tick. */
export function nowMs(sim: MatchSim): number {
  return sim.tick * TICK_MS;
}
