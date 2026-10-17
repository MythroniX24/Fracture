/**
 * FRACTURE — single shared gameplay configuration.
 *
 * Every tunable number lives here so balance can be adjusted without
 * refactoring gameplay code. The authoritative server and the client both
 * import this module, which keeps the HUD, the prediction code and the server
 * simulation in agreement about costs, cooldowns and timings.
 */

// ---------------------------------------------------------------------------
// Simulation & networking rates
// ---------------------------------------------------------------------------

/** Authoritative simulation frequency. */
export const TICK_RATE = 30;
/** Milliseconds per simulation tick. */
export const TICK_MS = 1000 / TICK_RATE;
/** Snapshots broadcast per second. */
export const SNAPSHOT_RATE = 15;
/** Ticks between two state broadcasts. */
export const SNAPSHOT_EVERY_TICKS = TICK_RATE / SNAPSHOT_RATE;
/** Hard cap on the input messages accepted from a single client per second. */
export const MAX_INPUT_MESSAGES_PER_SECOND = 45;
/** Hard cap on a single inbound message size in bytes. */
export const MAX_MESSAGE_BYTES = 2048;
/** Server ping cadence for dead-connection detection. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A socket that misses this many heartbeats is treated as disconnected. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Match & room lifecycle
// ---------------------------------------------------------------------------

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
/** Full match length in milliseconds (5 minutes). */
export const MATCH_DURATION_MS = 5 * 60 * 1000;
/** Visible countdown before the arena goes live. */
export const COUNTDOWN_MS = 3_000;
/** How long a disconnected player keeps their slot. */
export const RECONNECT_WINDOW_MS = 20_000;
/** An empty/abandoned room is destroyed after this long. */
export const ROOM_TTL_MS = 30_000;
/** Finished matches are torn down after this long. */
export const RESULTS_LINGER_MS = 10 * 60 * 1000;
/** Room code alphabet: no I/O/0/1 to avoid reading mistakes. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------

export const MATCHMAKING = {
  /**
   * How long a lone human waits for a real opponent before the server fills the
   * arena with bots and starts the match anyway. Nobody ever has to sit in an
   * empty lobby.
   */
  botFillDelayMs: 15_000,
  /**
   * Total number of fighters the arena is topped up to. Deliberately one below
   * `MAX_PLAYERS` so a friend can still join a match that is already running.
   */
  fillToPlayers: MAX_PLAYERS - 1,
} as const;

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/**
 * Tuning for the server-side fighters used when matchmaking finds nobody.
 *
 * These are "ultra" tier: they track with predictive aim, orbit instead of
 * charging in a straight line, dodge telegraphed punches and incoming Gravity
 * Shots, never walk off an edge, and break the platform you are standing on.
 * All values live here so difficulty can be tuned without touching the AI.
 */
export const BOT = {
  /** Maximum aim rotation in radians per second. */
  turnRate: 9.5,
  /** Residual aim error in radians (the bot is not literally aimbot-perfect). */
  aimErrorRad: 0.03,
  /** Distance the bot tries to hold while trading punches (m). */
  engageRange: 1.6,
  /** Beyond this distance the bot walks the target down (m). */
  approachRange: 3.4,
  /** Health ratio below which the bot breaks off and retreats (0..1). */
  retreatHealth: 0.34,
  /** How far ahead the ground probe looks before accepting a move (m). */
  edgeProbeDistance: 1.6,
  /** Vertical tolerance when probing for ground under a footstep (m). */
  supportTolerance: 3.0,
  /** Ticks a jump is held so the hop reaches full height. */
  jumpHoldTicks: 7,
  /** How often the orbital strafe direction flips (ticks). */
  strafePeriodTicks: 38,
  /** Projectiles closer than this trigger an evasive dodge (m). */
  dodgeProjectileRange: 9,
  /** A punch wind-up inside this range triggers an evasive dodge (m). */
  dodgePunchRange: 3.2,
  /** Tie-break window before re-evaluating the current target (ticks). */
  retargetTicks: 45,
} as const;

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const PLAYER = {
  /** Collision cylinder radius (metres). */
  radius: 0.45,
  /** Collision cylinder height (metres). */
  height: 1.7,
  /** Camera/aim origin above the feet (metres). */
  eyeHeight: 1.5,
  maxHealth: 100,
  maxEnergy: 100,
  /** Energy regained per second. */
  energyRegenPerSecond: 8,
  /** Ground movement speed (m/s). */
  moveSpeed: 7.6,
  /** Maximum horizontal speed while airborne (m/s). */
  airMoveSpeed: 6.8,
  /** Ground acceleration (m/s^2). */
  groundAccel: 70,
  /** Air acceleration (m/s^2). */
  airAccel: 26,
  /** Ground friction (1/s). */
  groundFriction: 12,
  /** Air drag (1/s) — intentionally low so knockback carries. */
  airDrag: 0.35,
  /** Gravitational acceleration (m/s^2, negative is down). */
  gravity: -26,
  /** Terminal downward velocity (m/s). */
  maxFallSpeed: -46,
  /** Vertical launch speed of a jump (m/s). */
  jumpSpeed: 9.4,
  /** Multiplier applied to a jump issued within the coyote window. */
  coyoteTimeMs: 110,
  /** Grace period that still accepts a jump after leaving a ledge. */
  jumpBufferMs: 120,
  /** Maximum number of consecutive ground jumps (no infinite air jumps). */
  maxAirJumps: 0,
  /** Horizontal speed of a dodge burst (m/s). */
  dodgeSpeed: 17,
  /** Dodge burst duration (ms). */
  dodgeDurationMs: 220,
  /** Dodge cooldown (ms). */
  dodgeCooldownMs: 1200,
  /** Dodges are grounded-only (documented default; predictable movement). */
  dodgeAirAllowed: false,
  /** Vertical velocity applied after a dodge to avoid sliding off ledges flat. */
  dodgeUpVel: 1.2,
  /** Delay before a downed player respawns (ms). */
  respawnDelayMs: 3000,
  /** Invulnerability window after respawning (ms). */
  spawnProtectionMs: 1500,
  /** Fastest a player can be pushed by external forces (m/s). */
  maxKnockbackSpeed: 32,
  /** Any player whose feet fall below this Y is eliminated. */
  killY: -25,
  /** Vertical look clamp (radians). */
  pitchMin: -1.45,
  pitchMax: 1.45,
  /** Maximum speed the server will ever integrate in a single step. */
  maxStepDistance: 1.2,
  /** Name constraints. */
  nameMaxLength: 14,
  nameMinLength: 1,
} as const;

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

