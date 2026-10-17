/**
 * FRACTURE — the "Sunken Causeway" arena.
 *
 * A central indestructible safe platform (always stays alive so a match can
 * never become unwinnable), four destructible outer platforms, four
 * destructible bridges connecting them, and static ruin pillars below the
 * causeway for decoration and depth.
 *
 * The arena is data only: the server builds collision from it and the client
 * builds meshes from it, which guarantees the two agree.
 */
import { PLATFORM, PLAYER } from './config.js';
import type { PlatformDef, PlatformRuntime } from './types.js';
import { v3, type Vec3 } from './math.js';

export interface SpawnPoint {
  id: string;
  position: Vec3;
  yaw: number;
}

export interface ArenaDecor {
  id: string;
  kind: 'mesa' | 'pillar' | 'arch' | 'bones';
  center: Vec3;
  size: Vec3;
  /** Yaw rotation in radians (visual only). */
  rotationY?: number;
  color?: number;
}

export interface ArenaDef {
  id: string;
  name: string;
  /** Collidable boxes. */
  platforms: PlatformDef[];
  /** Purely visual geometry (no collision). */
  decor: ArenaDecor[];
  spawns: SpawnPoint[];
  killY: number;
  /** Presentation hints consumed by the client renderer. */
  theme: {
    skyTop: number;
    skyBottom: number;
    fog: number;
    voidFloorY: number;
  };
}

function destructible(
  id: string,
  label: string,
  center: Vec3,
  size: Vec3,
): PlatformDef {
  return {
    id,
    kind: 'destructible',
    label,
    center,
    size,
    durability: PLATFORM.destructibleDurability,
  };
}

function staticBlock(id: string, label: string, center: Vec3, size: Vec3): PlatformDef {
  return { id, kind: 'static', label, center, size, durability: 0 };
}

const CENTER: PlatformDef = {
  id: 'center-safe',
  kind: 'safe',
  label: 'Sunken Causeway',
  center: v3(0, -0.5, 0),
  size: v3(16, 1, 16),
  durability: 0,
  spawn: true,
};

const OUTER_DISTANCE = 15;
const BRIDGE_TOP = -0.5;

