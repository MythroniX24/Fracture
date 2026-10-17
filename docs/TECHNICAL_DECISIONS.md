# Technical decisions

Every decision below is implemented in the code; file references are included so the reasoning can be
checked against the source. Where a specification had a free choice, the choice and its rationale are
stated explicitly.

---

## 1. Authority model

**The server is authoritative for everything that matters.**

| Owned by the server (`packages/shared/src/sim/match.ts`) | Owned by the client |
| --- | --- |
| Player position/velocity, grounded state | Camera orientation (derived from sent yaw/pitch) |
| Ability activation, cooldowns, charges, energy | Input intent (movement axes, buttons) |
| Damage, knockback, hit validation | Presentation: interpolation, prediction, effects, HUD |
| Falls, eliminations, kill credit, scores | Audio, settings, local UI state |
| Platform durability, collapse timing | Platform Break *highlight* (advisory) |
| Match phase and the 5-minute clock | — |
| Lobby membership, host, ready state | — |

Clients send **intent only**:

```ts
{ t: 'input', input: { seq, moveX, moveZ, yaw, pitch, jump, dodge, punch, gravity, shockwave, breakPlatform } }
```

A client can never report a position, a hit, damage or a score. Consequences:

- Speeds are derived from server-side velocity integration, so forged input cannot move faster than
  `PLAYER.moveSpeed` / `airMoveSpeed` / `dodgeSpeed`.
- Punch hits use a **server-side** reach sphere + aiming cone + line-of-sight check
  (`packages/shared/src/rules/targeting.ts:findPunchTargets`), never a client claim.
- Gravity Shot is a **server-created** projectile; its hits are swept on the server.
- Input sequence numbers are monotonic per player (`MatchSim.setInput`); duplicates and replays are
  rejected, and the transport rate-limits frames (`apps/server/src/index.ts`).

## 2. Physics: a purpose-built kinematic solver instead of Rapier

**Decision:** the simulation uses a deterministic, dependency-free kinematic solver
(`packages/shared/src/sim/movement.ts`) shared byte-for-byte between the server and the client,
rather than Rapier 3D.

**Why:**

1. **Determinism and code sharing.** The brief asks for predictable server physics *and* (optional)
   local prediction. Sharing one solver guarantees the client's prediction runs the same maths as the
   server. A WASM engine initialised separately in two runtimes is a much larger source of divergence
   — and of "works on my machine" bugs.
2. **Right tool for the game.** FRACTURE needs cylinders-vs-boxes collision, gravity, sub-stepped
   movement, ground probing and impulse-based knockback. That is roughly 150 lines here; a general
   rigid-body engine would add ~1.5 MB of WASM, sleeping/contact-iteration tuning and non-obvious
   tunneling rules for a game whose platforms never move except when they are deleted.
3. **Testability.** The solver is pure TypeScript with no init step, so the test suite runs the exact
   production code path (`packages/shared/test/*.test.ts`).

**What it does instead** (`sim/movement.ts`):

- The player is a vertical cylinder (radius 0.45 m, height 1.7 m).
- Movement is integrated in sub-steps capped at `PLAYER.maxStepDistance` (1.2 m) so large knockback
  impulses cannot tunnel through geometry.
- `resolveCapsuleAabb` returns the dominant contact normal, which drives ground/ceiling/wall
  responses (slide along walls, cancel vertical velocity, mark grounded).
- A short downward **ground probe** (9 cm) keeps `grounded` stable and snaps the player to surfaces,
  which removes the "floating a millimetre above the floor" jitter that plain penetration resolution
  produces.
- Knockback is applied as a **velocity impulse** (`applyIntents`), clamped to
  `PLAYER.maxKnockbackSpeed = 32 m/s`.

Deliberate exclusions: no per-fragment rigid bodies (platform collapse is an animation + authoritative
state change), no ragdolls, no rotational dynamics.

## 3. Tick rate, snapshots and time

| Constant | Value | Where |
| --- | --- | --- |
| Simulation tick | **30 Hz** (`TICK_MS = 33.33`) | `config.ts` |
| State broadcast | **15 Hz** (every 2nd tick) | `SNAPSHOT_EVERY_TICKS` |
| Client input send | **40 Hz** | `Game.INPUT_INTERVAL_MS` |
| Client interpolation delay | **110 ms** | `PRESENTATION.interpolationDelayMs` |
| Look-ahead clamp | max 250 ms | `NetClient.renderTime` |

- **Time is tick-based.** `MatchSim.now === tick * TICK_MS`. The simulation never reads the wall
  clock, so a match cannot be paused by a client, by a lagging socket, or by the host's browser tab
  losing focus.
