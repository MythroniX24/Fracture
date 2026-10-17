import { describe, expect, it } from 'vitest';
import {
  MATCH_DURATION_MS,
  MAX_PLAYERS,
  MatchSim,
  PLATFORM_BREAK,
  PLAYER,
  TICK_MS,
  damagePlatform,
} from '../src/index.js';
import {
  COUNTDOWN_TICKS,
  PROTECTION_TICKS,
  advance,
  inputFrame,
  place,
  player,
  startCombat,
} from './helpers.js';
import { emptyInput, type PlayerInput } from '../src/index.js';

/**
 * Deterministic input pattern: sequence numbers grow strictly so no frame is
 * rejected as a duplicate replay.
 */
const PATTERN: Array<Partial<PlayerInput>> = [
  { moveZ: 1, yaw: 0.3 },
  { moveZ: 1, punch: true, yaw: 0.3 },
  { moveZ: -1, moveX: 1, jump: true },
  { moveX: -1, dodge: true },
  { gravity: true, yaw: -1.2, pitch: 0.2 },
  { shockwave: true },
  { breakPlatform: true, pitch: -0.5 },
  {},
];

function patternFrame(tick: number, offset: number): PlayerInput {
  const base = PATTERN[(tick + offset) % PATTERN.length]!;
  return { ...emptyInput((tick + 1) * 16 + offset), ...base };
}

function makeMatch(count: number): MatchSim {
  const sim = new MatchSim();
  for (let i = 0; i < count; i += 1) sim.addPlayer(`p${i + 1}`, `P${i + 1}`);
  return sim;
}

function pinMany(entries: Array<[ReturnType<typeof player>, number, number, number]>) {
  return () => {
    for (const [target, x, y, z] of entries) place(target, x, y, z, 0);
  };
}

describe('match lifecycle', () => {
  it('cannot start without at least two connected players', () => {
    const sim = makeMatch(1);
    expect(sim.canStart()).toBe(false);
    expect(sim.startMatch()).toBe(false);
    sim.addPlayer('p2', 'P2');
    expect(sim.canStart()).toBe(true);
    expect(sim.startMatch()).toBe(true);
    expect(sim.phase).toBe('countdown');
  });

  it('accepts at most four players', () => {
    const sim = makeMatch(MAX_PLAYERS);
    expect(sim.full).toBe(true);
    expect(sim.players).toHaveLength(MAX_PLAYERS);
  });

  it('runs countdown, combat and results with a 5 minute clock', () => {
    const sim = startCombat(2);
    expect(sim.phase).toBe('combat');
    expect(sim.matchRemainingMs).toBeGreaterThan(0);
    expect(sim.matchRemainingMs).toBeLessThanOrEqual(MATCH_DURATION_MS);

    const ticksToEnd = Math.ceil(sim.matchRemainingMs / TICK_MS) + 2;
    advance(sim, ticksToEnd);

    expect(sim.phase).toBe('results');
    expect(sim.results).not.toBeNull();
    expect(sim.results!.durationMs).toBe(300_000);
    expect(sim.results!.scores).toHaveLength(2);
  });

  it('freezes players during the countdown and the results screen', () => {
    const sim = makeMatch(2);
    sim.startMatch();
    const one = player(sim, 'p1');
    const startZ = one.position.z;
    advance(sim, 10, () => sim.setInput('p1', inputFrame({ moveZ: 1 })));
    expect(one.position.z).toBe(startZ);

    // Fast-forward into the results phase and confirm movement is still locked.
    advance(sim, Math.ceil(MATCH_DURATION_MS / TICK_MS) + COUNTDOWN_TICKS + PROTECTION_TICKS + 5);
    expect(sim.phase).toBe('results');
    const frozenZ = one.position.z;
    advance(sim, 10, () => sim.setInput('p1', inputFrame({ moveZ: 1, jump: true })));
    expect(one.position.z).toBe(frozenZ);
  });

  it('resets arena and scores on rematch', () => {
    const sim = startCombat(2);
    const crumble = sim.platforms.find((p) => p.id === 'north-bridge')!;
    damagePlatform(crumble, 60, sim.tick);
    const one = player(sim, 'p1');
    one.score = 3;

    advance(sim, Math.ceil(sim.matchRemainingMs / TICK_MS) + 2);
    expect(sim.phase).toBe('results');

    expect(sim.startMatch()).toBe(true);
    expect(sim.phase).toBe('countdown');
    expect(sim.platforms.find((p) => p.id === 'north-bridge')!.durability).toBe(60);
    expect(one.score).toBe(0);
    expect(one.breakCharges).toBe(PLATFORM_BREAK.charges);
  });
});

