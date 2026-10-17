/**
 * Small, dependency-free math helpers.
 *
 * Everything in the simulation is deliberately implemented with plain numbers
 * and objects (no Three.js, no Rapier) so the *same* code runs on the
 * authoritative server and inside the browser client. See
 * docs/TECHNICAL_DECISIONS.md for why the physics is a purpose-built
 * kinematic solver instead of a general rigid-body engine.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const VEC3_ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function len(a: Vec3): number {
  return Math.sqrt(lenSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

export function distanceSq(a: Vec3, b: Vec3): number {
  return lenSq(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const l = len(a);
  if (l < 1e-9) return v3(0, 0, 0);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

/** Clamp a magnitude without changing direction. */
export function clampLength(v: Vec3, max: number): Vec3 {
  const l = len(v);
  if (l <= max || l < 1e-9) return cloneVec(v);
  return scale(v, max / l);
}

/** Unit forward vector for a yaw/pitch pair (radians). +X at yaw 0. */
export function dirFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/** Horizontal (XZ) unit vector for a yaw angle. */
export function flatDirFromYaw(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

export interface Aabb {
  /** Center of the box. */
  center: Vec3;
  /** Full extents (width/height/depth) of the box. */
  size: Vec3;
}

export function aabbMin(box: Aabb): Vec3 {
  return {
    x: box.center.x - box.size.x / 2,
    y: box.center.y - box.size.y / 2,
    z: box.center.z - box.size.z / 2,
  };
}

export function aabbMax(box: Aabb): Vec3 {
  return {
    x: box.center.x + box.size.x / 2,
    y: box.center.y + box.size.y / 2,
    z: box.center.z + box.size.z / 2,
  };
}

export function pointInAabb(p: Vec3, box: Aabb): boolean {
  return (
    Math.abs(p.x - box.center.x) <= box.size.x / 2 &&
    Math.abs(p.y - box.center.y) <= box.size.y / 2 &&
    Math.abs(p.z - box.center.z) <= box.size.z / 2
  );
}

/** Closest point on the surface/inside of an AABB to `p`. */
export function closestPointInAabb(p: Vec3, box: Aabb): Vec3 {
  const min = aabbMin(box);
  const max = aabbMax(box);
  return {
    x: clamp(p.x, min.x, max.x),
    y: clamp(p.y, min.y, max.y),
    z: clamp(p.z, min.z, max.z),
  };
}

export interface RayHit {
  t: number;
  point: Vec3;
}

/**
 * Slab-method ray/box intersection.
 * `dir` does not need to be normalized, but `t` is expressed in units of `dir`.
 * Returns the entry distance (0 when the origin is inside the box).
 */
export function rayAabb(origin: Vec3, dir: Vec3, box: Aabb, maxDistance: number): RayHit | null {
  const min = aabbMin(box);
  const max = aabbMax(box);
  let tmin = 0;
  let tmax = maxDistance;

  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, min.x, max.x],
    [origin.y, dir.y, min.y, max.y],
    [origin.z, dir.z, min.z, max.z],
  ];

  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  return { t: tmin, point: addScaled(origin, dir, tmin) };
}

/**
 * Segment/box intersection. `t` is normalized to [0, 1] along the segment.
 */
export function segmentAabb(a: Vec3, b: Vec3, box: Aabb): RayHit | null {
  const dir = sub(b, a);
  const distance = len(dir);
  if (distance < 1e-9) return pointInAabb(a, box) ? { t: 0, point: cloneVec(a) } : null;
  const hit = rayAabb(a, dir, box, distance);
  if (!hit) return null;
  return { t: hit.t / distance, point: hit.point };
}

/**
 * Push a vertical capsule out of an AABB if it penetrates.
 * The capsule is approximated by a cylinder: radius `radius`, feet at `pos.y`,
 * head at `pos.y + height`.
 * Returns the corrected position and the dominant push axis, or null when the
 * capsule does not intersect the box.
 */
export interface CapsuleResolution {
  position: Vec3;
  /** Dominant normal of the resolution. */
  normal: Vec3;
}

export function resolveCapsuleAabb(
  pos: Vec3,
  radius: number,
  height: number,
  box: Aabb,
  maxPush = 2,
): CapsuleResolution | null {
  // Distance from the box on the vertical axis is computed against the
  // capsule's *segment* (feet -> head), so standing on a platform that is only
  // partially under the player still resolves as a ground contact.
  const feet = pos.y;
  const head = pos.y + height;
  const segY = clamp(box.center.y, feet, head);
  const closest = {
    x: clamp(pos.x, box.center.x - box.size.x / 2, box.center.x + box.size.x / 2),
    y: segY,
    z: clamp(pos.z, box.center.z - box.size.z / 2, box.center.z + box.size.z / 2),
  };

  const dx = pos.x - closest.x;
  const dz = pos.z - closest.z;
  const distSqHoriz = dx * dx + dz * dz;

  // Standing directly on top / hitting the underside: the closest point is
  // inside the capsule's XZ footprint. Resolve vertically.
  const insideX = Math.abs(pos.x - box.center.x) <= box.size.x / 2;
  const insideZ = Math.abs(pos.z - box.center.z) <= box.size.z / 2;

  if (insideX && insideZ) {
    const top = box.center.y + box.size.y / 2;
    const bottom = box.center.y - box.size.y / 2;
    const pushUp = top - feet;
    const pushDown = head - bottom;
    if (pushUp >= 0 && pushUp <= Math.min(pushDown, maxPush)) {
      return { position: v3(pos.x, top, pos.z), normal: v3(0, 1, 0) };
    }
    if (pushDown >= 0 && pushDown <= maxPush) {
      return { position: v3(pos.x, feet - pushDown, pos.z), normal: v3(0, -1, 0) };
    }
    return null;
  }

  // Outside the footprint the true closest point on the box may be above the
  // head or below the feet, so the vertical gap has to be part of the
  // distance. Without it a box is an infinitely tall column: a walkway 0.5 m
  // below the feet (or an arch overhead) would push the player sideways and
  // the arena's bridges and terraces would be impossible to walk between.
  const boxBottom = box.center.y - box.size.y / 2;
  const boxTop = box.center.y + box.size.y / 2;
  const closestY = clamp(segY, boxBottom, boxTop);
  const dy = segY - closestY;
  const distSq = distSqHoriz + dy * dy;
  if (distSq >= radius * radius) return null;

  const dist = Math.sqrt(distSq);
  const penetration = radius - dist;
  if (penetration > maxPush) return null;
  const nx = dist > 1e-6 ? dx / dist : 1;
  const ny = dist > 1e-6 ? dy / dist : 0;
  const nz = dist > 1e-6 ? dz / dist : 0;
  return {
    position: v3(pos.x + nx * penetration, pos.y + ny * penetration, pos.z + nz * penetration),
    normal: v3(nx, ny, nz),
  };
}

/** True when a segment intersects the AABB (used for melee line-of-sight). */
export function segmentBlockedByAabb(a: Vec3, b: Vec3, box: Aabb): boolean {
  return segmentAabb(a, b, box) !== null;
}

/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roundTo(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