export const ARENA: ArenaDef = {
  id: 'sunken-causeway',
  name: 'Sunken Causeway',
  platforms: [
    CENTER,

    // Destructible outer platforms (top surface at y = 0).
    destructible('north-platform', 'North Terrace', v3(0, -0.5, -OUTER_DISTANCE), v3(9, 1, 9)),
    destructible('south-platform', 'South Terrace', v3(0, -0.5, OUTER_DISTANCE), v3(9, 1, 9)),
    destructible('west-platform', 'West Terrace', v3(-OUTER_DISTANCE, -0.5, 0), v3(9, 1, 9)),
    destructible('east-platform', 'East Terrace', v3(OUTER_DISTANCE, -0.5, 0), v3(9, 1, 9)),

    // Destructible bridges spanning the gaps (slightly lower walkways).
    destructible('north-bridge', 'North Causeway', v3(0, BRIDGE_TOP - 0.4, -9.25), v3(3.4, 0.8, 5.5)),
    destructible('south-bridge', 'South Causeway', v3(0, BRIDGE_TOP - 0.4, 9.25), v3(3.4, 0.8, 5.5)),
    destructible('west-bridge', 'West Causeway', v3(-9.25, BRIDGE_TOP - 0.4, 0), v3(5.5, 0.8, 3.4)),
    destructible('east-bridge', 'East Causeway', v3(9.25, BRIDGE_TOP - 0.4, 0), v3(5.5, 0.8, 3.4)),

    // Static cover blocks on the outer terraces.
    staticBlock('north-monolith', 'North Monolith', v3(0, 1.0, -15), v3(1.6, 2, 1.6)),
    staticBlock('south-monolith', 'South Monolith', v3(0, 1.0, 15), v3(1.6, 2, 1.6)),
    staticBlock('west-monolith', 'West Monolith', v3(-15, 1.0, 0), v3(1.6, 2, 1.6)),
    staticBlock('east-monolith', 'East Monolith', v3(15, 1.0, 0), v3(1.6, 2, 1.6)),

    // Ruin pillars standing in the canyon. Their top face sits *below* the
    // kill plane on purpose: a falling player must never be able to land on
    // them and get stranded outside the play area.
    staticBlock('ruin-nw', 'North-West Ruin', v3(-11, -35, -11), v3(3, 14, 3)),
    staticBlock('ruin-ne', 'North-East Ruin', v3(11, -35, -11), v3(3, 14, 3)),
    staticBlock('ruin-sw', 'South-West Ruin', v3(-11, -35, 11), v3(3, 14, 3)),
    staticBlock('ruin-se', 'South-East Ruin', v3(11, -35, 11), v3(3, 14, 3)),
  ],
  decor: [
    { id: 'mesa-n', kind: 'mesa', center: v3(0, -52, -70), size: v3(58, 70, 44) },
    { id: 'mesa-s', kind: 'mesa', center: v3(0, -58, 78), size: v3(74, 82, 52) },
    { id: 'mesa-w', kind: 'mesa', center: v3(-82, -46, 12), size: v3(60, 60, 70) },
    { id: 'mesa-e', kind: 'mesa', center: v3(86, -50, -8), size: v3(64, 68, 76) },
    { id: 'spire-1', kind: 'pillar', center: v3(-32, -24, -30), size: v3(5, 40, 5), rotationY: 0.4 },
    { id: 'spire-2', kind: 'pillar', center: v3(30, -18, 34), size: v3(4.2, 30, 4.2), rotationY: -0.6 },
    { id: 'spire-3', kind: 'pillar', center: v3(38, -28, -26), size: v3(6, 48, 6), rotationY: 0.9 },
    { id: 'spire-4', kind: 'pillar', center: v3(-36, -22, 30), size: v3(5.4, 36, 5.4), rotationY: -0.2 },
    { id: 'arch-n', kind: 'arch', center: v3(0, 9, -26), size: v3(26, 1.6, 2.4) },
    { id: 'arch-s', kind: 'arch', center: v3(0, 9, 26), size: v3(26, 1.6, 2.4) },
  ],
  spawns: [
    { id: 'spawn-nw', position: v3(-5.6, 0.02, -5.6), yaw: Math.PI * 0.25 },
    { id: 'spawn-ne', position: v3(5.6, 0.02, -5.6), yaw: -Math.PI * 0.25 },
    { id: 'spawn-sw', position: v3(-5.6, 0.02, 5.6), yaw: (Math.PI * 3) / 4 },
    { id: 'spawn-se', position: v3(5.6, 0.02, 5.6), yaw: (-Math.PI * 3) / 4 },
  ],
  killY: PLAYER.killY,
  theme: {
    skyTop: 0x7fa9d8,
    skyBottom: 0xe8cf9c,
    fog: 0xd9c49a,
    voidFloorY: -62,
  },
};

/** Build the mutable runtime platform list for a fresh match. */
export function createPlatformRuntimes(arena: ArenaDef = ARENA): PlatformRuntime[] {
  return arena.platforms.map((def) => ({
    ...def,
    center: { ...def.center },
    size: { ...def.size },
    maxDurability: def.durability,
    state: 'INTACT' as const,
    collapseStartedTick: null,
    destroyedTick: null,
  }));
}

/**
 * Spawn points are deterministic per slot so every client sees the same
 * respawn location; the server may override the choice to prefer a point far
 * away from living enemies.
 */
export function spawnPointForSlot(arena: ArenaDef, slot: number): SpawnPoint {
  const index = ((slot % arena.spawns.length) + arena.spawns.length) % arena.spawns.length;
  return arena.spawns[index]!;
}
