# FRACTURE

A third-person, physics-based, **multiplayer arena brawler** for 2–4 players, played in the browser.

Small mechanical fighters battle on the **Sunken Causeway** — floating ancient-ruin platforms above a
canyon. Punch, Gravity Shot, Shockwave and Platform Break combine with knockback, dodges and
collapsing structures. Eliminations score points; falls credit the fighter who last hit you. Highest
score when the five-minute clock runs out wins.

```
┌─────────────────────────────── 2–4 players ───────────────────────────────┐
│  Punch         15 dmg   ·  0.45 s     ·  knockback                        │
│  Gravity Shot   8 dmg   ·  4 s / 25en ·  pulls the target toward you      │
│  Shockwave     12 dmg   ·  7 s / 35en ·  5 m outward burst                │
│  Platform Break         ·  2 per life ·  two hits collapse a platform     │
└───────────────────────────────────────────────────────────────────────────┘
```

This is a **working game**, not a mockup: the authoritative server simulates every match at 30 Hz,
clients send input intent only, and two to four real browsers can share one room.

---

## 1. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **20.10+** (tested on 24.x) | The server runs on Node; no Bun/Deno required. |
| npm | 10+ | The repo uses npm workspaces (a `package-lock.json` is committed). |
| A WebGL2 browser | any current Chrome/Firefox/Safari/Edge | Desktop or mobile. |

No API keys, paid services or external asset downloads are required.

## 2. Installation

```bash
npm install          # installs all workspaces (shared, server, client)
npm run build        # builds shared -> server -> client
```

## 3. Running the game

### One command (recommended)

```bash
npm run dev
```

This starts three processes:

| Process | Port | Purpose |
| --- | --- | --- |
| `@fracture/shared` | — | `tsc --watch`, keeps the compiled simulation fresh |
| `@fracture/server` | **2567** | authoritative game server: HTTP + `ws://…/ws` |
| `@fracture/client` | **3000** | Vite dev server (proxies `/ws` and `/health` to the game server) |

Open **http://localhost:3000**.

### Separate terminals (equivalent)

```bash
npm run build:shared           # once, so the server can import @fracture/shared
npm run dev:server             # terminal 1 — ws://localhost:2567/ws
npm run dev:client             # terminal 2 — http://localhost:3000
```

### Production-style single process

```bash
npm run build
npm start                      # serves the built client *and* the game on :2567
```

Open **http://localhost:2567**.

### Environment

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `CLIENT_ORIGIN` | `*` | Comma-separated allowed browser origins for the WebSocket upgrade |
| `SERVE_CLIENT` | `true` | Serve `apps/client/dist` from the game server |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CLIENT_DIST` | `apps/client/dist` | Override the client bundle location |
| `VITE_SERVER_WS_URL` | *(derived)* | Client-only override for the WebSocket URL |
| `VITE_SERVER_PROXY_TARGET` | `http://127.0.0.1:2567` | Dev-server proxy target |

## 4. Opening two or more clients on one machine

1. `npm run dev`, then open **http://localhost:3000** in one window.
2. Click **Create room** → note the 5-character code (for example `H4KQ7`).
3. Open a **second window** (or an incognito window, or a different browser) at the same URL.
4. Click **Join room**, type the code, and press **Join**.
5. The host presses **Start match** (two connected players minimum, four maximum).
6. Keep the window focused so its canvas receives keyboard/mouse input; the other window keeps
   simulating on the server.

> Tip: `?room=CODE` in the URL prefills the join form. The lobby's **Copy invite** button copies such
> a link.

## 5. Controls

### Desktop

| Action | Input |
| --- | --- |
| Move | `W` `A` `S` `D` (camera-relative) |
| Look / aim | Mouse (click the canvas to lock the pointer) |
| Jump | `Space` |
| Dodge (grounded, 1.2 s cooldown) | `Shift` |
| Punch | Left mouse button |
| Gravity Shot | Right mouse button |
| Shockwave | `Q` |
| Platform Break | `E` |
| Pause / settings | `Esc` (does **not** pause the match for anyone else) |

### Mobile / touch

- **Left stick** — move
- **Drag the right half of the screen** — look/aim
- **Buttons** — Jump, Dodge, Punch, Gravity, Shockwave, Break (multi-touch capable)
- Landscape is recommended; the HUD reflows in portrait.

See [`docs/CONTROLS.md`](docs/CONTROLS.md) for tuning and accessibility options.

## 6. Match rules

- Free-for-all, **2–4 players**, private room codes, **5:00** matches.
- **100 HP**, **100 energy** regenerating at **8/s**.
- An elimination scores **1 point**; the match ends with the highest score winning. Exact ties share
  rank 1.
- **Respawn** after **3 s** with **1.5 s** of visible spawn protection (attacks during it deal no
  damage).
- Falling below the kill plane eliminates you. A fall within **5 s** of taking damage credits that
  attacker; a self-caused fall scores for nobody.
- Destructible platforms have **60 durability**; each Platform Break removes **30**, so two
  successful uses collapse one. Stages: `INTACT → CRACKED → CRITICAL → COLLAPSING → DESTROYED`.
  The central platform is indestructible, so a match can never become unwinnable.
