/**
 * FRACTURE — server-controlled fighters (matchmaking bots).
 *
 * A bot is a normal `PlayerState` driven by a `BotBrain`. The brain reads the
 * authoritative simulation (never a snapshot) and answers with a `PlayerInput`
 * exactly like a client would — movement intent, aim angles and one-tick button
 * pulses. It can therefore never do anything a human could not do: there is no
 * teleporting, no extra damage and no ignoring of cooldowns.
 *
 * The "ultra" tier is deliberately competent rather than dumb fodder:
 *
 *  - **Predictive aim.** It leads a moving target by the real travel time of
 *    whichever attack it is about to use, and turns at a bounded rate.
 *  - **Verified attacks.** Punch and Gravity Shot only fire when the *engine's
 *    own* targeting functions confirm the shot would connect, so bots do not
 *    spray punches into thin air.
 *  - **Orbital spacing.** It holds a punch-trading distance and circles rather
 *    than charging head-on, breaking off to retreat below ~1/3 health.
 *  - **Edge safety.** Every footstep is probed for ground; the bot slides along
 *    ledges instead of walking into the canyon.
 *  - **Structural play.** If you are standing on a destructible platform that
 *    is weak, or near one of its edges, it aims at the structure and saws it
 *    out from under you — but never saws the platform it is standing on.
 *  - **Reactions.** It sidesteps telegraphed punches and incoming Gravity
 *    Shots with a Dodge, and abandons platforms that are about to collapse.
 *
 * Everything is deterministic: no `Math.random`, no wall-clock time, no
 * floating-point ordering hazards. The same state always yields the same input
 * stream, which keeps the simulation reproducible in tests.
 */
import { BOT, GRAVITY_SHOT, PLATFORM_BREAK, PLAYER, SHOCKWAVE, TICK_MS } from '../config.js';
import {
  addScaled,
  clamp,
  dirFromYawPitch,
  dot,
  flatDirFromYaw,
  len,
  normalize,
  sub,
  v3,
  type Vec3,
} from '../math.js';
import type { PlayerInput, PlayerState, PlatformRuntime, Projectile } from '../types.js';
import { emptyInput } from '../types.js';
import { isBreakable, isSolid } from '../rules/platforms.js';
import {
  findBreakTarget,
  findPunchTargets,
  findShockwaveTargets,
  playerCenter,
  playerEye,
  segmentBlocked,
  sweepProjectileForPlayer,
} from '../rules/targeting.js';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface BotProfile {
  id: string;
  /** Display name shown in the scoreboard and kill feed. */
  name: string;
  /** 0..1 — how eagerly the bot commits to attacks. */
  aggression: number;
  /** Multiplier applied to the base aim turn rate. */
  turn: number;
  /** 0..1 — probability of reacting to a telegraphed attack. */
  dodgeSkill: number;
  /** Deterministic seed for aim sway and strafe offsets. */
  seed: number;
}

/** The roster used to fill an arena. All entries are tuned at the ultra tier. */
export const ULTRA_BOTS: readonly BotProfile[] = [
  { id: 'vane', name: 'Vane', aggression: 0.92, turn: 1.15, dodgeSkill: 0.92, seed: 911 },
  { id: 'krait', name: 'Krait', aggression: 0.85, turn: 1.0, dodgeSkill: 0.84, seed: 4242 },
  { id: 'oracle', name: 'Oracle', aggression: 0.78, turn: 1.06, dodgeSkill: 0.9, seed: 1337 },
  { id: 'sable', name: 'Sable', aggression: 0.88, turn: 1.1, dodgeSkill: 0.86, seed: 7777 },
  { id: 'halcyon', name: 'Halcyon', aggression: 0.82, turn: 1.02, dodgeSkill: 0.88, seed: 2024 },
  { id: 'ravel', name: 'Ravel', aggression: 0.9, turn: 1.12, dodgeSkill: 0.8, seed: 5150 },
] as const;

