# Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │            packages/shared                   │
                       │  config · types · protocol · arena           │
                       │  rules (platforms, targeting)                │
                       │  sim (movement, player, match)   ← the game   │
                       └───────────┬──────────────────────┬───────────┘
                                   │                      │
              runs the simulation  │                      │  reuses movement/rules
              authoritatively       │                      │  for prediction + HUD
                                   ▼                      ▼
        ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
        │          apps/server             │   │          apps/client             │
        │  index.ts   HTTP + /ws + loop    │◀──│  net/NetClient   snapshot buffer │
        │  room.ts    membership, tokens   │ ws│  game/Game       render + input  │
        │            + bot matchmaking     │   │  game/avatar|arenaView|effects   │
        │  roomManager.ts room registry    │   │  game/display    fullscreen +    │
        │  static.ts  serve the bundle     │   │                  landscape lock  │
        │                                  │   │  ui/*            menus + HUD      │
        └──────────────────────────────────┘   └──────────────────────────────────┘
```

## Bots are players, not a separate system

A matchmaking bot is an ordinary `PlayerState` with `isBot: true` and a `BotBrain` attached
(`packages/shared/src/sim/bot.ts`). Each tick the simulation asks every brain for a `PlayerInput` and
writes it into the same input map a human client feeds, **before** the movement/ability pass. From
then on nothing distinguishes them: the same collision, cooldowns, energy, targeting rules, scoring
and snapshots apply. That is why bots cannot cheat and why every rule you tune affects them too.

The only privileged things a bot is denied are room-level: `isHostCandidate()` skips them, so a bot
can never start a match, rematch or be addressed by the lobby UI.

Matchmaking lives in `apps/server/src/room.ts` (`updateMatchmaking`): while exactly one human sits in
the lobby a countdown runs; when it expires the room calls `sim.addBot()` until the arena is filled to
`MATCHMAKING.fillToPlayers` (one below capacity, so a friend can still join a running match) and then
`sim.startMatch()`. A second human cancels the countdown, and `sim.removeBots()` guarantees a
humans-only lobby.

## Data flow of one input press

1. `InputManager` records the press as a **one-frame pulse** (`game/input.ts`).
2. The game loop, at a fixed 40 Hz, drains the pulses into one input frame and sends it
   (`Game.update` → `NetClient.sendInput`).
3. `apps/server/src/index.ts` decodes, size-checks, rate-limits and validates it
   (`parseClientMessage` → `parsePlayerInput`).
4. `Room.handleInput` → `MatchSim.setInput` rejects duplicate sequence numbers and stores the frame.
5. The 30 Hz loop calls `MatchSim.tickOnce()`, which detects the rising edge, validates energy and
   cooldown, queues the activation and resolves it into damage intents.
6. Intents are applied in a deterministic order; events (hit, ability, elimination, platform) are
   pushed into the tick's event buffer.
7. Every second tick the room broadcasts a snapshot: players, platforms, projectiles, events and the
   match clock.
8. Each client buffers the snapshot, interpolates remote players, corrects its own predicted state,
   plays effects/audio from the events, and pushes HUD numbers to React at 10 Hz.

## packages/shared

| Module | Responsibility |
| --- | --- |
| `config.ts` | Single source of truth for every gameplay/network constant |
| `types.ts` | Domain + wire types (players, platforms, snapshots, protocol messages) |
| `protocol.ts` | Room codes, name sanitisation, message parsing/validation/clamping |
| `math.ts` | Vectors, ray/AABB, capsule-vs-box resolution, PRNG, clamping |
| `arena.ts` | The `Sunken Causeway` definition: platforms, decor, spawns, kill plane, theme |
| `rules/platforms.ts` | Durability → stage machine, collapse advance, reset |
| `rules/targeting.ts` | Punch cone + line of sight, shockwave radius, Platform Break raycast, projectile sweep |
| `sim/bot.ts` | Server-side fighter AI: profiles, perception, predictive aim, edge-safe movement, dodges, all four abilities |
| `sim/movement.ts` | Kinematic movement, dodge, jump buffering/coyote time, sub-stepped collision |
| `sim/player.ts` | Player construction, colours, per-match and per-life resets |
| `sim/match.ts` | `MatchSim`: phases, tick order, abilities, damage, falls, scoring, snapshots |

`MatchSim` is a class with no ambient dependencies. It is deterministic: no wall clock, no
randomness, no I/O. Tests exploit this by running whole matches in milliseconds.

## apps/server

| File | Responsibility |
| --- | --- |
| `index.ts` | HTTP (health, static), WebSocket upgrade/origin check, sessions, message routing, 30 Hz drift-corrected loop, heartbeats, graceful shutdown |
| `room.ts` | One room: sockets, reconnect tokens, host policy, broadcast cadence, disconnect sweeping |
| `roomManager.ts` | Code generation (CSPRNG + rejection sampling), lookup, tick-all, cleanup |
| `static.ts` | Dependency-free static file handler with SPA fallback and path-escape protection |
| `config.ts` | Environment parsing and origin allow-list |
| `logger.ts` | Level-filtered JSON line logger |

The server knows nothing about rendering; it only moves validated messages and runs `MatchSim`.

## apps/client

| File | Responsibility |
| --- | --- |
| `net/NetClient.ts` | Socket, reconnect with exponential backoff, token storage, snapshot buffer, interpolation lookup, input sequencing |
| `game/Game.ts` | Renderer, camera, interpolation, local prediction, event → feedback mapping, HUD push, fixed-rate input send |
| `game/input.ts` | Keyboard/mouse/pointer-lock and the touch API (joystick, look drag, buttons) |
| `game/avatar.ts` | Procedural fighter, animation states, name tag, health bar, spawn shield |
| `game/arenaView.ts` | Arena meshes from the shared definition, damage stages, collapse animation, sky |
| `game/effects.ts` | Pooled particles, rings, target highlight, camera shake |
| `audio.ts` | Procedural Web Audio synthesis (no asset files) |
| `state/store.ts` | HUD store (`useSyncExternalStore`) and persisted settings |
| `ui/Screens.tsx` | Main menu, lobby, results, help, settings, pause |
| `ui/Hud.tsx` | In-match HUD and touch controls |

## Rendering notes

- One `PerspectiveCamera` (72° FOV) orbits the local fighter at ~5.4 m (6.4 m on touch).
- The camera never clips through geometry: a ray from the player's head to the desired camera
  position is tested against every solid platform and the camera is pulled in to the first hit.
- Camera position is smoothed exponentially; the shake offset is *sampled* each frame and added to the
  desired position, so it can never accumulate drift.
- Screen centre == `dirFromYawPitch(yaw, pitch)`, the same vector the server uses for punch/Gravity/
  Break targeting, so the crosshair is truthful by construction.
- Crates, avatars and effects are pooled or capped; anything created is disposed on unmount.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Socket drop | Exponential-backoff reconnect (0.5 s → 8 s) using the room token; banner explains the state |
| Room gone / full on reconnect | Error surfaced, reconnect stops, the player returns to the menu |
| Server restart | Clients reconnect and re-join the same code with their token |
| Asset/WebGL failure | Everything is procedural, so there is no asset load to fail; a missing WebGL context throws visibly in the console instead of silently rendering nothing |
| Tab hidden / focus loss | Simulation continues on the server; rendering pauses with `requestAnimationFrame`; held inputs are released |
| Backend falling behind | The loop resynchronises instead of spiralling; rooms log the drift |