- The authoritative loop is drift-corrected (`apps/server/src/index.ts`) and resynchronises rather
  than spiralling if it ever falls more than 10 ticks behind (debugger, VM suspend).
- **Events are buffered between broadcasts.** Snapshots are sent every second tick, so events raised
  on an odd tick would otherwise never reach a client; `MatchSim.eventBuffer` accumulates them and a
  broadcast drains the buffer.

## 4. Networking

Transport is JSON over a single WebSocket per client (`apps/server/src/index.ts`,
`apps/client/src/net/NetClient.ts`).

- **Validation is centralised** in `packages/shared/src/protocol.ts`. `parseClientMessage` rejects
  unknown types, malformed JSON and oversized payloads (`MAX_MESSAGE_BYTES = 2048`); `parsePlayerInput`
  clamps movement to ±1, normalises yaw to (−π, π] and clamps pitch to `PLAYER.pitchMin/Max`. Nothing
  unvalidated reaches the simulation.
- **Rate limiting**: >135 messages/second starts a strike counter; a socket is closed after 20
  strikes. Sequence-number rejection independently throttles replayed input.
- **Interest management**: snapshots only contain the arena and the players in that room; nothing
  about other rooms or server internals is exposed.
- **Health**: `GET /health` reports rooms, connected players and room codes for operations.
- **Reconnect tokens**: `join`/`create` return an opaque token stored in `localStorage` per room code.
  A reconnect within 20 s reclaims the same fighter, score and slot.

Client-side smoothing:

- Remote players are interpolated between the two snapshots that bracket the render time.
- The **local** player is integrated locally with the shared solver each frame from the latest
  authoritative state and then softly corrected (25 % blend per snapshot, hard snap beyond 2.2 m of
  error). This is deliberately *not* full rollback netcode: it keeps input latency low without the
  complexity and failure modes of a rewind buffer. Documented as a limitation in the README.

## 5. Ability implementation notes

| Ability | Server rule | Notable decision |
| --- | --- | --- |
| Punch | Rising-edge input → 120 ms wind-up → nearest target inside a 2.2 m reach sphere, 0.55 cone cosine, unblocked line of sight | One target per activation, so a held button can never damage twice; the wind-up makes punches dodgeable |
| Gravity Shot | Server-created projectile (26 m/s, 0.42 m radius, 0.6 s life, 12 m range) swept against players and solid platforms | Dies on first contact, so it can never hit twice; pulls the target toward the attacker with a velocity impulse instead of teleporting them; walls block it |
| Shockwave | Instant server-side radius check (5 m, ±2.5 m vertical band) | **Line of sight is deliberately not applied**, but vertical separation is; this is applied consistently and documented. Self-knockback is disabled |
| Platform Break | Ray from the eye along the aim direction, nearest *breakable* platform within 9 m | Denials (`no-target`, `no-charges`) emit events and **never consume a charge**; safe/static platforms and already-collapsing platforms are excluded; the client draws the same highlight from the same shared function |

Energy costs, cooldowns and charges are checked **before** the activation is queued
(`MatchSim.canPay`), and every rejection is broadcast as an `ability-denied` event so the HUD can
explain itself.

## 6. Combat resolution and the "same tick" problem

Damage is resolved in two phases inside one tick:

1. **Collect intents.** Punch wind-ups that mature this tick, shockwave victims, and projectile hits
   are all evaluated against the *same* pre-damage state, in a deterministic order (players by slot,
   then pending attacks by id, then projectiles by id).
2. **Apply intents.** Health, knockback, kill credit and hit events are written in that same order.

Guarantees this buys:

