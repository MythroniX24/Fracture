# FRACTURE — Master Build Prompt for an AI Coding Agent

> **Mission:** Build a genuinely playable, physics-based 3D multiplayer browser game—not merely a visual mockup. Treat this document as the product specification. Inspect the existing repository first, preserve useful work, and implement the game in working stages.

## 1. Product vision

**FRACTURE** is a third-person, low-poly arena brawler for **2–4 players**. Small mechanical fighters battle on floating ancient-ruin platforms above a canyon. Punches, gravity pulls, shockwaves, dodges, knockback, and collapsing platforms create tactical fights. Players can win by scoring eliminations and forcing opponents to fall.

The game must work in desktop and mobile browsers. The first release needs one polished arena, private rooms, a complete match loop, and reliable core combat. Do not expand scope into an open world, campaign, bots, ranking, shop, battle pass, inventory, or multiple game modes.

## 2. Execution rules for the agent

1. **Inspect before changing:** inspect files, scripts, dependencies, current architecture, and Git status. Do not overwrite a working project or replace existing UI without understanding it. If the repository is empty, scaffold it. If partially built, extend and repair it.
2. **Implement; do not only plan.** Work through the milestones in this prompt and leave runnable code. Do not stop after a design document, static screen, or single-player prototype.
3. Keep assumptions and technical decisions in `docs/TECHNICAL_DECISIONS.md`. Avoid asking the user routine questions; choose sensible defaults and document them.
4. Use compatible, maintained stable package versions and preserve the repository's package manager/lockfile where possible. Verify actual APIs against installed package versions rather than inventing APIs. Do not use secret keys or paid services.
5. Core gameplay must not be represented by buttons that do nothing, fake multiplayer, hard-coded pretend opponents, or placeholder success messages. Avoid TODOs for required features.
6. Implement in small, testable stages. After each stage, run relevant tests and type checks. At the end, run every available lint, test, type-check, and production-build command. Fix errors caused by the work. Clearly disclose any test that could not be run; never claim unverified success.
7. Keep code modular, typed, readable, and configurable. Put gameplay constants in one shared configuration instead of scattering magic numbers. Handle errors visibly and log server-side failures usefully.

## 3. Required architecture

Use a TypeScript monorepo unless the existing repository has a sound equivalent:

- `apps/client`: Vite, React, TypeScript, Three.js; responsive HTML/CSS HUD and menus; 3D scene and camera.
- `apps/server`: Node.js, TypeScript, Colyseus/WebSocket room server; authoritative match state and simulation.
- `packages/shared`: shared types, protocol schemas, gameplay constants, validation helpers and pure game rules.
- `docs/`: architecture, controls, local development, testing, assets and deployment.

Use **Rapier 3D** for predictable collision/rigid-body physics where practical, including on the server. Keep client and server physics responsibilities explicit. The server is authoritative for player state, attacks, cooldowns, damage, energy, knockback, falls, platform health, score, respawns, and match time. Clients send **input intent** (movement/buttons/aim), not trusted positions, damage, hit results, or scores. Validate and clamp every incoming message. Run the server simulation at a fixed **30 Hz** initially; broadcast state snapshots/events at a reasonable rate (about 15–20 Hz to start) and interpolate remote players. Use sequence numbers/timestamps where useful. Local movement prediction is optional; server correction and smooth remote interpolation are required.

Keep transport and server URLs configurable through environment variables. Include `.env.example` files with placeholders only. Do not put secrets in client bundles. Provide scripts for starting client and server together or clearly document separate terminals. A real-time Node server must be deployed to a host that supports persistent WebSockets; do not assume a static host or serverless function can run the game server.

## 4. Match flow and room lifecycle

Implement these real screens/states:

1. **Main menu:** Play/Create Room, Join Room, Settings, About/Controls.
2. **Lobby:** room code, player slots (maximum 4), ready status, connection status, copy-code action, leave-room action, and host-only Start button.
3. **Countdown:** a visible three-second countdown after the host starts with at least two connected players.
4. **Combat:** live 5-minute match, HUD, combat, scoring, falls, respawns, and platform destruction.
5. **Results:** winner/rank, scores, eliminations, falls, match duration, rematch, and return-to-menu options.

