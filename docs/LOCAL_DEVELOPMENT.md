# Local development

## Setup

```bash
git clone <repository>          # or open the existing checkout
npm install                     # npm workspaces: shared + server + client
npm run build:shared            # required once before `npm run dev:server`
npm run dev                     # watcher + server + client
```

Open <http://localhost:3000>.

### Ports

| Service | Default | Override |
| --- | --- | --- |
| Game server (HTTP + WS) | 2567 | `PORT` |
| Vite dev server | 3000 | `--port` on the client script; the proxy target uses `VITE_SERVER_PROXY_TARGET` |

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | Game server port |
| `HOST` | `0.0.0.0` | Bind address |
| `CLIENT_ORIGIN` | `*` | Comma-separated allow-list of browser origins for the WebSocket upgrade |
| `SERVE_CLIENT` | `true` | Serve the built client bundle from the game server process |
| `CLIENT_DIST` | `apps/client/dist` | Bundle location |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `FRACTURE_BOT_FILL_MS` | `15000` | Milliseconds a lone human waits before bots fill the arena. `0` disables the automatic fill (the integration tests use this so their timing is unaffected); a small value makes `npm run smoke:solo` finish quickly |

The dev client proxies `/ws` and `/health` to the game server, so the browser always talks to a single
origin — that also makes the dev server usable through a tunnel or remote workspace:

```bash
# expose the dev server on a hostname and allow it through Vite's host check
VITE_ALLOWED_HOSTS=my-tunnel.example.com npm run dev:client
# or, without touching any file, Vite's built-in variable:
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=my-tunnel.example.com npm run dev:client
```

## Workspaces

```bash
npm run dev:server     # tsx watch src/index.ts, loads @fracture/shared from its dist build
npm run dev:client     # vite dev server with HMR
npm run build:shared   # tsc -p packages/shared/tsconfig.json
```

`npm run dev` also runs `tsc --watch` over the shared package, so shared edits are picked up without a
manual rebuild. If you start the workspaces individually, remember to rebuild shared first.

Because the server imports the *compiled* shared package, a change in `packages/shared/src` requires
`tsc --watch` (which `npm run dev` starts for you). If you run `npm run dev:server` alone, keep
`npm run dev -w @fracture/shared` running in another terminal too — otherwise the server will use the
previous build.

## Useful commands

```bash
npm run typecheck                 # strict TS across all workspaces
npm test                          # unit + integration tests
npm run test:unit                 # packages/shared only (fast)
npm run test:integration          # apps/server, real sockets
npm run verify                    # typecheck -> tests -> build
node scripts/smoke.mjs            # two clients over the browser network path
```

## Testing manually with several clients

1. `npm run dev`
2. Window A: `http://localhost:3000` → **Create room** → copy the code.
3. Window B: `http://localhost:3000?room=CODE` → **Join**.
4. Host presses **Start match**.
5. Verify: both fighters move for each other, damage lands, `Q`/`E` events appear in the feed, a
   platform can be collapsed with two `E` presses, eliminations score, and the results screen appears
   after the clock runs out.

To simulate a disconnect, close one window: the other shows `(offline)` next to that fighter, the
score is unchanged, and re-opening the same room code in the same browser (the reconnect token lives
in `localStorage`) within 20 s reclaims the same fighter.

## Debugging tips

- `LOG_LEVEL=debug npm run dev:server` logs room creation, joins, disconnects, phase changes and
  eliminations as JSON lines.
- `curl http://localhost:2567/health` shows uptime, tick rate, room count and room codes.
- The client logs nothing by default; watch the browser console. `store` values are visible in React
  DevTools, and the HUD "show FPS" setting adds a frame-rate readout.
- To inspect the simulation without a browser, use the test suite as a driver — the whole match runs
  in-process (see `packages/shared/test/helpers.ts`).
- Slow-motion check: temporarily raise `PRESENTATION.interpolationDelayMs` in
  `packages/shared/src/config.ts` to exaggerate the interpolation buffer, or lower `PLAYER.moveSpeed`
  to study collision behaviour.

## Adding a gameplay change

1. Change the constant in `packages/shared/src/config.ts` (never inline the number).
2. If it is a rule (damage, targeting, collapse), change `packages/shared/src/rules/*` or `sim/*`.
3. Add or update a test in `packages/shared/test/` — the suite is the specification.
4. If the change affects the HUD, update `apps/client/src/ui/Hud.tsx`; if it affects feedback, update
   `Game.handleEvent`.
5. Run `npm run verify`.

## Common problems

| Problem | Fix |
| --- | --- |
| `@fracture/shared` module not found in the server | `npm run build:shared` (or run `npm run dev`, which watches it) |
| Vite serves the client but the game says "offline" | The game server is not running, or the proxy target port is wrong |
| Port already in use | `PORT=2600 npm run dev:server` plus `VITE_SERVER_PROXY_TARGET=http://127.0.0.1:2600 npm run dev:client` |
| Stale workspace links after moving directories | `rm -rf node_modules package-lock.json && npm install` |
| Vite refuses a tunnel hostname (403) | Set `VITE_ALLOWED_HOSTS` (see above) |