- Two fighters who hit each other on the same tick both land their blow (no "whoever was processed
  first wins" unfairness).
- Health clamps at 0 (`Math.max(0, health - amount)`), so it can never go negative.
- `eliminate()` returns immediately if `!player.alive`, and sets `alive = false`, so an elimination is
  processed **exactly once** even if three attacks land the killing blow together.
- At most one point per elimination: the credited attacker is resolved once inside `eliminate()`.

## 7. Fall detection and kill credit

- The kill plane is `PLAYER.killY = -25`. Anything below it is eliminated with cause `fall`.
- **There is no safe lower area.** The arena's ruin pillars and canyon mesas are intentionally either
  below the kill plane or non-colliding, so a player can never land somewhere that is neither playable
  nor eliminated (the ruin pillar tops were moved to y = −27 for exactly this reason).
- Credit rule: if `now - lastAttackerAt <= SCORING.killCreditWindowMs` (5 s) the last valid damaging
  attacker scores. Otherwise nobody does.
- A player can never score for their own fall: only damage creates a `lastAttackerId`, and
  `lastAttackerId !== target.id` is enforced again inside `eliminate()` regardless.
- Disconnecting awards no points; the disconnected fighter simply stops taking input.

## 8. Platform collapse

- 60 durability, 30 damage per Platform Break → two uses per platform.
- Stage thresholds are ratios of remaining durability: `> 0.66` INTACT, `> 0.33` CRACKED, else
  CRITICAL (`rules/platforms.ts`).
- State machine `INTACT → CRACKED → CRITICAL → COLLAPSING → DESTROYED` with **one** authoritative
  `platform` event per transition; `damagePlatform` is idempotent for collapsing/destroyed platforms,
  so simultaneous or repeated breaks cannot double-collapse.
- **Collision is removed at the COLLAPSING → DESTROYED transition** (1.2 s after the collapse starts).
  This is a deliberate, documented choice: players standing on the platform get the full warning
  window to jump off, exactly as the brief asks for "a clearly defined point".
- The safe central platform is `kind: 'safe'`, which `isBreakable()` rejects, so a match can never
  become unwinnable. Rematches rebuild the arena from `createPlatformRuntimes()`.

## 9. Respawning and protection

- Respawn delay 3 s; protection 1.5 s. Both are tick-based.
- The respawn point is chosen deterministically as the spawn point **farthest from every living
  enemy** (ties broken by index), so a player is never dropped back on top of an opponent.
- Respawn restores health, energy, both Platform Break charges and all cooldowns, and grants a
  visible shield. Attacks during protection emit a `hit` event with `amount: 0, detail: 'protected'`
  so the attacker sees feedback while dealing no damage.
- Knockback cannot trap a respawning player: the spawn ring is on the indestructible platform and
  impulses are clamped rather than accumulated.

## 10. Disconnects and reconnect

- A closed socket marks the fighter `connected: false`, clears their input (`markDisconnected`), and
  broadcasts an updated room summary. The slot is held for `RECONNECT_WINDOW_MS = 20 s`.
- Reconnecting with the stored token restores the same player id and score; mid-combat they return
  with full health and fresh protection.
- Mid-match disconnections are held to be **fair and simple**: the fighter stays in the arena without
  input and can be attacked, but dropping out awards nobody a point.
- After 20 s the fighter is removed, the room summary updates, and host ownership migrates to the next
  connected player (`MatchSim.isHostCandidate`).
- Empty rooms are destroyed after ~30 s; finished matches after 10 minutes.

## 11. Lobby policy

- Capacity 4, minimum 2 to start.
- Only the host can start a match or trigger a rematch (`Room.requestStart` / `requestRematch`).
- Ready flags are tracked server-side and shown to everyone; they are **advisory** — the host may
  start while someone is unready, and the lobby explicitly names who is still waiting. This is a
  documented product decision, not an omission.
- Start requires the lobby phase; rematch requires the results phase; both re-validate the player is
  still connected.

## 12. Presentation and performance decisions

- **Procedural only** for art and audio: no GLB files, no external textures, no audio files. See
  `docs/ASSETS_AND_LICENSES.md`.
- Antialiasing is disabled and the device pixel ratio is capped at 1.5 on touch devices / 2 on
  desktop; shadows use a single 1024² map from one directional light; particles, rings and
  projectiles are pooled with hard caps (`EffectsManager`).
- All geometry, materials and textures are disposed on teardown (`Avatar.dispose`, `ArenaView.dispose`,
  `EffectsManager.dispose`, `Game.dispose`), and the render loop stops on unmount.
- HUD values are pushed to React at 10 Hz, never per frame, so the WebGL loop is not coupled to React
  renders.
- `prefers-reduced-motion` is honoured by default (fewer particles, no camera shake, snappier camera)
  and can be toggled in Settings.

## 13. Key tuning constants

All of these live in `packages/shared/src/config.ts` — nothing gameplay-relevant is hard-coded
elsewhere.

```
TICK_RATE 30 · SNAPSHOT_RATE 15 · MATCH_DURATION_MS 300000 · COUNTDOWN_MS 3000
MAX_PLAYERS 4 · MIN_PLAYERS 2 · RECONNECT_WINDOW_MS 20000 · ROOM_TTL_MS 30000

PLAYER  100 HP · 100 energy · 8/s regen · 7.6 m/s ground · 6.8 m/s air · −26 m/s² gravity
        jump 9.4 m/s · dodge 17 m/s for 0.22 s (1.2 s cooldown, grounded only)
        respawn 3 s · protection 1.5 s · knockback cap 32 m/s · kill plane −25 m
PUNCH   15 dmg · 2.2 m · 0.45 s · 120 ms wind-up · no energy
GRAVITY 8 dmg · 4 s · 25 energy · 26 m/s · 12 m range · pull impulse 11.5 m/s
SHOCK   12 dmg · 7 s · 35 energy · 5 m radius · ±2.5 m vertical
BREAK   30 platform damage · 2 charges · 9 m range · 250 ms cooldown
PLATFORM 60 durability · 1.2 s collapse
SCORING 1 point per elimination · 5 s kill-credit window
```

## 14. Options deliberately rejected

| Option | Why not |
| --- | --- |
| Rapier 3D / rigid bodies | See §2 — determinism and code sharing beat engine features for this game. |
| Full rollback netcode | Not needed for a 4-player brawler with 30 Hz server authority; soft reconciliation keeps latency low with far less risk. |
| Physics-driven platform debris | Cosmetic debris with real bodies would cost frame time and could create fake collisions; debris is particles only. |
| Delta-compressed snapshots | With ≤4 players a full snapshot is ~1 KB at 15 Hz; delta encoding would add a failure mode for no measurable win. |
| Client-side hit detection | Explicitly forbidden by the brief and trivially exploitable. |
| Ready-gating the Start button | The brief calls for a host-only Start with visible ready state, not a unanimous vote; the host sees who is unready. |

---

## 15. Matchmaking bots

**Nobody should ever stare at an empty lobby, and an empty lobby should never be the reason a
playtest does not happen.**

Policy (`apps/server/src/room.ts`):

| Event | Behaviour |
| --- | --- |
| First human enters the lobby | A `MATCHMAKING.botFillDelayMs` (15 s) countdown starts and is broadcast as `RoomSummary.matchmakingRemainingMs` |
| Timer expires with one human | `sim.addBot()` fills the arena to `MATCHMAKING.fillToPlayers` (= `MAX_PLAYERS - 1`) and `sim.startMatch()` runs |
| A second human joins during the countdown | The countdown is cancelled and `sim.removeBots()` keeps the lobby humans-only |
| A solo host presses Start | The same fill happens immediately — the two-player minimum is no longer a wall |
| Rematch | Bots persist across matches; the room refills if the arena somehow emptied |

The fill target is **deliberately one below capacity**: a match that is already running still has a
free slot, so a friend who turns up late can join the same arena instead of being told `room-full`.

**Why bots are ordinary players.** A bot is `PlayerState` with `isBot: true` plus a `BotBrain`. The
simulation asks each brain for a `PlayerInput` and stores it in the *same* map a client feeds, before
the movement pass (`MatchSim.thinkBots`). Everything downstream is shared: collision, cooldowns,
energy, spawn protection, targeting rules, scoring, respawns, snapshots. A bot therefore cannot do
anything a human could not do, and tuning a constant tunes both. The only thing a bot is denied is
room authority — `isHostCandidate()` skips bots, so a bot can never start a match or a rematch.

**Why the AI is written the way it is** (`packages/shared/src/sim/bot.ts`):

| Behaviour | How | Why not the simpler thing |
| --- | --- | --- |
| Predictive aim | Leads the target by the real travel time of the attack it is about to use (`GRAVITY_SHOT.speed`, or a punch lead), then turns at a bounded `BOT.turnRate` | Aiming at the current position misses every moving target; instantaneous snapping looks robotic and is unfair |
| Verified attacks | Punch and Gravity Shot only fire when `findPunchTargets` / `sweepProjectileForPlayer` — the server's own rules — confirm the shot connects | A bot that sprays attacks into walls reads as broken, and it wastes the cooldowns it needs to survive |
| Orbital spacing | Holds `BOT.engageRange`, circles with a periodically flipping strafe direction, gives ground when too close | Charging straight in makes bots trivially counter-punched and clumps them together |
| Retreat | Below `BOT.retreatHealth` (34%) it heads for the indestructible centre platform while still firing | A bot that fights to the death at 5 HP is free score, not an opponent |
| Edge safety | Every grounded step probes `BOT.edgeProbeDistance` ahead and slides along the ledge before stopping | Without it bots walk straight off the causeway; the pits are the arena's whole point |
| Structural play | If the victim stands on a destructible platform that is weak or near a rim, the bot aims at the *structure* and spends a Platform Break charge — unless it is standing on that same platform | It is the arena's most interesting mechanic and the clearest way to show the AI understands the map |
| Reactions | Dodges telegraphed punches (4-tick window) and incoming Gravity Shots within 9 m, gated by a deterministic per-profile skill roll | Perfect dodging is unbeatable, and never dodging ignores two of the game's four abilities |
| Determinism | No `Math.random`, no wall-clock time; jitter and skill rolls come from a hash of `(tick, profile.seed)` | The simulation must stay reproducible for tests and replays |

Difficulty is expressed as a `BotProfile` (aggression, turn multiplier, dodge skill, seed) from
`ULTRA_BOTS`; adding an easier tier is a data change, not an AI rewrite.

## 16. The collision solver had to learn about height (a real bug fix)

While writing the bots, the edge-safety probes kept claiming a step was safe that the solver then
refused to take. Investigating found a **pre-existing defect that made most of the arena
unreachable**: `resolveCapsuleAabb` (`packages/shared/src/math.ts`) measured a body against a box
using only the *horizontal* distance, so every platform behaved like an infinitely tall column.

Consequences before the fix (measured, not theorised):

- A fighter walking off the centre platform was stopped dead 0.45 m short of the north causeway — the
  bridge sits 0.5 m lower, and the walkway it was standing on blocked it sideways.
- Nothing could step *up* onto anything either: the same test pushed the body back out.
- The practical result was a 16 × 16 m playable square instead of a 17-platform arena, with eight
  destructible platforms and the whole collapse mechanic unreachable.

Three changes, all in shared code so the server and client prediction stay identical:

1. **Vertical component in the box test.** Outside a box's XZ footprint the distance now includes the
   closest point on the box's vertical extent (`dy`), so a box below the feet no longer pushes
   sideways, and a box above the head no longer does either.
2. **Step-up assist.** A grounded body walking into a horizontal contact whose top face is within
   `STEP_UP_MAX` (0.66 m) is lifted onto it and stepped 0.06 m inside the footprint, where the normal
   resolution snaps it cleanly onto the top face. That is what makes the bridges (0.5 m below the
   terraces) traversable in both directions.
3. **Ground probe honesty.** The probe only marks a body grounded when the resolved surface is within
   `SNAP_MAX` (0.14 m) of the feet. Previously any box within the capsule's radius counted as ground,
   which let a body hover 0.5 m above a bridge.

Guard tests: `packages/shared/test/match.test.ts` → *arena traversal* (three tests) and
`packages/shared/test/bot.test.ts` → *crosses the causeway instead of dropping into the canyon*.

## 17. Mobile: immersive by default

Browsers only grant fullscreen and an orientation lock from a **user gesture**, so the two ways into a
match (*Create room*, *Join*) call `enterImmersiveMode()` directly (`apps/client/src/game/display.ts`),
which requests fullscreen and then `screen.orientation.lock('landscape')`, followed by a screen wake
lock so a five-minute match cannot dim the display.

Every step is best-effort and independently degradable: iOS Safari implements no orientation lock at
all, and embedded frames refuse fullscreen. Instead of failing, the client watches the viewport
orientation (`matchMedia` plus a resize backstop, because some browsers stop reporting changes while
fullscreen) and shows a blocking **Rotate to landscape** prompt whose button retries the request.

On touch devices the HUD re-lays out for thumbs (`styles.css` → `.hud--touch`, `.touch-actions`):

- The desktop ability tiles are hidden; readiness moved **onto** the buttons, which carry their own
  cooldown sweep, remaining seconds and Platform Break charges. Your eyes never leave your thumbs.
- Jump and Punch are the largest targets (`clamp(70px, 14.5vmin, 96px)`) because they are used dozens
  of times a minute; the rest sit in a 3 × 2 grid above the joystick's corner.
- Health/energy move under the connection readout so the joystick owns the bottom-left corner, and
  button sizes scale with `vmin` so the same layout works from a 5-inch phone to a tablet.

## 18. Options deliberately rejected (second pass)

| Option | Why not |
| --- | --- |
| Bots in the lobby roster before the match starts | The countdown exists so a human can still take the slot; showing bots early would make joining look like a downgrade. |
| Filling to `MAX_PLAYERS` | A full lobby locks out the friend who arrives late. Filling to capacity − 1 keeps a door open. |
| Bots as a separate `AIBot` entity type | Two code paths for one concept means two sets of bugs; `isBot` on the shared player type keeps one simulation. |
| Simulating bots on the client | Bots must be authoritative or their hits could not be trusted, and every client would diverge. |
| `screen.orientation.lock` as a hard requirement | Several browsers do not implement it; the rotate prompt is the honest fallback. |
| Requiring fullscreen to play | Desktop players and unsupported browsers must still be able to play in a window. |