Use private room codes for the first release. Generate codes with sufficient randomness, validate joins, show useful errors for invalid/full/expired rooms, prevent duplicate players, and clean up empty rooms. Lobby membership, host ownership, ready state, and match phase must be authoritative. Disconnects must not crash or corrupt rooms. Support a short reconnect window (about 20 seconds) when feasible; otherwise remove the disconnected player cleanly and document the behavior. Do not award elimination points merely because someone disconnected. The match clock is server-owned; pausing a client must not pause the shared match.

## 5. Core match rules

- Mode: free-for-all, 2–4 players.
- Match length: **5 minutes**.
- Health: **100 HP** per life.
- A valid player elimination awards **1 point** to the credited attacker.
- At match end, the player with the highest score wins. For an exact tie, show a shared rank; do not add an unrequested complex ranked system.
- Respawn after **3 seconds** at a safe spawn point, with **1.5 seconds** of spawn protection. Make the protection visible and ensure attacking during protection cannot deal damage.
- Falling below the arena's defined kill boundary eliminates the player. Do not accidentally detect falls while a player is in an intended safe lower area; define and test the boundary explicitly.
- Track the most recent valid damaging attacker for about **5 seconds**. A fall in that window can award a point to that attacker; a self-caused fall or environmental fall without a valid attacker grants no point. Never award a point to the eliminated player themselves.
- If two attacks land in the same server tick, resolve them deterministically and safely. Avoid negative health, duplicate kills, multiple points from one elimination, or repeated hits from one attack.
- Destroyed platforms remain destroyed until the match ends. Reset the arena fully for the next match/rematch.

## 6. Movement and camera

- Third-person camera with mouse look on desktop and drag-to-look on touch devices. Clamp vertical camera angle, avoid inverted controls, and prevent severe camera clipping where practical.
- Camera-relative WASD movement; Space to jump; Shift to dodge. Support air control, stable ground detection, sensible gravity, predictable edge behavior, and collision with platforms.
- Dodge is a brief directional burst with a **1.2-second cooldown**, lasts roughly **0.22 seconds**, and is not full invulnerability. If no direction is held, dodge in the facing direction. Choose and document whether air-dodging is disabled; default to grounded dodge for predictable movement.
- Knockback must change the physics velocity/impulse, not merely play an animation. Handle knockback near edges and on respawn without trapping players.
- Prevent players from walking through walls/platforms, jumping indefinitely, changing movement speed through forged network data, or moving during the results state.

## 7. Combat and balance defaults

Put these values in shared configuration so they can be tuned without refactoring. These are starting values, not claims that balance is final.

| Ability | Input | Effect | Cooldown / cost |
|---|---|---|---|
| Punch | Desktop left-click; mobile Punch button | 15 damage; short forward melee range (about 2.2 m); moderate knockback; one hit maximum per activation | 0.45 s; no energy |
| Gravity Shot | Desktop right-click; mobile Gravity button | Server-validated projectile; 8 damage; pulls a hit target toward the attacker with a controlled impulse; limited range (about 12 m) and projectile lifetime | 4 s; 25 energy |
| Shockwave | Q; mobile Shockwave button | 12 damage to valid enemies in a radius (about 5 m); outward knockback; one hit per target per activation | 7 s; 35 energy |
| Platform Break | E; mobile Break button | Damages one selected destructible platform; highlight the target before activation | 2 uses per life; no energy |

Energy starts at **100/100** and regenerates at **8 per second**. Abilities cannot activate if energy is insufficient or cooldown is active. Punch does not spend energy. Display energy, cooldown/readiness, and remaining Platform Break charges in the HUD. Server-side checks decide whether an attack can fire, which targets it hits, and how much damage it applies.

**Punch:** use a short server-side range/cone or hit-volume check with line-of-sight where suitable. Do not use client-reported hit results. Ensure one punch cannot deal damage every frame while an input is held.

**Gravity Shot:** the server creates/updates the projectile or otherwise validates its path and collision. Do not trust a client-created hit. Avoid a projectile that can hit through walls or hit the same player repeatedly. Apply a controlled pull impulse toward the attacker; do not teleport targets. Clean up expired projectiles.

**Shockwave:** perform a server-side radius check at activation time. Apply damage and outward impulse once per eligible player, with a clear visual ring and a readable radius. Decide how vertical distance/line of sight affects hits and apply it consistently.