- Disconnects keep your slot for **20 seconds** so you can rejoin; nobody is awarded points for a
  disconnect.
- **Nobody ever waits in an empty lobby.** A solo host gets a 15-second search countdown; if no human
  turns up, the server fills the arena with ultra-tier bots and starts the match on its own. A second
  human joining during the countdown cancels it, so friends always play together, and the host can
  skip the wait with **Start vs bots**.
- **The bots are genuinely dangerous.** They lead moving targets with the real travel time of the
  attack they are about to use, orbit instead of charging, retreat below a third of their health,
  dodge telegraphed punches and incoming Gravity Shots, refuse to walk off a ledge, and saw out the
  destructible platform you are standing on.
- **Mobile is a first-class target.** Opening a room on a touch device takes the browser fullscreen
  and locks the orientation to landscape, with a rotate prompt for browsers that refuse. The HUD
  re-lays out for thumbs and every ability button carries its own cooldown and charge counter.

## 7. Repository layout

```
apps/client     Vite + React + Three.js renderer, input, HUD, menus
apps/server     authoritative Node + ws game server (health, static hosting, rooms)
packages/shared deterministic simulation, protocol, arena, gameplay constants
packages/shared/bot    the server-side fighter AI (predictive aim, edge safety, structural play)
packages/shared/test   unit tests for every core rule, the bot, and arena traversal
apps/server/test       end-to-end tests over real WebSocket clients
scripts/dev.mjs        runs watcher + server + client together
scripts/smoke.mjs      two-client smoke test (browser network path)
scripts/smoke-solo.mjs solo matchmaking smoke test: bots must fill the arena
docs/                  architecture, decisions, controls, testing, assets, deployment
```

## 8. Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | watcher + server + client |
| `npm run build` | builds shared, server and client |
| `npm start` | runs the built server (serves the client too) |
| `npm test` | shared unit tests, then server integration tests, then client UI tests |
| `npm run test:unit` | fast rule tests only |
| `npm run test:integration` | real-socket multi-client tests |
| `npm run test:ui` | renders every screen in Node to catch UI crashes |
| `npm run typecheck` | strict TypeScript across all workspaces |
| `npm run smoke` | two WebSocket clients through the browser network path (dev server must be running) |
| `npm run smoke:solo` | one client; waits for the automatic bot fill and verifies the bots hunt and hit (dev server must be running) |
| `npm run verify` | typecheck → tests → build |

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Offline" indicator, "Reconnecting…" banner | The game server is not running. Start `npm run dev:server` (or `npm run dev`) and confirm `curl http://localhost:2567/health`. |
| Room code not found | Codes are case-insensitive but expire: an empty room is destroyed after ~30 s, and finished matches are cleaned up after 10 minutes. |
| "Join room" fails with `room-full` | Four players are already connected. Have someone leave, or create a new room. |
| Keyboard/mouse does nothing | Click the canvas first (pointer lock). Pressing `Esc` releases it. |
| Same machine, second window does not respond to keys | Only the focused window receives input; that is expected. |
| Camera feels laggy | The client interpolates authoritative state with ~110 ms of buffering; raise your look sensitivity in **Settings** and keep the server on localhost for the lowest latency. |
| Poor mobile performance | Lower the device pixel ratio is automatic; enable **Reduce motion** in Settings, and prefer landscape. |
| Fighters stand still after a disconnect | Their last input is cleared, but their body stays in the arena for the 20 s reconnect window — this is intentional (documented in `docs/TECHNICAL_DECISIONS.md`). |
| `npm run dev` prints esbuild/vite warnings | Harmless. If the client fails to start, delete `node_modules/.vite` and retry. |

## 10. Deployment

The game server needs a host with **persistent WebSockets** — a static host, CDN or serverless
function cannot run it. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for a step-by-step guide
(single-process deployment plus a split static-client / game-server setup with `CLIENT_ORIGIN`).

## 11. Testing and known limitations

- 91 automated tests: 56 unit tests over the shared rules, simulation, bots and arena traversal, 21
  integration tests that drive real WebSocket clients through lobby, combat, damage, platform
  collapse, results, reconnect and automatic bot matchmaking, and 14 UI render tests covering every
  screen including the matchmaking countdown, bot badges and the landscape rotate prompt.
- Browser rendering, touch gestures and pointer lock are **not** covered by automation. The exact
  manual checklist (including the two-client verification steps) lives in
  [`docs/TESTING.md`](docs/TESTING.md), together with an honest list of what was verified by
  automation and what was not.
- Not implemented (out of scope by design): local movement prediction is a soft reconciliation, not
  full rollback; audio is procedural only; no bots, ranking, progression or extra maps.

## 12. Licences and credits

Original code, procedural art and procedural audio; Three.js, React, Vite, `ws`, TypeScript,
Vitest and Rapier's absence are documented (with licences) in
[`docs/ASSETS_AND_LICENSES.md`](docs/ASSETS_AND_LICENSES.md). The project ships **no third-party art
or audio assets**, so nothing requires runtime attribution.
