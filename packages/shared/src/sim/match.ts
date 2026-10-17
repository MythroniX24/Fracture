/**
 * FRACTURE — authoritative, deterministic match simulation.
 *
 * One instance owns everything that matters inside a room: phases, players,
 * platforms, projectiles, events and scoring. It advances in fixed 30 Hz ticks
 * and never reads wall-clock time or randomness, so the same tick sequence
 * always produces the same result (the room only supplies inputs).
 *
 * The server runs this and broadcasts snapshots. Clients reuse the movement
 * and rules modules for presentation/prediction but never authoritatively
 * change this state.
 */
import {
  COUNTDOWN_MS,
  GRAVITY_SHOT,
  MATCH_DURATION_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLATFORM_BREAK,
  PLAYER,
  PUNCH,
  SCORING,
  SHOCKWAVE,
  TICK_MS,
  SNAPSHOT_EVERY_TICKS,
} from '../config.js';
import {
  addScaled,
  clamp,
  clampLength,
  dirFromYawPitch,
  distance,
  len,
  normalize,
  rayAabb,
  sub,
  v3,
  type Vec3,
} from '../math.js';
import type {
  AbilityId,
  GameEvent,
  MatchPhase,
  MatchResults,
  PlayerInput,
  PlayerState,
  PlatformRuntime,
  Projectile,
  ScoreEntry,
  Snapshot,
} from '../types.js';
import { emptyInput } from '../types.js';
import { ARENA, createPlatformRuntimes, spawnPointForSlot, type ArenaDef } from '../arena.js';
import { advancePlatform, collapseRemainingMs, damagePlatform, isSolid } from '../rules/platforms.js';
import {
  findBreakTarget,
  findPunchTargets,
  findShockwaveTargets,
  outwardDirection,
  playerEye,
  pushDirection,
  sweepProjectileForPlayer,
} from '../rules/targeting.js';
import { releaseJumpIfNeeded, startDodge, stepPlayerMovement, tryJump } from './movement.js';
import { createPlayerState, resetPlayerForMatch, revivePlayer } from './player.js';
import { BotBrain, botProfileFor } from './bot.js';

/** An ability triggered on this tick (dodge is a movement ability). */
export type ActivationKind = AbilityId | 'dodge';

export interface Activation {
  ability: ActivationKind;
  playerId: string;
  origin: Vec3;
  dir: Vec3;
}

interface PendingPunch {
  attackId: number;
  ownerId: string;
  resolveTick: number;
  origin: Vec3;
  dir: Vec3;
}

interface DamageIntent {
  targetId: string;
  attackerId: string;
  amount: number;
  knockback: Vec3;
  ability: AbilityId;
  position: Vec3;
}

export interface MatchSimOptions {
  arena?: ArenaDef;
  maxPlayers?: number;
}

export class MatchSim {
  readonly arena: ArenaDef;
  readonly maxPlayers: number;

  /** Monotonic simulation tick. Also the match clock source. */
  tick = 0;
  phase: MatchPhase = 'lobby';
  players: PlayerState[] = [];
  platforms: PlatformRuntime[];
  projectiles: Projectile[] = [];
  results: MatchResults | null = null;

  /** Events produced by the last `tickOnce()`. */
  events: GameEvent[] = [];

  /**
   * Events accumulated since the last broadcast. Snapshots are sent at 15 Hz
   * while the simulation runs at 30 Hz, so without this buffer every other tick
   * of events (hits, eliminations, collapses) would never reach the clients.
   */
  private eventBuffer: GameEvent[] = [];

  countdownEndsTick = 0;
  combatStartsTick = 0;
  combatEndsTick = 0;
  /** How many matches this room has played (rematch counter). */
  matchIndex = 0;

  /** One brain per server-controlled fighter. */
  private readonly brains = new Map<string, BotBrain>();
  /** Monotonic counter used for stable bot ids, names and profiles. */
  private botSerial = 0;

  private pending: PendingPunch[] = [];
  private inputs = new Map<string, PlayerInput>();
  private lastInputs = new Map<string, PlayerInput>();
  private lastSeq = new Map<string, number>();
  private nextProjectileId = 1;
  private nextAttackId = 1;
  private nextSlot = 0;

  constructor(options: MatchSimOptions = {}) {
    this.arena = options.arena ?? ARENA;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.platforms = createPlatformRuntimes(this.arena);
  }

  /** Current simulation time in milliseconds. */
  get now(): number {
    return this.tick * TICK_MS;
  }