**Platform Break:** use a clear, deterministic target rule such as the destructible platform under the center reticle within range. If there is no valid target, show a brief reason and do not consume a charge. Never target protected spawn/safe platforms. On mobile use the camera center as the aim ray and provide the same highlight feedback.

## 8. Destructible platforms and arena physics

Build one arena from a central safe platform, smaller side platforms, broken bridges, ruins/pillars, and a visible canyon/void below. Make the map readable and provide safe spawn points. Keep at least one protected safe platform; do not allow a match to become unwinnable because every usable platform disappeared.

Each destructible platform starts at **60 durability**. Each Platform Break use deals **30 platform damage**, so two successful uses destroy a platform. Use these explicit states:

`INTACT → CRACKED → CRITICAL → COLLAPSING → DESTROYED`

Map durability thresholds to visual stages. At zero durability, broadcast one authoritative collapse event, play a short warning/collapse animation, remove collision at a clearly defined point, then mark the platform destroyed. Avoid heavy per-fragment rigid-body simulation: use lightweight particles/decorative debris and an animation. Ensure all clients observe the same platform state and transition timing. Test players standing on a platform when it collapses, players jumping off during collapse, repeated E presses, simultaneous attacks, and rematches.

## 9. Player and visual design

Use compact, readable mechanical fighters with distinct player colors or markings. Aim for **stylized low-poly ancient ruins**: natural sandstone, weathered grey rock, bronze accents, dust, stone cracks, and a natural sky. No neon cyberpunk look, excessive bloom, or expensive photorealistic assets.

The project must not depend on the user being able to run Blender. Use procedural Three.js geometry for a basic robot, arena pieces, projectiles, rings, indicators and particles when that is efficient. Optional GLB/glTF assets may come from reputable free libraries such as Kenney, Quaternius, or Poly Pizza; verify each asset's licence, retain required attribution, and document the source. Do not require remote third-party asset URLs at runtime. Provide working procedural fallbacks so missing assets never leave the scene blank. Include basic animation states (idle, move, jump/fall, punch, hit, dodge, respawn) using lightweight procedural animation if no licensed rig is available.

Use effects that communicate gameplay: attack wind-up/impact, clear hit feedback, gravity projectile trail, shockwave ring, platform cracks, falling/collapse dust, kill-feed/event message and brief camera shake. Add sound only where available and provide mute/volume settings; the game must remain playable without audio.

## 10. UI/UX and controls

### Desktop
- `WASD`: move
- `Mouse`: aim/look
- `Space`: jump
- `Shift`: dodge
- `Left click`: punch
- `Right click`: Gravity Shot
- `Q`: Shockwave
- `E`: Platform Break
- `Esc`: pause/settings overlay (does not pause the match for others)

### Mobile
- Left virtual joystick: move
- Right-side drag area: look/aim
- On-screen buttons: jump, dodge, punch, Gravity Shot, Shockwave, Platform Break
- Buttons must be large enough for touch, spaced to reduce accidental taps, and responsive to multi-touch. Prevent browser scrolling/selection/zoom gestures from interfering with the game canvas while playing, without breaking normal menu interaction. Add a way to re-open controls/help and adjust control sensitivity/button layout if practical.

HUD requirements: health bar/value, energy bar/value, each ability's cooldown/readiness, Platform Break charges, match timer, all players' scores/health, recent elimination/event feed, connection indicator, and clear hit/spawn-protection feedback. Keep text readable against the arena. Menus and HUD should work in portrait and landscape, though landscape gameplay is recommended. Handle resize, device pixel ratio, tab visibility, focus, pointer lock loss, reconnect/failure, and reduced-motion preferences gracefully.

## 11. Performance and reliability

- Target 60 FPS on suitable desktop hardware and 30–60 FPS on capable phones; these are goals, not guarantees.
- Keep models and geometry low-poly; limit shadow casters, avoid excessive real-time lights, cap device pixel ratio on weaker devices, compress/size textures sensibly, and pool short-lived particles/projectiles where useful.
- Avoid unbounded event listeners, timers, physics bodies, projectiles, room state, or animation loops. Dispose of Three.js geometry/materials/textures and clean up listeners on scene teardown/rematch.
- Avoid sending full heavyweight state unnecessarily. Validate input frequency, action cooldowns, room membership, and message shape/size. Avoid exposing server internals or allowing clients to write arbitrary room state.
- Show connection loss and failed room joins clearly. Recover gracefully from a failed asset load, server restart, double tap, duplicate input, browser resize, or player leaving mid-match.

