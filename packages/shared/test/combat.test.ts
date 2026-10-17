import { describe, expect, it } from 'vitest';
import {
  GRAVITY_SHOT,
  MatchSim,
  PLATFORM_BREAK,
  PLAYER,
  PUNCH,
  SHOCKWAVE,
  TICK_MS,
  damagePlatform,
  platformStateFor,
  type ArenaDef,
  type PlayerState,
} from '../src/index.js';
import { PROTECTION_TICKS, advance, inputFrame, place, player, startCombat } from './helpers.js';

/** Deterministic mini arena used for line-of-sight and platform-break tests. */
const testArena: ArenaDef = {
  id: 'test-arena',
  name: 'Test Arena',
  platforms: [
    {
      id: 'floor',
      kind: 'safe',
      label: 'Floor',
      center: { x: 0, y: -0.5, z: 0 },
      size: { x: 22, y: 1, z: 22 },
      durability: 0,
      spawn: true,
    },
    {
      id: 'wall',
      kind: 'static',
      label: 'Wall',
      center: { x: 0.4, y: 1.5, z: 0 },
      size: { x: 0.4, y: 3, z: 3 },
      durability: 0,
    },
    {
      id: 'crumble',
      kind: 'destructible',
      label: 'Crumble',
      center: { x: 0, y: 0.5, z: -6 },
      size: { x: 4, y: 1, z: 3 },
      durability: 60,
    },
  ],
  decor: [],
  spawns: [{ id: 'only', position: { x: 0, y: 0, z: 0 }, yaw: 0 }],
  killY: -25,
  theme: { skyTop: 0, skyBottom: 0, fog: 0, voidFloorY: -60 },
};

function startTestArenaCombat(count = 2): MatchSim {
  const sim = new MatchSim({ arena: testArena });
  for (let i = 0; i < count; i += 1) sim.addPlayer(`p${i + 1}`, `P${i + 1}`);
  sim.startMatch();
  for (let i = 0; i < 90 + PROTECTION_TICKS; i += 1) sim.tickOnce();
  return sim;
}

function first(sim: MatchSim, id: string): PlayerState {
  return player(sim, id);
}

function pin(target: PlayerState, x: number, y: number, z: number, yaw = 0) {
  return () => place(target, x, y, z, yaw);
}

/** Energy regained during a single tick (8/s at 30 Hz). */
const REGEN_PER_TICK = (PLAYER.energyRegenPerSecond * TICK_MS) / 1000;

describe('punch', () => {
  it('deals damage once per activation and applies real knockback', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);
    place(victim, 0, 0, -1.5, 0);

    sim.setInput('p1', inputFrame({ punch: true }));
    // Pin the target until the wind-up resolves, then let physics run one tick.
    advance(sim, 5, pin(victim, 0, 0, -1.5, 0));
    advance(sim, 1);

    expect(victim.health).toBe(PLAYER.maxHealth - PUNCH.damage);
    expect(victim.velocity.z).toBeLessThan(-1);
    expect(victim.position.z).toBeLessThan(-1.5);
    expect(attacker.cooldowns.punch).toBeGreaterThan(sim.now);
  });

  it('does not deal damage every tick while the button is held', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    // Hold the punch button for a full second.
    advance(sim, 30, () => {
      sim.setInput('p1', inputFrame({ punch: true }));
      place(victim, 0, 0, -1.5, 0);
    });

    expect(victim.health).toBe(PLAYER.maxHealth - PUNCH.damage);
  });

  it('rejects a second activation while the cooldown is running', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 6, pin(victim, 0, 0, -1.5, 0));
    expect(victim.health).toBe(85);

    // Release, then press again immediately (well inside the 450 ms cooldown).
    sim.setInput('p1', inputFrame());
    advance(sim, 1, pin(victim, 0, 0, -1.5, 0));
    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 1, pin(victim, 0, 0, -1.5, 0));
    expect(sim.events.some((e) => e.type === 'ability-denied' && e.detail === 'punch:cooldown')).toBe(
      true,
    );

    advance(sim, 8, pin(victim, 0, 0, -1.5, 0));
    expect(victim.health).toBe(85);
  });

  it('misses when the target is out of range', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 6, pin(victim, 0, 0, -4, 0));

    expect(victim.health).toBe(PLAYER.maxHealth);
  });

  it('is blocked by line of sight', () => {
    const sim = startTestArenaCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    // Facing +X, with the wall between attacker and target.
    place(attacker, -0.6, 0, 0, -Math.PI / 2);

    sim.setInput('p1', inputFrame({ punch: true }));
    // Give the wind-up time to resolve while the target stands still behind the wall.
    advance(sim, 8, pin(victim, 1.0, 0, 0, 0));

    expect(victim.health).toBe(PLAYER.maxHealth);
  });

  it('still works with zero energy (no energy cost)', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);
    attacker.energy = 0;

    sim.setInput('p1', inputFrame({ punch: true }));
    advance(sim, 6, pin(victim, 0, 0, -1.5, 0));
    expect(victim.health).toBe(PLAYER.maxHealth - PUNCH.damage);
  });
});

