# Testing

## Running the suites

```bash
npm test                      # everything
npm run test:unit             # fast: rules + simulation (packages/shared)
npm run test:integration      # real WebSocket clients (apps/server)
npm run test:ui               # UI components rendered in Node (apps/client)
npm run typecheck             # strict TypeScript, all workspaces
npm run build                 # production builds of all three packages
npm run verify                # typecheck -> tests -> build
npm run smoke                 # two clients over the browser network path (needs the dev server)
npm run smoke:solo            # one client; waits for the automatic bot fill (needs the dev server)
```

Vitest is configured per workspace. Server integration tests have a 30 s timeout because they drive
full match phases in real time (`apps/server/vitest.config.ts`).

## What is covered by automation

### `packages/shared/test/protocol.test.ts` — 9 tests

- Room codes: length, alphabet safety (`I`/`O`/`0`/`1` excluded), uniqueness per random draw, case
  normalisation, rejection of wrong lengths and non-strings.
- Names: control characters stripped, whitespace collapsed, length clamped, empty → fallback.
- Input validation: movement clamped to ±1, pitch clamped, yaw normalised, only literal `true` counts
  as a button press, garbage objects produce a safe default frame.
- Messages: unknown types, malformed JSON and oversized payloads are rejected; a valid `join` is
  normalised and round-trips.

### `packages/shared/test/combat.test.ts` — 16 tests

- **Punch**: damage applied once per activation, real knockback velocity, no repeated damage while the
  button is held, cooldown rejects a second activation, out-of-range miss, line-of-sight block (proven
  with a wall in a purpose-built test arena), works at zero energy.
- **Energy**: 8/s regeneration, cap at 100, insufficient energy rejects the ability without spending.
- **Gravity Shot**: server projectile damages and *pulls* the target toward the attacker, one hit only,
  expires on its own with no target.
- **Shockwave**: hits inside radius, ignores targets beyond it and targets far above the vertical band,
  one hit per target per activation while held.
- **Platform Break**: consumes a charge and cracks the target platform, refuses safe platforms without
  consuming a charge, collapse happens exactly once and collision is removed at the documented point.

### `packages/shared/test/match.test.ts` — 17 tests

- Phases: needs two players, capacity four, countdown → combat → results with a 300 000 ms match clock,
  movement frozen during countdown and results, rematch resets arena, scores and charges.
- Falls/scoring: fall without an attacker awards nothing; a fall within the 5 s window credits the last
  damager; an expired window does not; self-falls never score; one point per elimination.
- Respawn/protection: 3 s respawn, full HP/energy/charges, 1.5 s protection blocks damage, and the same
  punch lands once protection expires.
- Determinism: two identical input streams produce byte-identical snapshots.
- Duplicate input sequence numbers are rejected.
- **Arena traversal**: a fighter walks off the centre platform, drops onto the causeway bridge deck
  (y = -0.5), steps back up onto the outer terrace, and reaches the far side without ever falling.
  This is a regression guard for the collision solver: treating every platform as an infinitely tall
  column makes the whole 17-platform arena unreachable.

### `packages/shared/test/bot.test.ts` — 14 tests

Drives the real simulation with a server-controlled fighter in it:

- **Membership**: bots are flagged fighters with stable ids, rotate through the ultra roster, are
  never eligible to host, can be removed again when a human turns up, and make a solo host able to
  start a match.
- **Combat skill**: a bot closes ~11 m and eliminates a defenceless opponent within 20 s; it never
  wastes an attack on a spawn-protected target (pinned adjacent for 3 s, zero damage taken); it
  spends a Platform Break charge on a weakened platform under its victim and never on its own footing.
- **Safety**: while chasing an opponent around the rim of the centre platform for 25 s it records zero
  falls; it crosses the causeway (down 0.5 m onto the bridge, up 0.5 m onto the terrace) to reach a
  victim on the north terrace; and it walks off a bridge that starts collapsing beneath it.
- **Discipline**: identical input produces identical positions, and a bot never exceeds max energy,
  its cooldown budget or its Platform Break charges.

### `apps/server/test/integration.test.ts` — 21 tests

Real HTTP server, real WebSocket clients (`ws`), real protocol:

- `/health` reports status, tick rate and counts.
- A WebSocket upgrade from a disallowed origin is refused (403).
- Create a private room and join by code; invalid code → `room-not-found`; 5th player → `room-full`.
- Host-only start (a guest can never start); ready state tracked authoritatively.
- Malformed JSON and unknown message types produce `bad-message` errors without crashing the server.
- **Two clients observe each other move** from authoritative snapshots, and an absurd forged movement
  input cannot push a fighter outside the arena bounds.
- Punch produces server `ability` events that reach the other client.
- **Damage between two clients**: the server applies 15 damage to the victim and broadcasts it, while
  the attacker stays at 100 HP.
- **Platform collapse for every client**: two breaks take the north causeway `CRACKED` → `COLLAPSING`
  → `DESTROYED`, collision disappears, and the safe centre platform is untouched.
- Match end delivers `results` (scores, shared rank on a tie) and a host-only rematch restarts the
  countdown.
- Disconnect holds the slot, awards no points, and a token reconnect restores the same fighter; host
  ownership migrates when the host leaves the lobby.