  get full(): boolean {
    return this.players.filter((p) => p.connected).length >= this.maxPlayers;
  }

  get connectedCount(): number {
    return this.players.filter((p) => p.connected).length;
  }

  /** Connected human fighters (bots excluded). */
  get humanCount(): number {
    return this.players.filter((p) => p.connected && !p.isBot).length;
  }

  /** Connected server-controlled fighters. */
  get botCount(): number {
    return this.players.filter((p) => p.connected && p.isBot).length;
  }

  getPlayer(id: string): PlayerState | undefined {
    return this.players.find((p) => p.id === id);
  }

  hasPlayer(id: string): boolean {
    return this.players.some((p) => p.id === id);
  }

  /** Players ordered by stable slot index (used for deterministic iteration). */
  orderedPlayers(): PlayerState[] {
    return [...this.players].sort((a, b) => a.slot - b.slot);
  }

  // -------------------------------------------------------------------------
  // Room membership
  // -------------------------------------------------------------------------

  addPlayer(id: string, name: string, isBot = false): PlayerState {
    const usedSlots = new Set(this.players.map((p) => p.slot));
    let slot = 0;
    while (usedSlots.has(slot) && slot < this.maxPlayers) slot += 1;
    if (slot >= this.maxPlayers) slot = this.nextSlot % this.maxPlayers;
    this.nextSlot = slot + 1;

    const player = createPlayerState({ id, name, slot, arena: this.arena, isBot });
    player.animTick = this.tick;
    this.players.push(player);
    this.players.sort((a, b) => a.slot - b.slot);

    if (this.phase === 'combat') {
      // Joining mid-match: enter the arena with a full loadout and protection.
      const spawn = spawnPointForSlot(this.arena, player.slot);
      revivePlayer(
        player,
        spawn.position,
        spawn.yaw,
        this.now + PLAYER.spawnProtectionMs,
        this.now,
        this.tick,
      );
    }
    return player;
  }

  /**
   * Add a server-controlled fighter and attach its brain. Bots are ordinary
   * players: same collision, same cooldowns, same scoring.
   */
  addBot(name?: string): PlayerState {
    const serial = this.botSerial;
    this.botSerial += 1;
    const profile = botProfileFor(serial);
    const id = `bot-${serial + 1}`;
    const player = this.addPlayer(id, name ?? profile.name, true);
    this.brains.set(id, new BotBrain(profile));
    return player;
  }

  /**
   * Remove every bot and return how many were dropped. Called when a real
   * opponent appears during matchmaking, so the lobby is humans-only again.
   */
  removeBots(): number {
    const ids = this.players.filter((player) => player.isBot).map((player) => player.id);
    for (const id of ids) this.removePlayer(id);
    return ids.length;
  }

  removePlayer(id: string): void {
    this.brains.delete(id);
    this.players = this.players.filter((p) => p.id !== id);
    this.clearInput(id);
    this.pending = this.pending.filter((p) => p.ownerId !== id);
    this.projectiles = this.projectiles.filter((p) => p.ownerId !== id);
    // Re-assign slots so colours/spawns stay unique.
    const ordered = this.orderedPlayers();
    ordered.forEach((player, index) => {
      player.slot = index;
    });
  }

  /** Mark a player as temporarily disconnected (their slot is kept). */
  markDisconnected(id: string): void {
    const player = this.getPlayer(id);
    if (!player || player.isBot) return;
    player.connected = false;
    player.disconnectedAt = this.now;
    player.ready = false;
    player.velocity.x = 0;
    player.velocity.z = 0;
    // Drop their input so they do not keep "holding" the last button pressed.
    this.clearInput(id);
  }

  markReconnected(id: string): void {
    const player = this.getPlayer(id);
    if (!player) return;
    player.connected = true;
    player.disconnectedAt = null;
    if (this.phase === 'combat') {
      // Returning mid-match: hand back a live fighter with protection.
      const spawn = spawnPointForSlot(this.arena, player.slot);
      revivePlayer(
        player,
        spawn.position,
        spawn.yaw,
        this.now + PLAYER.spawnProtectionMs,
        this.now,
        this.tick,
      );
    }
  }

  /** Slots whose reconnect window has expired (removed by the room). */
  expiredDisconnects(windowMs: number): PlayerState[] {
    const now = this.now;
    return this.players.filter(
      (p) => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= windowMs,
    );
  }

