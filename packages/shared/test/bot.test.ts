/**
 * Bot (server-controlled fighter) tests.
 *
 * These drive the real `MatchSim` — the same simulation the server runs — and
 * prove the matchmaking bots actually play: they close distance, land hits,
 * respect spawn protection, refuse to walk off the arena, and behave
 * deterministically. Rendering and feel remain manual (see docs/TESTING.md).
 */
import { describe, expect, it } from 'vitest';
import {
  ARENA,
  MAX_PLAYERS,
  MatchSim,
  PLAYER,
  TICK_MS,
  TICK_RATE,
  ULTRA_BOTS,
  botProfileFor,
} from '../src/index.js';
import { COUNTDOWN_TICKS, PROTECTION_TICKS, advance, inputFrame, place, player } from './helpers.js';

const TICKS_PER_SECOND = TICK_RATE;

/** A match with one human and one bot, already in combat and unprotected. */
function humanVsBot(): MatchSim {
  const sim = new MatchSim();
  sim.addPlayer('human', 'Human');
  sim.addBot('Bot');
  sim.startMatch();
  advance(sim, COUNTDOWN_TICKS + PROTECTION_TICKS);
  return sim;
}

describe('bot membership', () => {
  it('creates a flagged fighter with a stable id', () => {
    const sim = new MatchSim();
    const bot = sim.addBot('Vane');
    expect(bot.isBot).toBe(true);
    expect(bot.id).toBe('bot-1');
    expect(bot.name).toBe('Vane');
    expect(sim.botCount).toBe(1);
    expect(sim.humanCount).toBe(0);
  });

  it('never lets a bot host the room', () => {
    const sim = new MatchSim();
    sim.addBot('Vane');
    expect(sim.isHostCandidate()).toBeNull();
    sim.addPlayer('human', 'Human');
    expect(sim.isHostCandidate()?.id).toBe('human');
  });

  it('rotates through the ultra roster', () => {
    expect(botProfileFor(0).name).toBe(ULTRA_BOTS[0]!.name);
    expect(botProfileFor(ULTRA_BOTS.length).name).toBe(ULTRA_BOTS[0]!.name);
    expect(botProfileFor(ULTRA_BOTS.length + 1).name).toBe(ULTRA_BOTS[1]!.name);

    const sim = new MatchSim();
    for (let i = 0; i < MAX_PLAYERS; i += 1) sim.addBot();
    expect(sim.players.map((p) => p.name)).toEqual(
      ULTRA_BOTS.slice(0, MAX_PLAYERS).map((profile) => profile.name),
    );
  });

  it('can be removed again (a human opponent turned up)', () => {
    const sim = new MatchSim();
    sim.addPlayer('human', 'Human');
    sim.addBot();
    sim.addBot();
    expect(sim.removeBots()).toBe(2);
    expect(sim.botCount).toBe(0);
    expect(sim.humanCount).toBe(1);
  });

  it('lets a solo host start a match against bots', () => {
    const sim = new MatchSim();
    sim.addPlayer('human', 'Human');
    expect(sim.canStart()).toBe(false);
    sim.addBot();
    expect(sim.canStart()).toBe(true);
  });
});

describe('bot combat skill', () => {
  it('closes the distance and eliminates a defenceless opponent', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    const human = player(sim, 'human');

    // 20 seconds is generous: the spawns are ~11 m apart and a kill takes a
    // handful of punches.
    advance(sim, TICKS_PER_SECOND * 20);

    expect(human.deaths).toBeGreaterThan(0);
    expect(bot.score).toBeGreaterThan(0);
    expect(bot.eliminations).toBeGreaterThan(0);
  });

  it('does not waste attacks on a spawn-protected opponent', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    const human = player(sim, 'human');

    // Park them inside punching distance and keep the human invulnerable.
    for (let i = 0; i < TICKS_PER_SECOND * 3; i += 1) {
      place(bot, 0.9, 0.02, 0, 0);
      place(human, -0.9, 0.02, 0, 0);
      human.spawnProtectionUntil = (sim.tick + TICKS_PER_SECOND * 5) * TICK_MS;
      sim.tickOnce();
    }

    expect(human.health).toBe(PLAYER.maxHealth);
    expect(human.deaths).toBe(0);
  });

  it('spends a Platform Break charge on the structure, never on itself', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    const human = player(sim, 'human');

    // Stand the human on the east terrace (destructible) and pre-damage it so
    // the structural play is clearly worth a charge.
    const terrace = sim.platforms.find((platform) => platform.id === 'east-platform')!;
    terrace.durability = 30;
    terrace.state = 'CRITICAL';

    let sawBreak = false;
    for (let i = 0; i < TICKS_PER_SECOND * 12; i += 1) {
      place(human, 15, 0.02, 0, 0);
      place(bot, 15, 0.02, -3.4, 0);
      sim.tickOnce();
      if (bot.breakCharges < sim.platforms.length && bot.breakCharges >= 0) {
        if (sim.platforms.some((platform) => platform.durability < 30)) sawBreak = true;
      }
      if (sawBreak) break;
    }

    expect(sawBreak).toBe(true);
  });
});