describe('falls and scoring', () => {
  it('eliminates a player below the kill plane and awards nothing without an attacker', () => {
    const sim = startCombat(2);
    const attacker = player(sim, 'p1');
    const victim = player(sim, 'p2');
    place(victim, 0, -30, 0);

    sim.tickOnce();

    expect(victim.alive).toBe(false);
    expect(victim.falls).toBe(1);
    expect(victim.deaths).toBe(1);
    expect(attacker.score).toBe(0);
    expect(sim.events.some((e) => e.type === 'elimination' && e.cause === 'fall')).toBe(true);
  });

  it('credits the last damaging attacker for a fall inside the window', () => {
    const sim = startCombat(2);
    const attacker = player(sim, 'p1');
    const victim = player(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 5, pinMany([[victim, 0, 0, -1.5]]));
    expect(victim.health).toBe(PLAYER.maxHealth - 15);
    expect(victim.lastAttackerId).toBe('p1');

    place(victim, 0, -30, 0);
    sim.tickOnce();

    expect(victim.alive).toBe(false);
    expect(attacker.score).toBe(1);
    expect(attacker.eliminations).toBe(1);
  });

  it('does not credit an attacker whose window expired', () => {
    const sim = startCombat(2);
    const attacker = player(sim, 'p1');
    const victim = player(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 5, pinMany([[victim, 0, 0, -1.5]]));
    victim.lastAttackerAt = sim.now - 6000;

    place(victim, 0, -30, 0);
    sim.tickOnce();

    expect(victim.alive).toBe(false);
    expect(attacker.score).toBe(0);
  });

  it('never awards a point to the eliminated player themselves', () => {
    const sim = startCombat(2);
    const victim = player(sim, 'p2');
    victim.lastAttackerId = victim.id;
    victim.lastAttackerAt = sim.now;

    place(victim, 0, -30, 0);
    sim.tickOnce();

    expect(victim.score).toBe(0);
    expect(victim.falls).toBe(1);
  });

  it('awards at most one point per elimination', () => {
    const sim = startCombat(2);
    const attacker = player(sim, 'p1');
    const victim = player(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 5, pinMany([[victim, 0, 0, -1.5]]));
    place(victim, 0, -30, 0);
    advance(sim, 10);

    expect(victim.deaths).toBe(1);
    expect(attacker.score).toBe(1);
  });
});

describe('respawn and spawn protection', () => {
  it('respawns after 3 seconds with 1.5 seconds of protection', () => {
    const sim = startCombat(2);
    const victim = player(sim, 'p2');
    place(victim, 0, -30, 0);
    sim.tickOnce();
    expect(victim.alive).toBe(false);

    const respawnTicks = Math.ceil(PLAYER.respawnDelayMs / TICK_MS);
    advance(sim, respawnTicks - 1);
    expect(victim.alive).toBe(false);

    advance(sim, 1);
    expect(victim.alive).toBe(true);
    expect(victim.health).toBe(PLAYER.maxHealth);
    expect(victim.energy).toBe(PLAYER.maxEnergy);
    expect(victim.breakCharges).toBe(PLATFORM_BREAK.charges);
    expect(victim.spawnProtectionUntil).toBeGreaterThan(sim.now);
    expect(sim.events.some((e) => e.type === 'respawn' && e.targetId === 'p2')).toBe(true);
  });

  it('blocks incoming damage while spawn protection is active', () => {
    const sim = startCombat(2);
    const attacker = player(sim, 'p1');
    const victim = player(sim, 'p2');
    place(victim, 0, -30, 0);
    sim.tickOnce();

    const respawnTicks = Math.ceil(PLAYER.respawnDelayMs / TICK_MS);
    advance(sim, respawnTicks + 1);
    expect(victim.alive).toBe(true);

    place(attacker, 0, 0, 0, 0);
    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 5, pinMany([[victim, 0, 0, -1.5]]));
    expect(victim.health).toBe(PLAYER.maxHealth);

    // Once protection expires the same punch lands.
    advance(sim, PROTECTION_TICKS + 2, pinMany([[attacker, 0, 0, 0], [victim, 0, 0, -1.5]]));
    sim.setInput('p1', inputFrame());
    advance(sim, 1, pinMany([[attacker, 0, 0, 0], [victim, 0, 0, -1.5]]));
    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 5, pinMany([[attacker, 0, 0, 0], [victim, 0, 0, -1.5]]));
    expect(victim.health).toBe(PLAYER.maxHealth - 15);
  });
});