/** Deterministic profile lookup for the n-th bot spawned in a room. */
export function botProfileFor(index: number): BotProfile {
  const size = ULTRA_BOTS.length;
  return ULTRA_BOTS[((index % size) + size) % size]!;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface BotThinkContext {
  /** The fighter being controlled. */
  self: PlayerState;
  /** Every player in the match, including `self`. */
  players: PlayerState[];
  /** Mutable platform state (durability + collapse progress). */
  platforms: PlatformRuntime[];
  /** Live projectiles, used for evasive dodges. */
  projectiles: Projectile[];
  /** Simulation tick (30 Hz). */
  tick: number;
  /** Simulation time in milliseconds (`tick * TICK_MS`). */
  now: number;
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

export class BotBrain {
  readonly profile: BotProfile;

  private targetId: string | null = null;
  private targetSince = -999;
  private strafeDir = 1;
  private strafeFlipTick = 0;
  private jumpHold = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private initialised = false;

  constructor(profile: BotProfile) {
    this.profile = profile;
    this.strafeDir = profile.seed % 2 === 0 ? 1 : -1;
  }

  /** Clear per-match state so a rematch starts from a clean slate. */
  reset(): void {
    this.targetId = null;
    this.targetSince = -999;
    this.strafeFlipTick = 0;
    this.strafeDir = this.profile.seed % 2 === 0 ? 1 : -1;
    this.jumpHold = 0;
    this.initialised = false;
  }

  /** Produce this tick's input. Pure with respect to the simulation. */
  think(ctx: BotThinkContext): PlayerInput {
    const { self, tick } = ctx;
    const input = emptyInput(tick);
    const solids = ctx.platforms.filter(isSolid);

    if (!this.initialised) {
      this.aimYaw = self.yaw;
      this.aimPitch = self.pitch;
      this.initialised = true;
      this.strafeFlipTick = tick;
    }

    if (!self.alive) {
      input.yaw = wrapAngle(this.aimYaw);
      input.pitch = this.aimPitch;
      this.jumpHold = 0;
      return input;
    }

    const enemies = ctx.players.filter(
      (player) => player.id !== self.id && player.alive && player.connected,
    );
    const target = this.selectTarget(ctx, enemies, solids);

    const eye = playerEye(self);

    if (!target) {
      // Nothing to fight (lobby, countdown, or a momentarily empty arena):
      // hold position, keep the crosshair level and stay off the edge.
      const held = this.safeStep(ctx, self, v3(0, 0, 0), solids);
      applyWish(input, held, this.aimYaw);
      input.yaw = wrapAngle(this.aimYaw);
      input.pitch = this.aimPitch;
      return input;
    }

    const chest = playerCenter(target);
    const range = len(sub(chest, eye));
    const flatRange = Math.hypot(chest.x - eye.x, chest.z - eye.z);
    const visible = !segmentBlocked(eye, chest, solids);

    // Aim: lead the target by the travel time of the attack we would use.
    let aimPoint = addScaled(chest, target.velocity, this.leadTimeFor(range));
    const breakPlan = this.planPlatformBreak(ctx, self, target, solids, range);
    if (breakPlan) aimPoint = breakPlan.center;

    this.turnTo(eye, aimPoint, TICK_MS / 1000);
    input.yaw = this.aimWithSway(tick);
    input.pitch = this.aimPitch;

    const aimDir = dirFromYawPitch(input.yaw, input.pitch);
    const isProtected = (player: PlayerState) => ctx.now < player.spawnProtectionUntil;

    // ------------------------------------------------------------ abilities
    if (visible && ctx.now >= self.cooldowns.punch) {
      const hits = findPunchTargets(eye, aimDir, self.id, ctx.players, solids, isProtected);
      if (hits.length > 0) input.punch = true;
    }

    if (
      !input.punch &&
      ctx.now >= self.cooldowns.gravity &&
      self.energy >= GRAVITY_SHOT.energyCost &&
      range > BOT.engageRange * 1.6 &&
      range <= GRAVITY_SHOT.maxRange
    ) {
      const muzzle = addScaled(eye, aimDir, GRAVITY_SHOT.muzzleOffset);
      const end = addScaled(muzzle, aimDir, GRAVITY_SHOT.maxRange);
      const struck = sweepProjectileForPlayer(
        muzzle,
        end,
        GRAVITY_SHOT.radius,
        self.id,
        ctx.players,
        isProtected,
      );
      if (struck?.id === target.id && !segmentBlocked(eye, chest, solids)) input.gravity = true;
    }

    const healthRatio = self.health / PLAYER.maxHealth;
    if (!input.punch && !input.gravity && ctx.now >= self.cooldowns.shockwave && self.energy >= SHOCKWAVE.energyCost) {
      const caught = findShockwaveTargets(self, ctx.players, isProtected);
      const worthIt =
        caught.length >= 2 ||
        (caught.length >= 1 && (healthRatio < 0.62 || caught.some((p) => p.health <= SHOCKWAVE.damage)));
      if (worthIt) input.shockwave = true;
    }

    if (
      breakPlan &&
      !input.punch &&
      !input.gravity &&
      !input.shockwave &&
      self.breakCharges > 0 &&
      ctx.now >= self.cooldowns.platformBreak
    ) {
      const struck = findBreakTarget(eye, aimDir, ctx.platforms);
      if (struck?.id === breakPlan.id) input.breakPlatform = true;
    }

    // ------------------------------------------------------------- movement
    const underSelf = platformUnder(self.position, solids);
    const standingOnRuin =
      underSelf !== null && (underSelf.state === 'CRITICAL' || underSelf.state === 'COLLAPSING');

    const forwardFlat = normalize(v3(chest.x - eye.x, 0, chest.z - eye.z));
    const sideways = v3(-forwardFlat.z, 0, forwardFlat.x);
    if (tick >= this.strafeFlipTick) {
      this.strafeDir = -this.strafeDir;
      this.strafeFlipTick = tick + BOT.strafePeriodTicks + (this.profile.seed % 13);
    }

    const retreating = healthRatio < BOT.retreatHealth;

    let wish: Vec3;
    if (standingOnRuin) {
      // Get off the platform that is about to disappear before anything else.
      const safe = safestGround(ctx, self, solids);
      wish = normalize(v3(safe.x - self.position.x, 0, safe.z - self.position.z));
    } else if (retreating) {
      const safe = safestGround(ctx, self, solids);
      wish = addScaled(
        normalize(v3(safe.x - self.position.x, 0, safe.z - self.position.z)),
        sideways,
        this.strafeDir * 0.5,
      );
    } else if (!visible || flatRange > BOT.approachRange) {
      // Close the distance, drifting slightly off the straight line.
      wish = addScaled(forwardFlat, sideways, this.strafeDir * 0.4);
    } else if (flatRange < BOT.engageRange * 0.8) {
      // Too close to punch cleanly: give a little ground while orbiting.
      wish = addScaled(scaleVector(forwardFlat, -0.6), sideways, this.strafeDir * 0.8);
    } else {
      // In the pocket — orbit the target and keep the crosshair on it.
      wish = normalize(addScaled(sideways, forwardFlat, 0.35 * this.strafeDir));
    }

    wish = this.safeStep(ctx, self, wish, solids);
    input.jump = this.wantsJump(ctx, self, wish, solids);
    applyWish(input, wish, input.yaw);

    // --------------------------------------------------------------- dodge
    if (self.grounded && ctx.now >= self.dodgeCooldownUntil && this.shouldDodge(ctx, self, enemies)) {
      input.dodge = true;
    }

    return input;
  }

  // -------------------------------------------------------------------------
  // Targeting
  // -------------------------------------------------------------------------

  private selectTarget(
    ctx: BotThinkContext,
    enemies: PlayerState[],
    solids: PlatformRuntime[],
  ): PlayerState | null {
    if (enemies.length === 0) return null;

    const current = this.targetId ? enemies.find((enemy) => enemy.id === this.targetId) : undefined;
    if (current && ctx.tick - this.targetSince < BOT.retargetTicks) return current;

    const eye = playerEye(ctx.self);
    let best: PlayerState | null = null;
    let bestScore = -Infinity;
    for (const enemy of enemies) {
      const range = len(sub(enemy.position, ctx.self.position));
      let score = 12 / (range + 4);
      score += (1 - enemy.health / PLAYER.maxHealth) * 0.8;
      if (enemy.id === this.targetId) score += 0.35;
      if (!segmentBlocked(eye, playerCenter(enemy), solids)) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = enemy;
      }
    }

    if (best && best.id !== this.targetId) {
      this.targetId = best.id;
      this.targetSince = ctx.tick;
    }
    return best;
  }

  /** Fraction of the true travel time the bot actually leads by. */
  private leadTimeFor(range: number): number {
    const usesProjectile = range > BOT.engageRange * 1.6 && range <= GRAVITY_SHOT.maxRange;
    const speed = usesProjectile ? GRAVITY_SHOT.speed : PLAYER.moveSpeed + PLAYER.dodgeSpeed;
    return (range / speed) * 0.85;
  }

  // -------------------------------------------------------------------------
  // Aiming
  // -------------------------------------------------------------------------

  private turnTo(eye: Vec3, point: Vec3, dt: number): void {
    const dir = normalize(sub(point, eye));
    if (len(dir) < 0.5) return;
    const yawTarget = Math.atan2(-dir.x, -dir.z);
    const pitchTarget = Math.asin(clamp(dir.y, -1, 1));

    const maxTurn = BOT.turnRate * this.profile.turn * dt;
    this.aimYaw = wrapAngle(
      this.aimYaw + clamp(wrapAngle(yawTarget - this.aimYaw), -maxTurn, maxTurn),
    );
    this.aimPitch = clamp(
      this.aimPitch + clamp(pitchTarget - this.aimPitch, -maxTurn, maxTurn),
      PLAYER.pitchMin,
      PLAYER.pitchMax,
    );
  }

  /** Tiny deterministic hand tremor so the bot is hard but not mathematically perfect. */
  private aimWithSway(tick: number): number {
    const amplitude = BOT.aimErrorRad * (1 - this.profile.aggression * 0.4);
    return wrapAngle(this.aimYaw + Math.sin((tick + this.profile.seed) * 0.11) * amplitude);
  }

  // -------------------------------------------------------------------------
  // Structural play
  // -------------------------------------------------------------------------

  /**
   * Decide whether the platform under the *enemy* is worth sawing out. The
   * caller aims at the returned platform instead of the fighter.
   */
  private planPlatformBreak(
    ctx: BotThinkContext,
    self: PlayerState,
    target: PlayerState,
    solids: PlatformRuntime[],
    range: number,
  ): PlatformRuntime | null {
    if (self.breakCharges <= 0) return null;
    if (ctx.now < self.cooldowns.platformBreak) return null;
    if (range > PLATFORM_BREAK.range * 0.9) return null;
    if (!self.grounded) return null;

    const underTarget = platformUnder(target.position, solids);
    if (!underTarget || !isBreakable(underTarget)) return null;

    const underSelf = platformUnder(self.position, solids);
    if (underSelf && underSelf.id === underTarget.id) return null;

    const durabilityRatio = underTarget.durability / Math.max(1, underTarget.maxDurability);
    const targetFromEdge = edgeDistance(target.position, underTarget);
    // Only worth the charge when the structure is already weakened or the
    // victim is standing close enough to the rim to be dropped by the removal.
    if (durabilityRatio > 0.7 && targetFromEdge > 1.6) return null;
    return underTarget;
  }

  // -------------------------------------------------------------------------
  // Ground awareness
  // -------------------------------------------------------------------------

  /**
   * Keep every step over solid ground: probe the intended direction, then slide
   * along the ledge, then step back, then stand still. Airborne movement is
   * untouched — mid-flight steering is what gets a fighter back onto a bridge.
   */
  private safeStep(
    ctx: BotThinkContext,
    self: PlayerState,
    wish: Vec3,
    solids: PlatformRuntime[],
  ): Vec3 {
    const magnitude = len(wish);
    if (!self.grounded || magnitude < 0.02) return wish;

    const dir = normalize(wish);
    const ahead = BOT.edgeProbeDistance;
    if (this.hasSupport(probePoint(self.position, dir, ahead), self.position.y, solids)) {
      return wish;
    }

    const slideA = v3(-dir.z, 0, dir.x);
    const slideB = v3(dir.z, 0, -dir.x);
    if (this.hasSupport(probePoint(self.position, slideA, ahead), self.position.y, solids)) {
      return scaleVector(slideA, magnitude);
    }
    if (this.hasSupport(probePoint(self.position, slideB, ahead), self.position.y, solids)) {
      return scaleVector(slideB, magnitude);
    }

    const back = v3(-dir.x, 0, -dir.z);
    if (this.hasSupport(probePoint(self.position, back, ahead * 0.75), self.position.y, solids)) {
      return scaleVector(back, magnitude);
    }
    return v3(0, 0, 0);
  }

  private hasSupport(point: Vec3, feetY: number, solids: PlatformRuntime[]): boolean {
    const slack = PLAYER.radius * 0.7;
    for (const platform of solids) {
      const top = platform.center.y + platform.size.y / 2;
      if (top > feetY + 0.8) continue;
      if (top < feetY - BOT.supportTolerance) continue;
      if (Math.abs(point.x - platform.center.x) > platform.size.x / 2 + slack) continue;
      if (Math.abs(point.z - platform.center.z) > platform.size.z / 2 + slack) continue;
      return true;
    }
    return false;
  }

  /** Hop across a short gap when there is solid ground just past it. */
  private wantsJump(
    ctx: BotThinkContext,
    self: PlayerState,
    wish: Vec3,
    solids: PlatformRuntime[],
  ): boolean {
    if (!self.grounded) {
      this.jumpHold = 0;
      return false;
    }
    if (this.jumpHold > 0) {
      this.jumpHold -= 1;
      return true;
    }
    if (len(wish) < 0.15) return false;

    const dir = normalize(wish);
    const near = this.hasSupport(probePoint(self.position, dir, 1.0), self.position.y, solids);
    const far = this.hasSupport(probePoint(self.position, dir, 2.6), self.position.y, solids);
    if (!near && far) {
      this.jumpHold = BOT.jumpHoldTicks;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  private shouldDodge(ctx: BotThinkContext, self: PlayerState, enemies: PlayerState[]): boolean {
    const reaction = deterministicRoll(ctx.tick + this.profile.seed);
    if (reaction > this.profile.dodgeSkill) return false;

    for (const projectile of ctx.projectiles) {
      if (projectile.ownerId === self.id) continue;
      const toSelf = sub(playerCenter(self), projectile.position);
      const range = len(toSelf);
      if (range > BOT.dodgeProjectileRange || range < 0.001) continue;
      const heading = normalize(projectile.velocity);
      // Already past us? Then it is no longer a threat.
      if (dot(heading, normalize(toSelf)) > 0.9) return true;
    }

    for (const enemy of enemies) {
      if (len(sub(enemy.position, self.position)) > BOT.dodgePunchRange) continue;
      if (enemy.anim !== 'punch') continue;
      if (ctx.tick - enemy.animTick > 4) continue;
      return true;
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turn a world-space wish vector into the local moveX/moveZ the solver wants. */
function applyWish(input: PlayerInput, wish: Vec3, yaw: number): void {
  const forward = flatDirFromYaw(yaw);
  const right = v3(-forward.z, 0, forward.x);
  input.moveX = clamp(dot(wish, right), -1, 1);
  input.moveZ = clamp(dot(wish, forward), -1, 1);
}

/** The solid platform directly beneath `point` (feet), or null. */
function platformUnder(point: Vec3, solids: PlatformRuntime[]): PlatformRuntime | null {
  let best: PlatformRuntime | null = null;
  let bestTop = -Infinity;
  for (const platform of solids) {
    const top = platform.center.y + platform.size.y / 2;
    if (top > point.y + 0.45) continue;
    if (top < point.y - BOT.supportTolerance) continue;
    if (Math.abs(point.x - platform.center.x) > platform.size.x / 2 + PLAYER.radius) continue;
    if (Math.abs(point.z - platform.center.z) > platform.size.z / 2 + PLAYER.radius) continue;
    if (top > bestTop) {
      bestTop = top;
      best = platform;
    }
  }
  return best;
}

/** Distance from a point to the nearest XZ edge of a platform (negative outside). */
function edgeDistance(point: Vec3, platform: PlatformRuntime): number {
  const dx = platform.size.x / 2 - Math.abs(point.x - platform.center.x);
  const dz = platform.size.z / 2 - Math.abs(point.z - platform.center.z);
  return Math.min(dx, dz);
}

/** The middle of the safe (indestructible) platform — the always-valid refuge. */
function safestGround(ctx: BotThinkContext, self: PlayerState, solids: PlatformRuntime[]): Vec3 {
  const safe = solids.find((platform) => platform.kind === 'safe');
  if (!safe) return v3(self.position.x, self.position.y, self.position.z);
  return v3(safe.center.x, safe.center.y + safe.size.y / 2, safe.center.z);
}

function probePoint(from: Vec3, dir: Vec3, distance: number): Vec3 {
  return v3(from.x + dir.x * distance, from.y, from.z + dir.z * distance);
}

function scaleVector(v: Vec3, s: number): Vec3 {
  return v3(v.x * s, v.y * s, v.z * s);
}

/** Wrap an angle into [-PI, PI]. */
function wrapAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

/** Deterministic pseudo-random number in [0, 1) derived from a single integer. */
function deterministicRoll(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
