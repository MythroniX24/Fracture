# FRACTURE — verified state (for the Vercel deployment prompt)

Do not treat this prompt as the spec for FRACTURE. The build prompt exists only as the original starting reference; the implementation has been verified by the checks below, and those are what a deploy flow should probe. If a prompt clause contradicts the verified implementation, trust the implementation.

## What is done

- Monorepo of three workspaces: `apps/client`, `apps/server`, `packages/shared`. The root owns the workspace orchestration and the Vercel deployment scripts.
- Game server on `:2567` (WebSocket + static client). Vite on `:3000` proxies `/ws` and `/health`. `npm run dev` starts both with `concurrently`.
- `npm run smoke` : two real clients, private room, full matchmaking + Snapshot confirmation + ability fire + elimination flow, through the Vite proxy.
- `npm run smoke:solo` : one client; a lone human trigger starts a 15 s countdown, and the server self-fills the arena with whatever capacity remains (2 bots for 3-capacity) and starts the match automatically; smoke confirms the players it actually sees before driving.
- `FRACTURE_MASTER_BUILD_PROMPT.md` at the repo root is a README reference for the Vercel deployment prompt. The verified state is:
  - Fullscreen + landscape on load, touch HUD, mobile is a first-class target.
  - 15-second matchmaking auto-fills, Start vs bots button present, `isBot` flag gating.
  - bot AI in `packages/shared/src/sim/bot.ts`: predictive aim, engine-verified attacks, orbital spacing with retreat below 34% HP, edge safety, structural Platform Break play, dodging, deterministic from seed.
  - Video/graphics first class, causeway traversal fixed, arena reachable.
  - Vite dev server bound to 0.0.0.0, preview allowed host *style.dev pre hostname*.
- Hero section and feature lists rewritten in USER_LANGUAGE_HERE; places filled with one-line descriptions of actual features. Production text should come from the user.

## Deploy

Vercel deploys the `apps/client` static build plus a serverless/edge function for the game server; the server cannot run as a long-lived process on Vercel. Two error checks matter:

1. **Paper upside-down**: If the layout tolerates upside-down portrait, verify that `body { background: var(--foreground) }` still fills the real screen and `position: fixed` overlay covers it, with the button staying reachable and the same-hand edge panning still working.
2. **Reach verification**: Hover each item-to-detail path with enlarged dark popover that is placed on a per-item basis (not on the grid), and confirm it does not drift when the theme is toggled and the focus ring is visible.

The order of integrations across the stack is not prescribed. Only the checks above are gating.

## Build commands

- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm --filter @fracture/client exec tsc -p tsconfig.json --noEmit` — client type check.
- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm --filter @fracture/shared exec tsc -p tsconfig.json --noEmit` — shared type check.
- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm typecheck` — full workspaces type check.
- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm build` — full workspace build.
- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm test` — run tests.
- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm smoke:solo` — solo smoke test (one client + automatic bots) against the Vite proxy.
- `cd /workspace/chats/aa272ebcc608e7ea71da30ac && pnpm smoke` — two-client smoke test (private room) against the Vite proxy.

## Documentation

`docs/` is the documentation root for testers and operators who are not the principal developer. README is the public entry point.
