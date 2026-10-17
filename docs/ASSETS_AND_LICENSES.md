# Assets and licences

## Summary

**FRACTURE uses procedural assets only.** There are no GLB/glTF models, no image textures, no fonts,
no music and no sound-effect files anywhere in this repository. Every visible object is generated from
Three.js primitives in code, and every sound is synthesised at runtime with the Web Audio API.

Consequences:

- Nothing requires attribution at runtime, and no licence obligations travel with the game.
- The scene can never be blank because an asset failed to load (a required fallback in the brief).
- The project does not require Blender, a modelling tool or an external asset library.

## Procedurally generated visuals

| Element | Where | How |
| --- | --- | --- |
| Fighter model (torso, chest plate, head, visor, arms, fists, legs, feet) | `apps/client/src/game/avatar.ts` | Cloned `BoxGeometry` primitives, flat-shaded `MeshStandardMaterial`, per-player accent colour |
| Animation states (idle, move, jump, fall, punch, hit, dodge, down, respawn pop-in) | `apps/client/src/game/avatar.ts` | Code-driven joint rotations; no rigged mesh or keyframe files |
| Name tags | `apps/client/src/game/avatar.ts` | Text drawn to a `canvas` and uploaded as a `THREE.CanvasTexture` |
| Health bars, spawn shield | `apps/client/src/game/avatar.ts` | Sprites and an `IcosahedronGeometry` shell |
| Arena platforms, monoliths, ruin pillars, canyon mesas, arches | `apps/client/src/game/arenaView.ts` from `packages/shared/src/arena.ts` | Boxes scaled from the shared arena definition — the same numbers the physics uses |
| Sky, fog, void floor | `apps/client/src/game/arenaView.ts` | A gradient `ShaderMaterial` skydome plus `THREE.Fog` and a plane |
| Particles (dust, sparks, collapse debris) | `apps/client/src/game/effects.ts` | One pooled `THREE.Points` cloud with a custom point shader |
| Shockwave ring, impact rings, target highlight | `apps/client/src/game/effects.ts` | Pooled `TorusGeometry` meshes and an `EdgesGeometry` wireframe |
| Gravity Shot projectile | `apps/client/src/game/Game.ts` | Pooled `SphereGeometry` with an emissive material |
| Colours and palette | `packages/shared/src/config.ts`, `arena.ts`, `sim/player.ts` | Numeric constants (sandstone, weathered rock, bronze, oxidised metal accents) |

## Procedurally generated audio

All effects are synthesised with oscillators and filtered noise in `apps/client/src/audio.ts`
(`AudioEngine`): punch, hit, Gravity Shot, shockwave, platform impact, collapse, jump, land, dodge,
respawn, elimination, denied-ability buzz, countdown beeps and UI clicks. There is no audio file
dependency and the game is fully playable with audio muted or unavailable (every audio call is
guarded, and failures are silent).

## Third-party software (npm dependencies)

These are libraries, not assets. Licences are the ones shipped by each package.

| Package | Used by | Licence |
| --- | --- | --- |
| [three](https://threejs.org/) | `apps/client` | MIT |
| [react](https://react.dev/) / [react-dom](https://react.dev/) | `apps/client` | MIT |
| [vite](https://vite.dev/) + [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | build tooling | MIT |
| [ws](https://github.com/websockets/ws) | `apps/server` | MIT |
| [typescript](https://www.typescriptlang.org/) | all workspaces | Apache-2.0 |
| [vitest](https://vitest.dev/) | tests | MIT |
| [tsx](https://github.com/privatenumber/tsx) | server dev runner | MIT |
| [@types/*](https://github.com/DefinitelyTyped/DefinitelyTyped) (node, ws, react, react-dom, three) | type definitions only | MIT |

No dependency is licensed under a copyleft licence, and no paid service or API key is used.

## Considered and deliberately not used

| Asset route | Why not |
| --- | --- |
| GLB fighters from Kenney / Quaternius / Poly Pizza | The brief allows them, but they add a binary blob, a licence file, a loading state and a failure mode for no gameplay gain. Procedural fighters are readable, colourable per player and free of attribution. |
| Rigged GLB with animations | Requires a licensed rig plus a loader; procedural joint animation covers all nine required states. |
| Rapier 3D physics WASM | See `docs/TECHNICAL_DECISIONS.md` §2 — determinism and client/server code sharing matter more here. |
| Google Fonts / icon fonts | Runtime third-party requests would break offline play; the UI uses `system-ui` and Georgia only. |
| Stock sound effects / music | Untraceable provenance and licence risk; procedural synthesis is licence-free and keeps the bundle small. |

## If you add an asset later

Add a row to the table above with: the file, its source URL, the author, the licence and the required
attribution text. Keep the attribution visible in-game (or in an "About" panel) when the licence
demands it, and keep a procedural fallback so a missing file can never leave the scene blank.