describe('bot safety', () => {
  it('never walks off the arena while chasing an opponent along an edge', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    const human = player(sim, 'human');

    // March the human around the rim of the centre platform for 25 seconds.
    let angle = 0;
    advance(sim, TICKS_PER_SECOND * 25, () => {
      angle += 0.02;
      const radius = 7.4;
      place(human, Math.cos(angle) * radius, 0.02, Math.sin(angle) * radius, 0);
      sim.setInput('human', inputFrame({ moveZ: 1, yaw: human.yaw }));
    });

    expect(bot.falls).toBe(0);
    expect(bot.position.y).toBeGreaterThan(sim.arena.killY);
  });

  it('crosses the causeway instead of dropping into the canyon', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    const human = player(sim, 'human');

    // The human waits on the north terrace, across a 0.5 m step down onto the
    // bridge and a 0.5 m step back up on the far side. The bot has to do both.
    advance(sim, TICKS_PER_SECOND * 14, () => {
      place(human, 0, 0.02, -15, 0);
      human.spawnProtectionUntil = (sim.tick + 60) * TICK_MS;
      sim.setInput('human', inputFrame());
    });

    expect(bot.falls).toBe(0);
    // The north terrace starts at z = -10.5, so anything past that is across.
    expect(bot.position.z).toBeLessThan(-10.5);
    expect(bot.position.y).toBeGreaterThan(sim.arena.killY);
  });

  it('leaves a platform that is collapsing underneath it', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    const human = player(sim, 'human');

    const causeway = sim.platforms.find((platform) => platform.id === 'north-bridge')!;
    causeway.durability = 0;
    causeway.state = 'COLLAPSING';
    causeway.collapseStartedTick = sim.tick;
    place(bot, 0, -0.9, -9.25, 0);
    // Keep the human far away so the only sensible move is off the bridge.
    place(human, 0, 0.02, 15, 0);

    const startX = bot.position.x;
    const startZ = bot.position.z;
    advance(sim, TICKS_PER_SECOND * 4, () => {
      sim.setInput('human', inputFrame());
    });

    const moved = Math.hypot(bot.position.x - startX, bot.position.z - startZ);
    expect(moved).toBeGreaterThan(2);
    expect(bot.falls).toBe(0);
  });
});

describe('bot determinism', () => {
  it('produces identical state for identical inputs', () => {
    const run = (): Array<[number, number, number]> => {
      const sim = humanVsBot();
      advance(sim, TICKS_PER_SECOND * 8, () => {
        sim.setInput('human', inputFrame({ moveX: 1, moveZ: 0.5, yaw: 1.1 }));
      });
      return sim.players.map((p) => [
        Math.round(p.position.x * 1000),
        Math.round(p.position.y * 1000),
        Math.round(p.position.z * 1000),
      ]);
    };

    expect(run()).toEqual(run());
  });

  it('never exceeds its own cooldowns or resource budgets', () => {
    const sim = humanVsBot();
    const bot = player(sim, 'bot-1');
    let maxEnergy: number = PLAYER.maxEnergy;
    advance(sim, TICKS_PER_SECOND * 15, () => {
      maxEnergy = Math.max(maxEnergy, bot.energy);
    });
    expect(maxEnergy).toBeLessThanOrEqual(PLAYER.maxEnergy);
    expect(bot.energy).toBeGreaterThanOrEqual(0);
    expect(bot.breakCharges).toBeLessThanOrEqual(2);
    expect(bot.breakCharges).toBeGreaterThanOrEqual(0);
  });
});

describe('arena sanity for bots', () => {
  it('spawns inside the playable arena', () => {
    const sim = new MatchSim();
    const bot = sim.addBot();
    expect(bot.position.y).toBeGreaterThan(ARENA.killY);
    expect(Math.abs(bot.position.x)).toBeLessThan(10);
    expect(Math.abs(bot.position.z)).toBeLessThan(10);
  });
});
