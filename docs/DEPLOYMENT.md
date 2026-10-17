# Deployment

FRACTURE needs **one long-lived Node process with real WebSockets**. A static host, CDN, or serverless
function cannot run the authoritative simulation: it needs a persistent socket, a 30 Hz timer and
in-memory room state.

Two supported shapes:

| Shape | When | What runs where |
| --- | --- | --- |
| **A. Single process** | Simplest, best default | The game server serves the built client *and* the game on one port |
| **B. Split** | Static client on a CDN, server separately | Static host serves `apps/client/dist`; the game server runs the simulation and accepts cross-origin sockets |
| **C. Vercel (preview only)** | Push the repo to GitHub and use Vercel's GitHub integration | Vercel runs `apps/client` as static frontend on one site, and a standalone WebSocket game server (defined in `/app/server`) elsewhere; it does **not** replace Shape A or Shape B |

---

## 1. Build

```bash
npm ci                 # or npm install, using the committed lockfile
npm run build          # shared -> server -> client
npm test               # optional but recommended
```

Artifacts:

- `apps/server/dist` — the server (run with `node apps/server/dist/index.js`)
- `apps/client/dist` — static client bundle
- `packages/shared/dist` — compiled shared package (referenced by both)

## 2. Shape A — single process

```bash
NODE_ENV=production \
PORT=2567 \
HOST=0.0.0.0 \
SERVE_CLIENT=true \
CLIENT_ORIGIN=https://your-domain.example \
npm start
```

- `GET /` serves `apps/client/dist` with an SPA fallback.
- `GET /health` returns status, tick rate, room and player counts (`{"status":"ok",…}`).
- `WS /ws` is the game protocol.
- Set `CLIENT_DIST` if the bundle lives somewhere else.

**Reverse proxy requirements (nginx / Caddy / Traefik):**

```nginx
location /ws {
  proxy_pass         http://127.0.0.1:2567;
  proxy_http_version 1.1;
  proxy_set_header   Upgrade $http_upgrade;
  proxy_set_header   Connection "upgrade";
  proxy_set_header   Host $host;
  proxy_read_timeout 3600s;   # long-lived sockets
}
location / {
  proxy_pass http://127.0.0.1:2567;
}
```

Make sure the proxy does **not** buffer WebSocket frames and does not impose a short idle timeout. The
server sends WebSocket pings every 10 s and terminates sockets that stop answering after 30 s.

## 3. Shape B — split client and server

Deploy `apps/client/dist` to any static host/CDN, and run the server with:

```bash
SERVE_CLIENT=false CLIENT_ORIGIN=https://your-client.example npm start
```

Then point the client at the server's WebSocket URL **at build time**:

```bash
# apps/client/.env.production
VITE_SERVER_WS_URL=wss://game.your-domain.example/ws
npm run build -w @fracture/client
```

Notes:

- Serve the client over **HTTPS** so the browser allows a `wss://` connection.
- `CLIENT_ORIGIN` is a comma-separated allow-list of exact origins (e.g.
  `https://your-client.example,https://staging.example`). It is checked on the WebSocket upgrade, and a
  rejected origin gets `403`. `*` disables the check and should only be used for local testing.
- The client sends `t: 'ping'` every 2 s and displays the measured round-trip time; no extra
  configuration is required.

## 4. Shape C — Vercel (frontend only)

Vercel is a separate frontend host for `apps/client`. The game server **still** needs a long-lived Node
process somewhere else; Vercel does **not** run the authoritative simulation.

1. Push this repository to GitHub.
2. In Vercel, create a project from that GitHub repo, choosing the `main` branch.
3. Set **Framework Preset** to `Vite`, keep the default Root Directory and Build Command (`npm run build
   -w @fracture/client` or Vercel's auto-detect), and leave Output Directory as `apps/client/dist`.
4. Under **Environment Variables**, add:
   - `VITE_SERVER_WS_URL` → the WebSocket URL of your Shape A or Shape B server
     (e.g. `wss://game.your-domain.example/ws`). The client reads this at build time.
   - Any other client-visible variables the app needs at runtime.
5. Deploy.

The rest of the deployment checklist in Section 6 still applies. For cockpit guidance, use Vercel's own
environment-variable UI and project settings; the guide above is an approximation.

**What Vercel does not do for you:**

- Run the WebSocket game server. That is still a separate Shape A/B process.
- Provide a single URL that serves both the static client and the game socket. If you want one origin,
  put a reverse proxy in front (see Shape A) or use a different setup.
- Auto-discover server-side types or the `packages/shared` build. The frontend build only needs the
  client bundle; the server build is separate.

## 5. Host requirements and sizing

| Requirement | Detail |
| --- | --- |
| Process model | Long-lived, always-on (container, VM, PaaS with WebSockets) |
| Memory | Low: a room with 4 players and 17 platforms is a few KiB. Plan for 64–256 MB + Node baseline |
| CPU | One core handles many 30 Hz rooms; each tick is dominated by ≤4 players × sub-stepped collision |
| Storage | None required. Room state is in memory and deliberately ephemeral — a restart ends live matches |
| Scaling | Rooms are in-memory, so a restart loses them. For horizontal scale, run a **single instance** or add sticky routing by room code (all players of a room must reach the same process) |
| TLS | Terminate at the proxy; use `wss://` in production |

Because state is in-memory:

- A server restart drops every room; clients automatically reconnect and re-join with their token, and
  if the room is gone they are returned to the main menu with a visible error.
- Deploy during a quiet period, or accept that live matches end.

## 6. Post-deploy checklist

For any Shape A, B, or C deployment, after every push:

1. `curl https://your-domain.example/health` → `status: ok`, `tickRate: 30` (where the health endpoint
   is served by the game server).
2. Open the site, create a room, and confirm the lobby shows your fighter.
3. Join from a second device (different network if possible) and start a match.
4. Confirm movement, damage, ability feedback and platform collapse for both players.
5. Disconnect one device and confirm the other shows `(offline)` and no score change, then reconnect
   within 20 s and confirm the same fighter returns.
6. Check the browser console for WebSocket errors and the server log for repeated warnings.

When deployment is just pushing to GitHub and letting Vercel auto-deploy, add one more step to the
checklist:

- After pushing to `main`, wait for Vercel's GitHub deployment to finish, then open the preview or
  production URL and confirm the lobby and matchmaking work end to end (Sections 6.2–6.4).

## 7. Docker (optional)

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production SERVE_CLIENT=true PORT=2567 HOST=0.0.0.0
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
EXPOSE 2567
HEALTHCHECK CMD wget -qO- http://127.0.0.1:2567/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
```

Only port 2567 is exposed; everything (static bundle, health, WebSocket) is served from that process.