/** Punch — the only free ability. */
export const PUNCH = {
  cooldownMs: 450,
  damage: 15,
  /** Reach measured from the attacker's centre (metres). */
  range: 2.2,
  /** cos(half-angle) of the allowed targeting cone. */
  coneCos: 0.55,
  /** Impulse speed applied to a hit target (m/s). */
  knockback: 8.5,
  knockbackUp: 3.4,
  /** Wind-up before the hit resolves — gives the target a readable tell. */
  windupMs: 120,
  energyCost: 0,
  /** Attack reach is measured from the eye, along the aim direction. */
  originHeight: 1.2,
  /** Maximum number of targets damaged by a single activation. */
  maxTargets: 1,
} as const;

/** Gravity Shot — server-validated projectile that pulls the target in. */
export const GRAVITY_SHOT = {
  cooldownMs: 4000,
  damage: 8,
  energyCost: 25,
  /** Projectile speed (m/s). */
  speed: 26,
  /** Projectile radius (m). */
  radius: 0.42,
  /** Maximum travel distance (m) — also enforced through `lifetimeMs`. */
  maxRange: 12,
  /** Hard lifetime (ms). */
  lifetimeMs: 600,
  /** Impulse that yanks the target toward the attacker (m/s). */
  pullImpulse: 11.5,
  pullUp: 3.0,
  /** Spawn offset so the projectile does not clip the shooter. */
  muzzleOffset: 0.9,
  maxTargets: 1,
} as const;

/** Shockwave — instant radial burst. */
export const SHOCKWAVE = {
  cooldownMs: 7000,
  damage: 12,
  energyCost: 35,
  /** Horizontal radius (m). */
  radius: 5,
  /** Maximum |dy| for a target to be considered inside the burst (m). */
  verticalTolerance: 2.5,
  /** Outward impulse speed (m/s). */
  knockback: 12,
  knockbackUp: 5.5,
  /** Self knockback is disabled (no accidental self-launches). */
  maxTargets: 4,
} as const;

/** Platform Break — limited-use structural demolition. */
export const PLATFORM_BREAK = {
  /** Uses per life. */
  charges: 2,
  /** Durability removed from the targeted platform. */
  damage: 30,
  /** Maximum targeting distance from the eye along the aim ray (m). */
  range: 9,
  energyCost: 0,
  /** Cooldown between uses (ms); 0 = limited by charges only. */
  cooldownMs: 250,
} as const;

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PLATFORM = {
  /** Starting durability of every destructible platform. */
  destructibleDurability: 60,
  /** Collapsing -> destroyed transition time (ms). */
  collapseDurationMs: 1200,
  /** Visual/logical stage thresholds, expressed as remaining durability ratio. */
  crackedRatio: 0.66,
  criticalRatio: 0.33,
} as const;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORING = {
  pointsPerElimination: 1,
  /** A fall within this window of taking damage credits the last attacker. */
  killCreditWindowMs: 5000,
  /** Points are never awarded to the player who fell. */
  creditSelf: false,
} as const;

// ---------------------------------------------------------------------------
// Client-side presentation tuning (shared so the server can reuse the values)
// ---------------------------------------------------------------------------

export const PRESENTATION = {
  /** Snapshot interpolation delay (ms) — about 1.5 snapshot intervals. */
  interpolationDelayMs: 110,
  /** How long the kill feed keeps an entry (ms). */
  killFeedEntryMs: 6000,
  /** Ability readiness indicator refresh (ms). */
  hudRefreshMs: 50,
} as const;
