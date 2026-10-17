/**
 * Kinematic player movement and collision.
 *
 * The player is a vertical cylinder (radius/height from `PLAYER`) resolved
 * against axis-aligned platform boxes. Movement is integrated in sub-steps so
 * large knockback impulses cannot tunnel through geometry, and the solver
 * returns the dominant contact normal so the caller can react (ground, ceiling,
 * wall).
 *
 * This module is shared by the authoritative server and the client's local
 * prediction, so both integrate identical maths.
 */
import { PLAYER } from '../config.js';
import {
  aabbMax,
  clamp,
  flatDirFromYaw,
  len,
  normalize,
  resolveCapsuleAabb,
  v3,
  type Vec3,
} from '../math.js';
import type { PlatformRuntime, PlayerInput, PlayerState } from '../types.js';

/** Horizontal aim/movement vector for a yaw and an input pair. */
export function wishVector(input: PlayerInput, yaw: number): Vec3 {
  const forward = flatDirFromYaw(yaw);
  // Right-hand vector: rotating `forward` -90 degrees about +Y.
  const right = { x: -forward.z, y: 0, z: forward.x };
  const wish = {
    x: forward.x * input.moveZ + right.x * input.moveX,
    y: 0,
    z: forward.z * input.moveZ + right.z * input.moveX,
  };
  const l = len(wish);
  if (l <= 1e-6) return v3(0, 0, 0);
  // Never allow a forged input to exceed unit length.
  const scale = Math.min(1, l) / l;
  return { x: wish.x * scale, y: 0, z: wish.z * scale };
}

export function canDodge(player: PlayerState, now: number): boolean {
  if (now < player.dodgeCooldownUntil) return false;
  if (!PLAYER.dodgeAirAllowed && !player.grounded) return false;
  return true;
}

/**
 * Start a dodge burst. Returns false when the dodge was rejected (cooldown or
 * airborne with air-dodging disabled). Dodges are edge-triggered by the caller.
 */
export function startDodge(player: PlayerState, input: PlayerInput, now: number): boolean {
  if (!canDodge(player, now)) return false;
  const wish = wishVector(input, player.yaw);
  const dir = len(wish) > 0.1 ? normalize(wish) : flatDirFromYaw(player.yaw);
  player.dodgeDir = dir;
  player.dodgeUntil = now + PLAYER.dodgeDurationMs;
  player.dodgeCooldownUntil = now + PLAYER.dodgeCooldownMs;
  player.velocity.x = dir.x * PLAYER.dodgeSpeed;
  player.velocity.z = dir.z * PLAYER.dodgeSpeed;
  player.velocity.y = Math.max(player.velocity.y, 0) + PLAYER.dodgeUpVel;
  player.grounded = false;
  return true;
}

export function isDodging(player: PlayerState, now: number): boolean {
  return now < player.dodgeUntil;
}

/**
 * Apply the pending jump when the player is grounded (or within the coyote
 * window) and a jump was pressed recently (input buffering).
 */
export function tryJump(player: PlayerState, now: number): boolean {
  if (now > player.jumpBufferUntil) return false;
  const withinCoyote = now - player.lastGroundedAt <= PLAYER.coyoteTimeMs;
  if (!player.grounded && !withinCoyote) return false;
  if (player.jumpCount >= 1 + PLAYER.maxAirJumps) return false;

  player.velocity.y = PLAYER.jumpSpeed;
  player.jumpCount += 1;
  player.grounded = false;
  player.lastGroundedAt = -Infinity;
  player.jumpBufferUntil = 0;
  player.jumpCutDone = false;
  return true;
}

/**
 * Variable jump height: when the jump button is released while rising, cut the
 * upward velocity once per jump. Never applied while the button is held.
 */
export function releaseJumpIfNeeded(player: PlayerState, input: PlayerInput, now: number): void {
  if (input.jump || player.jumpCutDone) return;
  if (player.jumpCount <= 0) return;
  if (player.velocity.y <= 0) return;
  if (now - player.lastGroundedAt > 600) return;
  player.velocity.y *= 0.55;
  player.jumpCutDone = true;
}

export interface MoveResult {
  /** True when the body touched a surface during integration. */
  collided: boolean;
}

const GROUND_PROBE = 0.09;
const SNAP_MAX = 0.14;
/**
 * Tallest ledge a grounded player walks up instead of being stopped by it.
 * The causeway bridges sit 0.5 m below the terraces and the centre platform, so
 * every platform transition in the arena is a step of exactly that size.
 */
const STEP_UP_MAX = 0.66;