describe('determinism', () => {
  it('produces identical state for identical input streams', () => {
    const run = (): string => {
      const sim = startCombat(3);
      for (let i = 0; i < 150; i += 1) {
        sim.setInput('p1', patternFrame(i, 0));
        sim.setInput('p2', patternFrame(i, 1));
        sim.setInput('p3', patternFrame(i, 2));
        sim.tickOnce();
      }
      return JSON.stringify(sim.buildSnapshot());
    };

    expect(run()).toBe(run());
  });

  it('rejects duplicate input sequence numbers', () => {
    const sim = startCombat(2);
    const frame = inputFrame({ moveZ: 1 });
    expect(sim.setInput('p1', frame)).toBe(true);
    expect(sim.setInput('p1', frame)).toBe(false);
    expect(sim.setInput('p1', { ...frame, seq: frame.seq + 1 })).toBe(true);
  });
});

/**
 * Cross-platform traversal. The causeway bridges sit 0.5 m below the terraces
 * and the centre platform, so getting anywhere in this arena depends on the
 * solver stepping *down* off an edge and *up* onto a low ledge. These tests pin
 * that behaviour: without it the whole 17-platform arena is unreachable and
 * only the central 16x16 box is playable.
 */
describe('arena traversal', () => {
  function walk(towardYaw: number, ticks: number): MatchSim {
    const sim = startCombat(2);
    const walker = player(sim, 'p1');
    place(walker, 0, 0.02, 0, towardYaw);
    for (let i = 0; i < ticks; i += 1) {
      sim.setInput('p1', inputFrame({ moveZ: 1, yaw: towardYaw }));
      sim.tickOnce();
    }
    return sim;
  }

  it('walks off the centre platform and down onto the south causeway', () => {
    const sim = startCombat(2);
    const walker = player(sim, 'p1');
    place(walker, 0, 0.02, 0, Math.PI);

    let lowestY = walker.position.y;
    let furthestZ = walker.position.z;
    for (let i = 0; i < 150; i += 1) {
      sim.setInput('p1', inputFrame({ moveZ: 1, yaw: Math.PI }));
      sim.tickOnce();
      lowestY = Math.min(lowestY, walker.position.y);
      furthestZ = Math.max(furthestZ, walker.position.z);
    }

    // Stepped down onto the bridge deck (top face at y = -0.5)...
    expect(lowestY).toBeCloseTo(-0.5, 1);
    // ...and carried on up onto the terrace beyond it.
    expect(furthestZ).toBeGreaterThan(12);
    expect(walker.falls).toBe(0);
  });

  it('steps back up from the causeway onto the south terrace', () => {
    const sim = walk(Math.PI, 150);
    const walker = player(sim, 'p1');
    // The terrace spans z 10.5..19.5 and its monolith stops the walk at 13.75.
    expect(walker.position.z).toBeGreaterThan(12);
    expect(walker.position.y).toBeCloseTo(0, 1);
    expect(walker.falls).toBe(0);
  });

  it('reaches the north terrace by walking the other way', () => {
    const sim = walk(0, 150);
    const walker = player(sim, 'p1');
    expect(walker.position.z).toBeLessThan(-12);
    expect(walker.falls).toBe(0);
  });
});