  isHostCandidate(): PlayerState | null {
    // Bots can never host: only a human may start, rematch or be addressed.
    const connected = this.orderedPlayers().filter((p) => p.connected && !p.isBot);
    return connected[0] ?? null;
  }

  setReady(id: string, ready: boolean): boolean {
    const player = this.getPlayer(id);
    if (!player || this.phase !== 'lobby') return false;
    player.ready = ready;
    return true;
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /**
   * Store the latest input for a player. Duplicate or out-of-order sequence
   * numbers are rejected, which throttles replayed/forged input bursts.
   */
  setInput(id: string, input: PlayerInput): boolean {
    if (!this.getPlayer(id)) return false;
    const last = this.lastSeq.get(id) ?? 0;
    if (input.seq > 0 && input.seq <= last) return false;
    if (input.seq > 0) this.lastSeq.set(id, input.seq);
    this.inputs.set(id, input);
    return true;
  }

  clearInput(id: string): void {
    this.inputs.delete(id);
    this.lastInputs.delete(id);
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  canStart(): boolean {
    return this.phase === 'lobby' && this.connectedCount >= MIN_PLAYERS;
  }

  /** Reset the arena and begin the countdown. Returns false when not allowed. */
  startMatch(): boolean {
    if (this.phase !== 'lobby' && this.phase !== 'results') return false;
    if (this.connectedCount < MIN_PLAYERS) return false;

    this.matchIndex += 1;
    this.platforms = createPlatformRuntimes(this.arena);
    this.projectiles = [];
    this.pending = [];
    this.results = null;
    this.eventBuffer = [];
    this.inputs.clear();
    this.lastInputs.clear();
    this.lastSeq.clear();

    for (const player of this.players) {
      resetPlayerForMatch(player, this.arena, this.tick);
      player.ready = false;
    }
    for (const brain of this.brains.values()) brain.reset();

    // Drop players who left the lobby while the match was being prepared.
    this.players = this.players.filter((p) => p.connected);

    this.phase = 'countdown';
    this.countdownEndsTick = this.tick + Math.ceil(COUNTDOWN_MS / TICK_MS);
    this.events.push({ type: 'phase', tick: this.tick, detail: 'countdown' });
    return true;
  }

  private beginCombat(): void {
    this.phase = 'combat';
    this.combatStartsTick = this.tick;
    this.combatEndsTick = this.tick + Math.ceil(MATCH_DURATION_MS / TICK_MS);
    for (const player of this.players) {
      player.spawnProtectionUntil = this.now + PLAYER.spawnProtectionMs;
      player.alive = true;
      player.health = PLAYER.maxHealth;
      player.energy = PLAYER.maxEnergy;
      player.respawnAtTick = null;
    }
    this.events.push({ type: 'phase', tick: this.tick, detail: 'combat' });
  }

  private endMatch(): void {
    this.phase = 'results';
    this.projectiles = [];
    this.pending = [];
    this.results = this.computeResults();
    this.events.push({ type: 'match-end', tick: this.tick, detail: 'match-end' });
  }

  /** Remaining match time in milliseconds (0 outside combat). */
  get matchRemainingMs(): number {
    if (this.phase !== 'combat') return 0;
    return Math.max(0, (this.combatEndsTick - this.tick) * TICK_MS);
  }

  get countdownRemainingMs(): number {
    if (this.phase !== 'countdown') return 0;
    return Math.max(0, (this.countdownEndsTick - this.tick) * TICK_MS);
  }

  computeResults(): MatchResults {
    const entries: ScoreEntry[] = this.players.map((player) => ({
      playerId: player.id,
      name: player.name,
      color: player.color,
      score: player.score,
      eliminations: player.eliminations,
      falls: player.falls,
      deaths: player.deaths,
      rank: 1,
    }));

    entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.eliminations !== a.eliminations) return b.eliminations - a.eliminations;
      if (a.falls !== b.falls) return a.falls - b.falls;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return a.name.localeCompare(b.name);
    });

    let rank = 0;
    let previousScore: number | null = null;
    entries.forEach((entry, index) => {
      if (previousScore === null || entry.score !== previousScore) {
        rank = index + 1;
        previousScore = entry.score;
      }
      entry.rank = rank;
    });