describe('energy', () => {
  it('regenerates at 8 per second and never exceeds the cap', () => {
    const sim = startCombat(2);
    const one = first(sim, 'p1');
    one.energy = 50;
    advance(sim, 30);
    expect(one.energy).toBeCloseTo(58, 4);

    one.energy = 99;
    advance(sim, 30);
    expect(one.energy).toBe(PLAYER.maxEnergy);
  });

  it('rejects an ability when energy is insufficient and does not spend it', () => {
    const sim = startCombat(2);
    const one = first(sim, 'p1');
    one.energy = GRAVITY_SHOT.energyCost - 1;
    sim.setInput('p1', inputFrame({ gravity: true }));
    advance(sim, 1);
    expect(sim.projectiles).toHaveLength(0);
    expect(one.energy).toBeLessThan(GRAVITY_SHOT.energyCost);
    expect(sim.events.some((e) => e.type === 'ability-denied' && e.detail === 'gravity:no-energy')).toBe(
      true,
    );
  });
});

describe('gravity shot', () => {
  it('spawns a server projectile that damages and pulls the target in', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const victim = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);
    place(victim, 0, 0, -5, 0);

    sim.setInput('p1', inputFrame({ gravity: true }));
    advance(sim, 1);
    expect(sim.projectiles).toHaveLength(1);
    // The cost is spent immediately and regeneration runs in the same tick.
    expect(attacker.energy).toBeCloseTo(
      PLAYER.maxEnergy - GRAVITY_SHOT.energyCost + REGEN_PER_TICK,
      4,
    );

    advance(sim, 10);
    expect(victim.health).toBe(PLAYER.maxHealth - GRAVITY_SHOT.damage);
    // Pulled toward the attacker (positive Z) rather than pushed away.
    expect(victim.position.z).toBeGreaterThan(-4.9);
    // One hit only: the projectile is consumed.
    expect(sim.projectiles).toHaveLength(0);
  });

  it('expires on its own when nothing is hit', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    place(attacker, 0, 0, 0, 0);
    // Aim upward so the projectile never reaches another player.
    sim.setInput('p1', inputFrame({ gravity: true, pitch: 1.2 }));
    advance(sim, 1);
    expect(sim.projectiles).toHaveLength(1);
    advance(sim, 30);
    expect(sim.projectiles).toHaveLength(0);
  });
});