/** Move one kinematic body through `dt` seconds and resolve platform contacts. */
export function moveAndCollide(
  player: PlayerState,
  solids: PlatformRuntime[],
  dt: number,
): MoveResult {
  let collided = false;
  const speed = len(player.velocity);
  const distance = speed * dt;
  const steps = clamp(Math.ceil(distance / PLAYER.maxStepDistance), 1, 8);
  const sub = dt / steps;

  for (let step = 0; step < steps; step += 1) {
    player.position.x += player.velocity.x * sub;
    player.position.y += player.velocity.y * sub;
    player.position.z += player.velocity.z * sub;

    for (const platform of solids) {
      const resolution = resolveCapsuleAabb(
        player.position,
        PLAYER.radius,
        PLAYER.height,
        platform,
      );
      if (!resolution) continue;
      collided = true;
      player.position = resolution.position;
      const n = resolution.normal;
      if (n.y > 0.6) {
        if (player.velocity.y < 0) player.velocity.y = 0;
      } else if (n.y < -0.6) {
        if (player.velocity.y > 0) player.velocity.y = 0;
      } else {
        // Horizontal contact. Before treating it as a wall, check whether it is
        // a low step we can simply walk up — that is what makes the bridges and
        // the outer terraces reachable at all.
        const stepTop = aabbMax(platform).y;
        const rise = stepTop - player.position.y;
        if (player.grounded && rise > 0.02 && rise <= STEP_UP_MAX) {
          const towardX = platform.center.x - player.position.x;
          const towardZ = platform.center.z - player.position.z;
          const movingIn = player.velocity.x * towardX + player.velocity.z * towardZ > 0;
          const towardLength = Math.hypot(towardX, towardZ);
          if (movingIn && towardLength > 1e-4) {
            // Lift onto the surface and step just inside its footprint, where
            // the next resolution snaps the body cleanly onto the top face.
            const stepIn = Math.min(PLAYER.radius + 0.06, towardLength);
            player.position.y = stepTop;
            player.position.x += (towardX / towardLength) * stepIn;
            player.position.z += (towardZ / towardLength) * stepIn;
            if (player.velocity.y < 0) player.velocity.y = 0;
            continue;
          }
        }
        const along = player.velocity.x * n.x + player.velocity.z * n.z;
        if (along < 0) {
          player.velocity.x -= n.x * along;
          player.velocity.z -= n.z * along;
        }
      }
    }
  }

  // Ground probe: keeps `grounded` stable while walking and prevents the
  // player from floating a few millimetres above a surface.
  let grounded = false;
  if (player.velocity.y <= 0.001) {
    const probePos = v3(player.position.x, player.position.y - GROUND_PROBE, player.position.z);
    for (const platform of solids) {
      const resolution = resolveCapsuleAabb(probePos, PLAYER.radius, PLAYER.height, platform);
      if (!resolution || resolution.normal.y <= 0.6) continue;
      const drop = resolution.position.y - player.position.y;
      // Only a surface within the snap window counts as ground. Anything lower
      // (a bridge 0.5 m below the terrace) must be fallen onto rather than
      // hovered above, so keep looking instead of claiming a contact.
      if (drop < -0.01 || drop > SNAP_MAX) continue;
      player.position.y = resolution.position.y;
      if (player.velocity.y < 0) player.velocity.y = 0;
      grounded = true;
      collided = true;
      break;
    }
  }

  player.grounded = grounded;
  return { collided };
}

/**
 * Full movement step for one player: aim, dodge burst, acceleration, friction,
 * gravity and collision. `input` must already be validated/clamped.
 */
export function stepPlayerMovement(
  player: PlayerState,
  input: PlayerInput,
  solids: PlatformRuntime[],
  now: number,
  dtMs: number,
): void {
  const dt = dtMs / 1000;

  // Aim is always applied so a downed player's camera still tracks the input.
  player.yaw = input.yaw;
  player.pitch = clamp(input.pitch, PLAYER.pitchMin, PLAYER.pitchMax);

  if (!player.alive) {
    player.velocity.x = 0;
    player.velocity.z = 0;
    player.grounded = false;
    return;
  }

  const dodging = isDodging(player, now);

  if (!dodging) {
    const wish = wishVector(input, player.yaw);
    const wishStrength = len(wish);
    const maxSpeed = player.grounded ? PLAYER.moveSpeed : PLAYER.airMoveSpeed;
    const accel = player.grounded ? PLAYER.groundAccel : PLAYER.airAccel;

    if (wishStrength > 0.02) {
      const targetX = wish.x * maxSpeed;
      const targetZ = wish.z * maxSpeed;
      const deltaX = targetX - player.velocity.x;
      const deltaZ = targetZ - player.velocity.z;
      const deltaLen = Math.hypot(deltaX, deltaZ);
      const maxDelta = accel * dt;
      if (deltaLen > 1e-6) {
        const factor = Math.min(1, maxDelta / deltaLen);
        player.velocity.x += deltaX * factor;
        player.velocity.z += deltaZ * factor;
      }
    } else if (player.grounded) {
      const damping = Math.max(0, 1 - PLAYER.groundFriction * dt);
      player.velocity.x *= damping;
      player.velocity.z *= damping;
      if (Math.abs(player.velocity.x) < 0.02) player.velocity.x = 0;
      if (Math.abs(player.velocity.z) < 0.02) player.velocity.z = 0;
    } else {
      const damping = Math.max(0, 1 - PLAYER.airDrag * dt);
      player.velocity.x *= damping;
      player.velocity.z *= damping;
    }
  }

  // Gravity.
  player.velocity.y += PLAYER.gravity * dt;
  if (player.velocity.y < PLAYER.maxFallSpeed) player.velocity.y = PLAYER.maxFallSpeed;

  moveAndCollide(player, solids, dt);

  if (player.grounded) {
    player.lastGroundedAt = now;
    player.jumpCount = 0;
  }
}