- **Automatic bot matchmaking** (5 tests): a solo host is shown a countdown; when it expires the server
  fills the arena with bots below capacity and starts by itself with the human still the host; the
  bots then visibly move and damage a passive human; a second human arriving cancels the countdown and
  no bots join; and a solo host pressing start gets an immediate bot match even with the timer
  disabled.

### `apps/client/test/ui-render.test.tsx` — 14 tests

Renders every screen with `renderToStaticMarkup` (real component code, hooks and formatting, no DOM
needed) to prove the UI cannot crash on load:

- Main menu with and without an invite code, including error text.
- Lobby: room code, occupied/empty slots, offline badge, ready state, host Start button, non-host ready
  toggle, "waiting on …" hint, bot badge, the matchmaking countdown with **Start vs bots**, and the
  exact solo-start button.
- Results: ranks, scores, victory, shared victory on a tie, waiting-for-host button.
- In-match HUD: timer formatting, health/energy values, ability cooldown and charges, target hint,
  denial message, FPS readout, countdown, respawn overlay, spawn-protection banner; and that touch
  controls are **not** rendered on desktop.
- The landscape rotate prompt, in both its fullscreen and already-fullscreen states.
- Help and settings overlays, including bound values.

### `scripts/smoke.mjs` and `scripts/smoke-solo.mjs`

`smoke.mjs`: two clients connect through the **Vite dev-server proxy** — the same origin and path the
browser uses — create/join/start a room, stream movement input, fire all four abilities and print the
authoritative result.

`smoke-solo.mjs`: **one** client creates a room and then does nothing, so the server must notice the
wait, fill the arena with bots and start on its own. It then holds still and checks that the bots
close the distance, move more than 1.5 m each and land damage. Run either while `npm run dev` is up.

## Verified by automation (run on this machine)

| Check | Command | Result |
| --- | --- | --- |
| Shared unit tests | `npm run test:unit` | **56 passed** |
| Server integration tests | `npm run test:integration` | **21 passed** |
| Client UI render tests | `npm run test:ui` | **14 passed** |
| Strict typecheck (all workspaces) | `npm run typecheck` | **passed** |
| Production build (shared, server, client) | `npm run build` | **passed** |
| Two clients through the dev proxy | `node scripts/smoke.mjs` | **passed** — room created, both clients joined, combat phase reached, 7.16 m of synchronised movement observed by the second client, server events observed, authoritative self state returned |
| Solo matchmaking through the dev proxy | `node scripts/smoke-solo.mjs` | **passed** — 15 s countdown shown to a lone host, match then started unattended with 1 human + 2 bots (Vane, Krait), bots closed 15.1 m / 7.3 m and eliminated the idle player |
| Health endpoint | `curl /health` | `{"status":"ok","tickRate":30,…}` |
| Built client served by the game server | `curl /` on :2567 | `200`, `FRACTURE` HTML |
| Dev server reachable on the preview hostname | `curl -H "Host: …" /` on :3000 | `200`; `/src/main.tsx` served as JavaScript; `/health` proxied to the game server |
| WebSocket upgrade rejection | integration test | 403 for a foreign origin |

## NOT verified by automation (manual checks required)

Automation cannot drive a real browser here, so the following are **unverified** and must be checked by
hand. They are listed so nobody mistakes a passing test suite for a complete browser test:

1. **Rendering** — that the arena, fighters, effects and HUD appear correctly and look right.
2. **WebGL performance** — that the target frame rates are reached on desktop and phones.
3. **Touch controls** — joystick, drag-look, on-screen buttons and multi-touch on a real device.
4. **Pointer lock** — mouse look, `Esc` release and re-lock.
5. **Mobile browser quirks** — scrolling/zoom suppression on a real iOS/Android browser.
6. **Audio** — that procedural sounds play after the first click and that muting works.
7. **Long sessions** — no visible leak over several consecutive rematches (code disposes resources,
   but this has not been measured in a long browser session).
8. **Visual latency feel** — whether ~110 ms of interpolation buffering feels acceptable on a real
   network (it is localhost-only here).

### Manual smoke test (5 minutes, two browsers)

1. `npm run dev`; open `http://localhost:3000` twice (second window in private mode).
2. Window A: **Create room**; copy the 5-character code. Window B: **Join room** with that code.
3. Window A (host): **Start match**. Both windows should show the 3-second countdown.
4. In window B, run forward with `W` and confirm window A shows the fighter moving smoothly.
5. In window A, click the canvas (pointer lock), walk into the other fighter, left-click: the victim's
   HUD health drops by 15 and both see a hit spark; `Q` shows a ring; right-click fires a projectile.
6. Walk off the arena edge: the fall eliminates you and the feed reports it (credited to whoever hit
   you last, within 5 s).
7. Stand on a side terrace, aim down at a causeway with `E` (the wireframe highlight appears), press
   `E` twice: the platform cracks, warns, collapses and disappears for **both** windows.
8. Kill one fighter and confirm the scoreboard shows `1` for the attacker.
9. Press `Esc`: the pause overlay appears, and the other window's match keeps running.
10. Let the clock run out (or wait for a KO at 0:00): the results screen shows ranks, scores,
    eliminations, falls and match length; the host can rematch.
11. Close window B and re-open `?room=CODE` within 20 s: the same fighter name and score return.
12. On a phone, load the same URL through your LAN address: the joystick and buttons should appear and
    the page must not scroll or zoom while playing.