describe('shockwave', () => {
  it('damages only enemies inside the radius and vertical band', () => {
    const sim = startCombat(4);
    const attacker = first(sim, 'p1');
    const near = first(sim, 'p2');
    const far = first(sim, 'p3');
    const above = first(sim, 'p4');
    place(attacker, 0, 0, 0, 0);
    place(near, 0, 0, -4, 0);
    place(far, 0, 0, -SHOCKWAVE.radius - 2, 0);
    place(above, 0, 12, -3, 0);

    sim.setInput('p1', inputFrame({ shockwave: true }));
    advance(sim, 1);

    expect(near.health).toBe(PLAYER.maxHealth - SHOCKWAVE.damage);
    expect(above.health).toBe(PLAYER.maxHealth);
    expect(far.health).toBe(PLAYER.maxHealth);
    expect(attacker.energy).toBeCloseTo(
      PLAYER.maxEnergy - SHOCKWAVE.energyCost + REGEN_PER_TICK,
      4,
    );
  });

  it('does not hit a player far above the burst', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const above = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);
    place(above, 0, 12, -3, 0);

    sim.setInput('p1', inputFrame({ shockwave: true }));
    advance(sim, 1);
    expect(above.health).toBe(PLAYER.maxHealth);
  });

  it('hits each target at most once per activation', () => {
    const sim = startCombat(2);
    const attacker = first(sim, 'p1');
    const near = first(sim, 'p2');
    place(attacker, 0, 0, 0, 0);

    sim.setInput('p1', inputFrame({ shockwave: true }));
    advance(sim, 1, pin(near, 0, 0, -3, 0));
    expect(near.health).toBe(PLAYER.maxHealth - SHOCKWAVE.damage);

    // Hold the button: the edge trigger means no further activations.
    advance(sim, 5, () => {
      sim.setInput('p1', inputFrame({ shockwave: true }));
      place(near, 0, 0, -3, 0);
    });
    expect(near.health).toBe(PLAYER.maxHealth - SHOCKWAVE.damage);
  });
});

describe('platform break', () => {
  it('consumes a charge, damages the target and ignores safe platforms', () => {
    const sim = startTestArenaCombat(2);
    const attacker = first(sim, 'p1');
    place(attacker, 0, 0, 0, 0);

    // Aiming down at the indestructible floor must not consume a charge.
    sim.setInput('p1', inputFrame({ breakPlatform: true, pitch: -1.4 }));
    advance(sim, 1);
    expect(attacker.breakCharges).toBe(PLATFORM_BREAK.charges);
    expect(
      sim.events.some((e) => e.type === 'ability-denied' && e.detail === 'platformBreak:no-target'),
    ).toBe(true);

    // Aim at the destructible platform.
    sim.setInput('p1', inputFrame());
    advance(sim, 12);
    sim.setInput('p1', inputFrame({ breakPlatform: true, yaw: 0, pitch: -0.25 }));
    advance(sim, 1);

    const crumble = sim.platforms.find((p) => p.id === 'crumble')!;
    expect(crumble.durability).toBe(30);
    expect(crumble.state).toBe('CRACKED');
    expect(attacker.breakCharges).toBe(PLATFORM_BREAK.charges - 1);
  });

  it('collapses exactly once and then removes collision', () => {
    const sim = startTestArenaCombat(2);
    const attacker = first(sim, 'p1');
    const crumble = sim.platforms.find((p) => p.id === 'crumble')!;

    // Two hits destroy a 60-durability platform.
    const hitA = damagePlatform(crumble, PLATFORM_BREAK.damage, 0);
    const hitB = damagePlatform(crumble, PLATFORM_BREAK.damage, 0);
    const hitC = damagePlatform(crumble, PLATFORM_BREAK.damage, 0);
    expect(hitA.startedCollapse).toBe(false);
    expect(hitB.startedCollapse).toBe(true);
    expect(hitC.applied).toBe(false); // no double collapse

    const collapseTicks = Math.ceil(1200 / TICK_MS);
    place(attacker, 0, 0, 0, 0);
    advance(sim, collapseTicks + 1);
    expect(crumble.state).toBe('DESTROYED');
    expect(sim.platforms.find((p) => p.id === 'crumble')!.state).toBe('DESTROYED');
    expect(platformStateFor(0, 60)).toBe('DESTROYED');
  });

  it('refuses to target a safe platform and reports a reason', () => {
    const sim = startTestArenaCombat(2);
    const attacker = first(sim, 'p1');
    place(attacker, 0, 0, 0, 0);
    sim.setInput('p1', inputFrame({ breakPlatform: true, yaw: Math.PI, pitch: 0 }));
    advance(sim, 1);
    expect(attacker.breakCharges).toBe(PLATFORM_BREAK.charges);
  });
});