    const winners = entries.filter((e) => e.rank === 1).map((e) => e.playerId);
    return {
      finishedAt: this.now,
      // The scheduled match length: the clock the server owns and the HUD shows.
      durationMs: Math.max(0, Math.round((this.combatEndsTick - this.combatStartsTick) * TICK_MS)),
      scores: entries,
      winners,
      tie: winners.length > 1,
    };
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  tickOnce(): void {
    this.tick += 1;
    this.events = [];

    if (this.phase === 'countdown' && this.tick >= this.countdownEndsTick) this.beginCombat();
    if (this.phase === 'combat' && this.tick >= this.combatEndsTick) this.endMatch();

    const inCombat = this.phase === 'combat';
    const now = this.now;
    this.thinkBots(now);
    const solids = this.solids();
    const intents: DamageIntent[] = [];
    const activations: Activation[] = [];

    // ---- 1. Movement + ability activation -------------------------------
    for (const player of this.orderedPlayers()) {
      const input = this.inputs.get(player.id) ?? emptyInput();
      const previous = this.lastInputs.get(player.id) ?? emptyInput();
      const press = {
        jump: input.jump && !previous.jump,
        dodge: input.dodge && !previous.dodge,
        punch: input.punch && !previous.punch,
        gravity: input.gravity && !previous.gravity,
        shockwave: input.shockwave && !previous.shockwave,
        breakPlatform: input.breakPlatform && !previous.breakPlatform,
      };
      this.lastInputs.set(player.id, { ...input });

      player.invulnerable = player.alive && now < player.spawnProtectionUntil;

      if (this.phase === 'results' || this.phase === 'countdown' || this.phase === 'lobby') {
        // Frozen: aim still updates so the camera stays controllable, but no
        // movement and no abilities. A real match never pauses for one client.
        player.yaw = input.yaw;
        player.pitch = clamp(input.pitch, PLAYER.pitchMin, PLAYER.pitchMax);
        player.velocity.x = 0;
        player.velocity.z = 0;
        player.anim = player.alive ? 'idle' : 'down';
        continue;
      }

      if (!inCombat) continue;

      if (player.alive) {
        if (press.jump) player.jumpBufferUntil = now + PLAYER.jumpBufferMs;
        if (press.dodge && startDodge(player, input, now)) {
          activations.push({
            ability: 'dodge',
            playerId: player.id,
            origin: player.position,
            dir: player.dodgeDir,
          });
        }
        tryJump(player, now);
        releaseJumpIfNeeded(player, input, now);
      }

      stepPlayerMovement(player, input, solids, now, TICK_MS);

      if (player.alive) {
        const origin = playerEye(player);
        const dir = dirFromYawPitch(player.yaw, player.pitch);
        const push = (ability: AbilityId) =>
          activations.push({ ability, playerId: player.id, origin, dir });

        if (press.punch) {
          if (now >= player.cooldowns.punch) push('punch');
          else this.deny(player, 'cooldown', 'punch');
        }
        if (press.gravity && this.canPay(player, 'gravity', now)) push('gravity');
        if (press.shockwave && this.canPay(player, 'shockwave', now)) push('shockwave');
        if (press.breakPlatform && this.canPay(player, 'platformBreak', now)) {
          push('platformBreak');
        }
      }

      player.anim = this.animationFor(player, now, press.dodge);
    }

    // ---- 2. Resolve pending punch wind-ups -------------------------------
    const stillPending: PendingPunch[] = [];
    for (const attack of [...this.pending].sort((a, b) => a.attackId - b.attackId)) {
      if (attack.resolveTick > this.tick) {
        stillPending.push(attack);
        continue;
      }
      const attacker = this.getPlayer(attack.ownerId);
      if (!attacker || !attacker.alive) continue;
      const targets = findPunchTargets(
        attack.origin,
        attack.dir,
        attack.ownerId,
        this.players,
        solids,
        (p) => now < p.spawnProtectionUntil,
      );
      for (const target of targets) {
        intents.push({
          targetId: target.id,
          attackerId: attack.ownerId,
          amount: PUNCH.damage,
          ability: 'punch',
          knockback: this.knockbackVector(
            pushDirection(attacker.position, target.position, attacker.yaw),
            PUNCH.knockback,
            PUNCH.knockbackUp,
          ),
          position: addScaled(playerEye(attacker), attack.dir, 1.1),
        });
      }
      if (targets.length === 0) {
        this.events.push({
          type: 'hit',
          tick: this.tick,
          sourceId: attack.ownerId,
          amount: 0,
          detail: 'punch-miss',
        });
      }
    }
    this.pending = stillPending;

    // ---- 3. Resolve activations ------------------------------------------
    for (const activation of activations) {
      const player = this.getPlayer(activation.playerId);
      if (!player || !player.alive) continue;
      switch (activation.ability) {
        case 'dodge':
          this.events.push({
            type: 'ability',
            tick: this.tick,
            sourceId: player.id,
            detail: 'dodge',
            position: player.position,
          });
          break;
        case 'punch':
          player.cooldowns.punch = now + PUNCH.cooldownMs;
          player.anim = 'punch';
          player.animTick = this.tick;
          this.pending.push({
            attackId: this.nextAttackId++,
            ownerId: player.id,
            resolveTick: this.tick + Math.max(1, Math.round(PUNCH.windupMs / TICK_MS)),
            origin: activation.origin,
            dir: activation.dir,
          });
          this.events.push({
            type: 'ability',
            tick: this.tick,
            sourceId: player.id,
            detail: 'punch',
            position: player.position,
          });
          break;
        case 'gravity': {
          this.spend(player, 'gravity', now);
          const muzzle = addScaled(activation.origin, activation.dir, GRAVITY_SHOT.muzzleOffset);
          this.projectiles.push({
            id: `p${this.nextProjectileId++}`,
            ownerId: player.id,
            color: player.color,
            position: muzzle,
            velocity: {
              x: activation.dir.x * GRAVITY_SHOT.speed,
              y: activation.dir.y * GRAVITY_SHOT.speed,
              z: activation.dir.z * GRAVITY_SHOT.speed,
            },
            ageTick: 0,
            lifetimeTicks: Math.max(1, Math.round(GRAVITY_SHOT.lifetimeMs / TICK_MS)),
            distanceTravelled: 0,
            radius: GRAVITY_SHOT.radius,
          });
          this.events.push({
            type: 'ability',
            tick: this.tick,
            sourceId: player.id,
            detail: 'gravity',
            position: muzzle,
          });
          break;
        }
        case 'shockwave': {
          this.spend(player, 'shockwave', now);
          this.events.push({
            type: 'ability',
            tick: this.tick,
            sourceId: player.id,
            detail: 'shockwave',
            position: player.position,
          });
          const targets = findShockwaveTargets(
            player,
            this.players,
            (p) => now < p.spawnProtectionUntil,
          );
          for (const target of targets) {
            const dir = outwardDirection(
              player.position,
              target.position,
              dirFromYawPitch(player.yaw, 0),
            );
            intents.push({
              targetId: target.id,
              attackerId: player.id,
              amount: SHOCKWAVE.damage,
              ability: 'shockwave',
              knockback: this.knockbackVector(dir, SHOCKWAVE.knockback, SHOCKWAVE.knockbackUp),
              position: { ...target.position },
            });
          }
          break;
        }
        case 'platformBreak': {
          const target = findBreakTarget(activation.origin, activation.dir, this.platforms);
          if (!target) {
            this.deny(player, 'no-target', 'platformBreak');
            break;
          }
          if (player.breakCharges <= 0) {
            this.deny(player, 'no-charges', 'platformBreak');
            break;
          }
          player.breakCharges -= 1;
          player.cooldowns.platformBreak = now + PLATFORM_BREAK.cooldownMs;
          const result = damagePlatform(target, PLATFORM_BREAK.damage, this.tick);
          player.anim = 'punch';
          player.animTick = this.tick;
          if (result.applied) {
            this.events.push({
              type: 'platform',
              tick: this.tick,
              sourceId: player.id,
              platformId: target.id,
              amount: PLATFORM_BREAK.damage,
              detail: result.startedCollapse ? 'collapse-start' : target.state,
              position: { ...target.center },
            });
          }
          break;
        }
        default:
          break;
      }
    }

    // ---- 4. Projectiles --------------------------------------------------
    this.updateProjectiles(intents, solids, now);

    // ---- 5. Platform collapse -------------------------------------------
    for (const platform of this.platforms) {
      if (advancePlatform(platform, this.tick, TICK_MS)) {
        this.events.push({
          type: 'platform',
          tick: this.tick,
          platformId: platform.id,
          detail: 'destroyed',
          position: { ...platform.center },
        });
      }
    }

    // ---- 6. Damage application + deaths + falls + respawns ---------------
    this.applyIntents(intents, now);

    for (const player of this.players) {
      if (player.alive && player.health <= 0) {
        this.eliminate(player, player.lastAttackerId, 'damage');
      }
    }

    for (const player of this.players) {
      if (player.alive && player.position.y < this.arena.killY) {
        const attacker =
          player.lastAttackerId && now - player.lastAttackerAt <= SCORING.killCreditWindowMs
            ? player.lastAttackerId
            : null;
        this.eliminate(player, attacker, 'fall');
      }
    }

    this.updateRespawns(now);

    // ---- 7. Resource regeneration ---------------------------------------
    const regenPerTick = (PLAYER.energyRegenPerSecond * TICK_MS) / 1000;
    for (const player of this.players) {
      if (!player.alive) continue;
      player.energy = Math.min(PLAYER.maxEnergy, player.energy + regenPerTick);
    }

    // ---- 8. Buffer events until the next broadcast ----------------------
    if (this.events.length > 0 && this.eventBuffer.length < 256) {
      this.eventBuffer.push(...this.events);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private solids(): PlatformRuntime[] {
    return this.platforms.filter(isSolid);
  }

  /**
   * Replace the stored input of every bot with a fresh one from its brain.
   * Runs before the movement/ability pass so bots are stepped by exactly the
   * same code path as a human client's input.
   */
  private thinkBots(now: number): void {
    if (this.brains.size === 0) return;
    if (this.phase !== 'combat' && this.phase !== 'countdown') return;
    for (const player of this.players) {
      if (!player.isBot) continue;
      const brain = this.brains.get(player.id);
      if (!brain) continue;
      this.inputs.set(
        player.id,
        brain.think({
          self: player,
          players: this.players,
          platforms: this.platforms,
          projectiles: this.projectiles,
          tick: this.tick,
          now,
        }),
      );
    }
  }

  private deny(player: PlayerState, detail: string, ability?: ActivationKind): void {
    this.events.push({
      type: 'ability-denied',
      tick: this.tick,
      sourceId: player.id,
      detail: ability ? `${ability}:${detail}` : detail,
    });
  }

  private canPay(player: PlayerState, ability: AbilityId, now: number): boolean {
    if (ability === 'platformBreak') {
      if (player.breakCharges <= 0) {
        this.deny(player, 'no-charges', ability);
        return false;
      }
      if (now < player.cooldowns.platformBreak) {
        this.deny(player, 'cooldown', ability);
        return false;
      }
      return true;
    }
    const cost =
      ability === 'gravity'
        ? GRAVITY_SHOT.energyCost
        : ability === 'shockwave'
          ? SHOCKWAVE.energyCost
          : 0;
    if (player.energy < cost) {
      this.deny(player, 'no-energy', ability);
      return false;
    }
    if (now < player.cooldowns[ability]) {
      this.deny(player, 'cooldown', ability);
      return false;
    }
    return true;
  }

  private spend(player: PlayerState, ability: 'gravity' | 'shockwave', now: number): void {
    if (ability === 'gravity') {
      player.energy = Math.max(0, player.energy - GRAVITY_SHOT.energyCost);
      player.cooldowns.gravity = now + GRAVITY_SHOT.cooldownMs;
    } else {
      player.energy = Math.max(0, player.energy - SHOCKWAVE.energyCost);
      player.cooldowns.shockwave = now + SHOCKWAVE.cooldownMs;
    }
  }

  private knockbackVector(dir: Vec3, speed: number, up: number): Vec3 {
    const horizontal = normalize({ x: dir.x, y: 0, z: dir.z });
    return { x: horizontal.x * speed, y: up, z: horizontal.z * speed };
  }

  private updateProjectiles(intents: DamageIntent[], solids: PlatformRuntime[], now: number): void {
    const survivors: Projectile[] = [];
    const stepSeconds = TICK_MS / 1000;

    for (const projectile of this.projectiles) {
      projectile.ageTick += 1;
      const step = {
        x: projectile.velocity.x * stepSeconds,
        y: projectile.velocity.y * stepSeconds,
        z: projectile.velocity.z * stepSeconds,
      };
      const stepLength = len(step);
      const from = { ...projectile.position };
      const to = addScaled(from, step, 1);
      const stepDir = sub(to, from);

      // Platform collision: nearest solid box along this step.
      let blockedT: number | null = null;
      for (const platform of solids) {
        const hit = rayAabb(from, stepDir, platform, stepLength);
        if (hit && (blockedT === null || hit.t < blockedT)) blockedT = hit.t;
      }

      const target = sweepProjectileForPlayer(
        from,
        to,
        projectile.radius,
        projectile.ownerId,
        this.players,
        (p) => now < p.spawnProtectionUntil,
      );

      let consumed = false;
      if (target) {
        const owner = this.getPlayer(projectile.ownerId);
        const pullBase = owner
          ? normalize({
              x: owner.position.x - target.position.x,
              y: 0,
              z: owner.position.z - target.position.z,
            })
          : normalize(sub(from, target.position));
        const pull = len(pullBase) < 1e-4 ? fallbackFlat(sub(from, target.position)) : pullBase;
        intents.push({
          targetId: target.id,
          attackerId: projectile.ownerId,
          amount: GRAVITY_SHOT.damage,
          ability: 'gravity',
          knockback: {
            x: pull.x * GRAVITY_SHOT.pullImpulse,
            y: GRAVITY_SHOT.pullUp,
            z: pull.z * GRAVITY_SHOT.pullImpulse,
          },
          position: { ...projectile.position },
        });
        consumed = true;
      } else if (blockedT !== null) {
        this.events.push({
          type: 'hit',
          tick: this.tick,
          sourceId: projectile.ownerId,
          amount: 0,
          detail: 'gravity-blocked',
          position: { ...projectile.position },
        });
        consumed = true;
      }

      if (consumed) continue;
      projectile.position = to;
      projectile.distanceTravelled += stepLength;
      const expired =
        projectile.ageTick >= projectile.lifetimeTicks ||
        projectile.distanceTravelled >= GRAVITY_SHOT.maxRange;
      if (!expired) survivors.push(projectile);
    }

    this.projectiles = survivors;
  }

  private applyIntents(intents: DamageIntent[], now: number): void {
    for (const intent of intents) {
      const target = this.getPlayer(intent.targetId);
      if (!target || !target.alive) continue;

      if (now < target.spawnProtectionUntil) {
        this.events.push({
          type: 'hit',
          tick: this.tick,
          sourceId: intent.attackerId,
          targetId: target.id,
          amount: 0,
          detail: 'protected',
          position: { ...intent.position },
        });
        continue;
      }

      target.health = Math.max(0, target.health - intent.amount);
      target.lastAttackerId = intent.attackerId;
      target.lastAttackerAt = now;
      target.lastHitTick = this.tick;
      target.anim = 'hit';
      target.animTick = this.tick;

      const knockback = clampLength(intent.knockback, PLAYER.maxKnockbackSpeed);
      target.velocity.x += knockback.x;
      target.velocity.y += knockback.y;
      target.velocity.z += knockback.z;

      const horizontalSpeed = Math.hypot(target.velocity.x, target.velocity.z);
      if (horizontalSpeed > PLAYER.maxKnockbackSpeed) {
        const factor = PLAYER.maxKnockbackSpeed / horizontalSpeed;
        target.velocity.x *= factor;
        target.velocity.z *= factor;
      }

      this.events.push({
        type: 'hit',
        tick: this.tick,
        sourceId: intent.attackerId,
        targetId: target.id,
        amount: intent.amount,
        detail: intent.ability,
        position: { ...intent.position },
      });
    }
  }

  /** Eliminate a player exactly once; awards at most one point. */
  private eliminate(target: PlayerState, attackerId: string | null, cause: 'damage' | 'fall'): void {
    if (!target.alive) return;
    target.alive = false;
    target.health = 0;
    target.deaths += 1;
    target.respawnAtTick = this.tick + Math.ceil(PLAYER.respawnDelayMs / TICK_MS);
    target.anim = 'down';
    target.animTick = this.tick;
    target.velocity.x = 0;
    target.velocity.z = 0;
    if (cause === 'fall') target.falls += 1;

    let creditedId: string | null = null;
    if (attackerId && (SCORING.creditSelf || attackerId !== target.id)) {
      const attacker = this.getPlayer(attackerId);
      if (attacker) {
        attacker.score += SCORING.pointsPerElimination;
        attacker.eliminations += SCORING.pointsPerElimination;
        creditedId = attacker.id;
      }
    }

    this.events.push({
      type: 'elimination',
      tick: this.tick,
      sourceId: creditedId ?? undefined,
      targetId: target.id,
      cause,
      detail: creditedId ? 'credited' : 'uncredited',
      position: { ...target.position },
    });
  }

  private updateRespawns(now: number): void {
    if (this.phase !== 'combat') return;
    for (const player of this.players) {
      if (player.alive || player.respawnAtTick === null) continue;
      if (this.tick < player.respawnAtTick) continue;
      const spawn = this.pickSpawn(player);
      revivePlayer(player, spawn.position, spawn.yaw, now + PLAYER.spawnProtectionMs, now, this.tick);
      this.events.push({
        type: 'respawn',
        tick: this.tick,
        targetId: player.id,
        position: { ...spawn.position },
      });
    }
  }

  /** Safe spawn: prefer the spawn point farthest from every living enemy. */
  pickSpawn(player: PlayerState): { position: Vec3; yaw: number } {
    const enemies = this.players.filter((p) => p.id !== player.id && p.alive);
    let best = spawnPointForSlot(this.arena, player.slot);
    let bestScore = -Infinity;
    const count = this.arena.spawns.length;
    for (let i = 0; i < count; i += 1) {
      const candidate = this.arena.spawns[(i + player.slot) % count]!;
      let score = Infinity;
      for (const enemy of enemies) {
        score = Math.min(score, distance(candidate.position, enemy.position));
      }
      if (score === Infinity) score = 1000 - i;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return { position: best.position, yaw: best.yaw };
  }

  private animationFor(player: PlayerState, now: number, dodgePressed: boolean): PlayerState['anim'] {
    if (!player.alive) return 'down';
    if (player.anim === 'punch' && this.tick - player.animTick < 5) return 'punch';
    if (player.anim === 'hit' && this.tick - player.animTick < 4) return 'hit';
    if (now < player.dodgeUntil || dodgePressed) return 'dodge';
    if (!player.grounded) return player.velocity.y > 1.5 ? 'jump' : 'fall';
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    return speed > 0.6 ? 'move' : 'idle';
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  buildSnapshot(): Snapshot {
    const now = this.now;
    const events = [...this.eventBuffer];
    // A broadcast drains the buffer; intermediate inspection calls do not.
    if (this.shouldBroadcast()) this.eventBuffer.length = 0;
    return {
      tick: this.tick,
      time: now,
      phase: this.phase,
      matchRemainingMs: this.matchRemainingMs,
      countdownRemainingMs: this.countdownRemainingMs,
      players: this.players.map((p) => ({
        id: p.id,
        slot: p.slot,
        color: p.color,
        name: p.name,
        p: [round2(p.position.x), round2(p.position.y), round2(p.position.z)],
        v: [round2(p.velocity.x), round2(p.velocity.y), round2(p.velocity.z)],
        yaw: round2(p.yaw),
        pitch: round2(p.pitch),
        hp: Math.round(p.health * 10) / 10,
        en: Math.round(p.energy * 10) / 10,
        alive: p.alive,
        grounded: p.grounded,
        score: p.score,
        kills: p.eliminations,
        falls: p.falls,
        deaths: p.deaths,
        cd: [
          round2(Math.max(0, p.cooldowns.punch - now)),
          round2(Math.max(0, p.cooldowns.gravity - now)),
          round2(Math.max(0, p.cooldowns.shockwave - now)),
          round2(Math.max(0, p.cooldowns.platformBreak - now)),
        ],
        charges: p.breakCharges,
        prot: p.alive && now < p.spawnProtectionUntil,
        shieldMs: round2(Math.max(0, p.spawnProtectionUntil - now)),
        respawnInMs:
          p.alive || p.respawnAtTick === null
            ? 0
            : round2(Math.max(0, (p.respawnAtTick - this.tick) * TICK_MS)),
        anim: p.anim,
        animTick: p.animTick,
        hitTick: p.lastHitTick,
        connected: p.connected,
        bot: p.isBot,
      })),
      platforms: this.platforms.map((platform) => ({
        id: platform.id,
        state: platform.state,
        durability: platform.durability,
        maxDurability: platform.maxDurability,
        solid: isSolid(platform),
        collapseMs: round2(collapseRemainingMs(platform, this.tick, TICK_MS)),
      })),
      projectiles: this.projectiles.map((projectile) => ({
        id: projectile.id,
        ownerId: projectile.ownerId,
        color: projectile.color,
        p: [
          round2(projectile.position.x),
          round2(projectile.position.y),
          round2(projectile.position.z),
        ],
      })),
      events: events.map((event) => ({ ...event })),
    };
  }

  /** True when this tick should be broadcast (15 Hz by default). */
  shouldBroadcast(): boolean {
    return this.tick % SNAPSHOT_EVERY_TICKS === 0;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fallbackFlat(dir: Vec3): Vec3 {
  const l = Math.hypot(dir.x, dir.z);
  if (l < 1e-4) return v3(0, 0, 1);
  return { x: dir.x / l, y: 0, z: dir.z / l };
}