## 12. Testing requirements

Add automated tests for core rules wherever the project setup supports them. At minimum, test:

- cooldown and energy checks; energy regeneration/cap; insufficient-energy rejection;
- punch damage applied once per activation; invalid range/aim and repeated input rejection;
- Gravity Shot collision, expiry, and no repeated hits;
- Shockwave radius and one hit per target;
- platform durability, stages, collapse occurring once, safe-platform immunity and charge consumption;
- fall detection, kill credit expiry, self-fall scoring, no duplicate elimination/points;
- spawn protection and respawn timer;
- room capacity, invalid room code, minimum players, host-only start and match timer/results;
- disconnect/reconnect and room cleanup where implemented.

Verify that two to four real browser clients can join the same room, see one another move, damage one another, collapse the same platform, score eliminations, respawn, and reach the same results screen. Do not count a local fake opponent as multiplayer verification. If browser automation is available, automate a smoke test; otherwise provide exact manual steps and state clearly which multiplayer checks were actually completed.

## 13. Development milestones — execute in order

1. **Repository and foundation:** inspect the project, document architecture, set up shared types/config, client, server, scripts and health/error handling.
2. **Playable movement prototype:** load the arena, control the player, camera, jump, dodge, collisions and fall detection; ensure it feels responsive.
3. **Single-instance combat simulation:** implement all four abilities, damage/energy/cooldowns, knockback, platform durability and collapse with tested rules.
4. **Real multiplayer:** create/join room, lobby/readiness, authoritative simulation, snapshots/interpolation, attack validation, scoring and disconnect handling.
5. **Complete match loop:** countdown, 5-minute timer, respawn/protection, results, rematch and return to menu.
6. **Mobile and polish:** touch controls, responsive UI, effects/audio, performance safeguards, graceful error/empty states and accessibility basics.
7. **Verification and deploy docs:** run builds/tests, fix errors, test two or more clients, document deployment and limitations.

Do not skip earlier milestones just to build later menus. Keep the project runnable at each stage. A minimal but fully functional implementation is better than many attractive non-working features.

## 14. Required deliverables

- Complete source code for client, authoritative server, and shared package.
- Working local development scripts and `.env.example` configuration.
- `README.md` with prerequisites, installation, development commands, controls, how to open two or more clients, common troubleshooting, and production deployment instructions.
- `docs/TECHNICAL_DECISIONS.md` describing authority model, tick/snapshot rates, physics, networking, fall-credit rules, reconnect behavior, and key tuning constants.
- `docs/ASSETS_AND_LICENSES.md` listing all external assets/audio, source links, licences and attribution; explicitly state when the project uses procedural assets only.
- Automated tests for core rules and clear manual smoke-test steps.
- Production build output generated by the project's normal build process (do not commit generated output unless the repository convention requires it).

## 15. Definition of done

The project is not complete until all applicable items are true:

- [ ] The browser loads a real 3D arena and controllable fighter, not just a menu/mockup.
- [ ] Movement, camera, jump, dodge, collision and fall elimination work.
- [ ] All four abilities work with server-authoritative validation, correct cooldowns/resources and visible feedback.
- [ ] Destructible platforms transition through their states and collapse consistently for all players.
- [ ] Two to four real clients can join one private room and observe synchronized movement/combat/state.
- [ ] Health, knockback, scoring, fall credit, respawn, spawn protection and match timer behave as specified.
- [ ] Lobby, countdown, results, rematch and cleanup form a complete loop.
- [ ] Desktop and touch controls are usable; resize, connection loss and common edge cases do not crash the game.
- [ ] Automated checks and production builds pass, or any remaining failure is explicitly reported with its cause.
- [ ] README, deployment instructions, environment examples and asset/licence notes are present.

## Final instruction

Start by inspecting the repository and then **build FRACTURE in the current workspace**. Do not answer with only a proposed plan. After implementation, provide a concise report of what works, the exact commands to run it, tests/builds actually executed and their results, deployment requirements, and any honestly unresolved items. Never claim a feature was tested unless it was actually tested.
