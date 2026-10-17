/**
 * FRACTURE client renderer and game loop.
 *
 * Per rendered frame it:
 *  1. samples the authoritative snapshot buffer and interpolates remote players
 *  2. integrates the *local* player with the same shared movement code the
 *     server runs, then nudges it toward the authoritative state (prediction +
 *     soft correction)
 *  3. updates the third-person camera (with collision pull-in), avatars,
 *     platform visuals and pooled effects
 *  4. forwards input intent to the server at a fixed rate and pushes HUD values
 *     to React at ~10 Hz
 */
import * as THREE from 'three';
import {
  ARENA,
  PLAYER,
  PRESENTATION,
  clamp,
  createPlatformRuntimes,
  createPlayerState,
  dirFromYawPitch,
  distance,
  findBreakTarget,
  findPunchTargets,
  isSolid,
  playerEye,
  rayAabb,
  releaseJumpIfNeeded,
  startDodge,
  stepPlayerMovement,
  tryJump,
  type GameEvent,
  type PlatformRuntime,
  type PlayerInput,
  type PlayerSnapshot,
  type Snapshot,
} from '@fracture/shared';
import type { AudioEngine } from '../audio.js';
import type { Settings, HudStore, KillFeedEntry } from '../state/store.js';
import type { NetClient } from '../net/NetClient.js';
import type { InputFrame, InputManager } from './input.js';
import { ArenaView } from './arenaView.js';
import { Avatar } from './avatar.js';
import { EffectsManager } from './effects.js';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  net: NetClient;
  store: HudStore;
  input: InputManager;
  audio: AudioEngine;
  /** Mutable: `updateSettings` replaces the object when React settings change. */
  settings: Settings;
  isTouch: boolean;
}

interface RenderPlayer {
  id: string;
  position: THREE.Vector3;
  yaw: number;
  snapshot: PlayerSnapshot;
}

const INPUT_INTERVAL_MS = 25;
const HUD_INTERVAL_MS = 100;
const DENIAL_MESSAGES: Record<string, string> = {
  cooldown: 'Still on cooldown',
  'no-energy': 'Not enough energy',
  'no-charges': 'No Platform Break charges left',
  'no-target': 'No destructible platform in range',
};

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly arenaView: ArenaView;
  private readonly effects: EffectsManager;
  private readonly avatars = new Map<string, Avatar>();
  private readonly projectileMeshes = new Map<string, THREE.Mesh>();
  private readonly projectileGeometry: THREE.SphereGeometry;
  private readonly projectileMaterials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly localPlatforms: PlatformRuntime[] = createPlatformRuntimes(ARENA);
  private readonly localState = createPlayerState({ id: 'local', name: 'You', slot: 0 });
  private readonly seenEvents = new Set<string>();
  private readonly killFeed: KillFeedEntry[] = [];
  private readonly clock = new THREE.Clock();

  private frameHandle: number | null = null;
  private readonly unsubscribe: () => void;
  private inputAccumulator = 0;
  private hudAccumulator = 0;
  private fpsSmoothed = 60;
  private disposed = false;

  private predicted = false;
  private lastJumpHeld = false;
  private lastDodgeHeld = false;
  private cameraYaw = 0;
  private cameraPitch = 0.15;
  private lastPhase = '';
  private lastCountdownBeep = -1;
  private breakTargetId: string | null = null;
  /** When the last denial message was raised, so the HUD can clear it. */
  private denialShownAt = 0;

  constructor(private readonly options: GameOptions) {
    const { canvas, settings, isTouch } = options;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isTouch,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    this.camera.position.set(0, 8, 14);

    this.scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x6b5a44, 1.05));
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.1);
    sun.position.set(26, 40, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 4;
    sun.shadow.camera.far = 130;
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.bias = -0.0012;
    this.scene.add(sun);

    this.arenaView = new ArenaView(this.scene, ARENA);
    this.effects = new EffectsManager(this.scene, settings.reducedMotion);
    this.projectileGeometry = new THREE.SphereGeometry(1, 12, 10);

    this.unsubscribe = this.options.net.subscribe({
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
    });

    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', this.resize);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** React pushes updated settings here so the loop and effects react live. */
  updateSettings(next: Settings): void {
    this.options.settings = next;
    this.effects.setReducedMotion(next.reducedMotion);
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.frameHandle = window.requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.1);
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.frameHandle = window.requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.frameHandle !== null) window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('orientationchange', this.resize);
    for (const avatar of this.avatars.values()) avatar.dispose();
    this.avatars.clear();
    for (const mesh of this.projectileMeshes.values()) this.scene.remove(mesh);
    this.projectileMeshes.clear();
    for (const material of this.projectileMaterials.values()) material.dispose();
    this.projectileGeometry.dispose();
    this.arenaView.dispose(this.scene);
    this.effects.dispose();
    this.renderer.dispose();
  }

  private resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  };

  // -------------------------------------------------------------------------
  // Snapshot intake
  // -------------------------------------------------------------------------

  private onSnapshot(snapshot: Snapshot): void {
    this.syncPlatforms(snapshot);
    this.consumeEvents(snapshot.events);
    this.correctLocalState(snapshot);
    this.syncProjectiles(snapshot);
    this.syncAvatars(snapshot);
    if (snapshot.phase === 'lobby' || snapshot.phase === 'countdown') {
      // Keep the camera framing the spawn point before the fight starts.
      const self = snapshot.players.find((player) => player.id === this.options.net.playerId);
      if (self) {
        this.localState.position = { x: self.p[0], y: self.p[1], z: self.p[2] };
        this.localState.velocity = { x: 0, y: 0, z: 0 };
      }
    }
  }

  private syncPlatforms(snapshot: Snapshot): void {
    const byId = new Map(snapshot.platforms.map((platform) => [platform.id, platform]));
    for (const runtime of this.localPlatforms) {
      const state = byId.get(runtime.id);
      if (!state) continue;
      runtime.state = state.state;
      runtime.durability = state.durability;
      runtime.destroyedTick = state.solid ? null : (runtime.destroyedTick ?? 0);
    }
    this.arenaView.applySnapshot(snapshot.platforms);
  }

  private syncProjectiles(snapshot: Snapshot): void {
    const active = new Set<string>();
    for (const projectile of snapshot.projectiles) {
      active.add(projectile.id);
      let mesh = this.projectileMeshes.get(projectile.id);
      if (!mesh) {
        let material = this.projectileMaterials.get(projectile.color);
        if (!material) {
          material = new THREE.MeshStandardMaterial({
            color: projectile.color,
            emissive: projectile.color,
            emissiveIntensity: 1.3,
            roughness: 0.3,
          });
          this.projectileMaterials.set(projectile.color, material);
        }
        mesh = new THREE.Mesh(this.projectileGeometry, material);
        mesh.scale.setScalar(0.42);
        this.scene.add(mesh);
        this.projectileMeshes.set(projectile.id, mesh);
      }
      mesh.position.set(projectile.p[0], projectile.p[1], projectile.p[2]);
    }
    for (const [id, mesh] of this.projectileMeshes) {
      if (active.has(id)) continue;
      this.scene.remove(mesh);
      this.projectileMeshes.delete(id);
    }
  }

  private syncAvatars(snapshot: Snapshot): void {
    const present = new Set<string>();
    for (const player of snapshot.players) {
      present.add(player.id);
      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        avatar = new Avatar(this.scene, player.color, player.name, player.slot);
        this.avatars.set(player.id, avatar);
      }
      avatar.apply(player);
      if (player.id === this.options.net.playerId) this.syncLocalFromSnapshot(player);
    }
    for (const [id, avatar] of this.avatars) {
      if (present.has(id)) continue;
      avatar.dispose();
      this.avatars.delete(id);
    }
  }

  private syncLocalFromSnapshot(player: PlayerSnapshot): void {
    this.localState.slot = player.slot;
    this.localState.color = player.color;
    this.localState.health = player.hp;
    this.localState.energy = player.en;
    this.localState.alive = player.alive;
    this.localState.spawnProtectionUntil = performance.now() + player.shieldMs;
    this.localState.breakCharges = player.charges;
    if (!this.predicted) {
      this.options.input.setAim(player.yaw, player.pitch);
      this.cameraYaw = player.yaw;
      this.cameraPitch = player.pitch;
      this.predicted = true;
    }
  }

  /**
   * Soft reconciliation: snap when the error is large (a discarded dodge, a
   * teleport, a knockback the client missed) and otherwise ease toward the
   * authoritative state so motion stays smooth.
   */
  private correctLocalState(snapshot: Snapshot): void {
    const self = snapshot.players.find((player) => player.id === this.options.net.playerId);
    if (!self) return;
    const authoritative = new THREE.Vector3(self.p[0], self.p[1], self.p[2]);
    const error = distance(this.localState.position, { x: self.p[0], y: self.p[1], z: self.p[2] });

    if (!this.localState.alive || !self.alive) {
      this.localState.position = { x: self.p[0], y: self.p[1], z: self.p[2] };
      this.localState.velocity = { x: 0, y: 0, z: 0 };
      return;
    }

    if (error > 2.2) {
      this.localState.position = { x: self.p[0], y: self.p[1], z: self.p[2] };
      this.localState.velocity = { x: self.v[0], y: self.v[1], z: self.v[2] };
      return;
    }

    const blend = 0.25;
    this.localState.position.x += (authoritative.x - this.localState.position.x) * blend;
    this.localState.position.y += (authoritative.y - this.localState.position.y) * blend;
    this.localState.position.z += (authoritative.z - this.localState.position.z) * blend;
    this.localState.velocity.x += (self.v[0] - this.localState.velocity.x) * 0.1;
    this.localState.velocity.y += (self.v[1] - this.localState.velocity.y) * 0.1;
    this.localState.velocity.z += (self.v[2] - this.localState.velocity.z) * 0.1;
  }

  // -------------------------------------------------------------------------
  // Events -> feedback
  // -------------------------------------------------------------------------

  private consumeEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      const key = `${event.tick}:${event.type}:${event.sourceId ?? ''}:${event.targetId ?? ''}:${event.detail ?? ''}:${event.platformId ?? ''}`;
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      if (this.seenEvents.size > 400) {
        // Trim the oldest entries; the set is only a duplicate guard.
        const iterator = this.seenEvents.values();
        for (let i = 0; i < 100; i += 1) {
          const value = iterator.next().value;
          if (value !== undefined) this.seenEvents.delete(value);
        }
      }
      this.handleEvent(event);
    }
  }

  private handleEvent(event: GameEvent): void {
    const { audio, net } = this.options;
    const isSelf = event.targetId === net.playerId;
    const position = event.position
      ? new THREE.Vector3(event.position.x, event.position.y + 0.9, event.position.z)
      : null;
    const color = this.colorFor(event.sourceId ?? event.targetId ?? null);

    switch (event.type) {
      case 'ability': {
        if (event.detail === 'punch') audio.punch();
        else if (event.detail === 'gravity') audio.gravityShot();
        else if (event.detail === 'dodge') audio.dodge();
        else if (event.detail === 'shockwave') {
          audio.shockwave();
          if (position) {
            this.effects.ring(new THREE.Vector3(position.x, position.y - 0.7, position.z), 0xbcd8ff, {
              from: 1,
              to: 10,
              life: 0.55,
            });
          }
          const self = this.localState.position;
          if (
            event.position &&
            distance(self, { x: event.position.x, y: event.position.y, z: event.position.z }) < 9
          ) {
            this.effects.shake(0.35);
          }
        }
        break;
      }
      case 'hit': {
        if (event.amount && event.amount > 0) {
          audio.hit();
          if (position) this.effects.burst(position, new THREE.Color(color), isSelf ? 16 : 10, 5);
          if (isSelf) this.effects.shake(0.4);
        } else if (event.detail === 'protected') {
          audio.denied();
        }
        break;
      }
      case 'elimination': {
        const attacker = event.sourceId ? this.nameFor(event.sourceId) : null;
        const victim = event.targetId ? this.nameFor(event.targetId) : 'A fighter';
        const text = attacker
          ? `${attacker} eliminated ${victim}${event.cause === 'fall' ? ' by the fall' : ''}`
          : `${victim} fell into the canyon`;
        this.pushKillFeed('elimination', text);
        if (event.targetId === this.options.net.playerId) audio.eliminated();
        if (position) {
          this.effects.burst(position, new THREE.Color(0xe2583f), 22, 7, 0.22);
        }
        break;
      }
      case 'respawn': {
        audio.respawn();
        if (position) {
          this.effects.ring(new THREE.Vector3(position.x, position.y + 0.1, position.z), 0x9ad8ff, {
            from: 0.4,
            to: 2.6,
            life: 0.6,
          });
        }
        break;
      }
      case 'platform': {
        if (event.detail === 'collapse-start') {
          audio.platformHit();
          this.pushKillFeed('platform', `${this.platformName(event.platformId)} is collapsing!`);
        } else if (event.detail === 'destroyed') {
          audio.collapse();
          this.effects.shake(0.5);
          if (event.position) {
            const center = new THREE.Vector3(event.position.x, event.position.y + 0.5, event.position.z);
            this.effects.burst(center, new THREE.Color(0xb59a72), 30, 8, 0.3);
          }
        } else if (event.detail === 'CRACKED' || event.detail === 'CRITICAL') {
          audio.platformHit();
        }
        break;
      }
      case 'ability-denied': {
        if (event.sourceId === this.options.net.playerId) {
          const [ability, reason] = (event.detail ?? '').split(':');
          const message = DENIAL_MESSAGES[reason ?? ''] ?? 'Ability unavailable';
          audio.denied();
          this.denialShownAt = performance.now();
          this.options.store.update({
            lastDenial:
              ability === 'punch'
                ? `Punch — ${message}`
                : `${ABILITY_LABELS[ability ?? ''] ?? 'Ability'} — ${message}`,
          });
        }
        break;
      }
      case 'phase': {
        if (event.detail === 'countdown') {
          this.lastCountdownBeep = -1;
          this.pushKillFeed('info', 'Match starts in 3…');
        } else if (event.detail === 'combat') {
          audio.countdownBeep(true);
          this.pushKillFeed('info', 'Fight!');
        }
        break;
      }
      case 'match-end': {
        this.pushKillFeed('info', 'Match over');
        break;
      }
      default:
        break;
    }
  }

  private colorFor(playerId: string | null): number {
    if (!playerId) return 0xffffff;
    return this.avatars.get(playerId)?.snapshot?.color ?? 0xffffff;
  }

  private nameFor(playerId: string): string {
    return this.avatars.get(playerId)?.snapshot?.name ?? 'Fighter';
  }

  private platformName(platformId: string | undefined): string {
    if (!platformId) return 'A platform';
    return ARENA.platforms.find((platform) => platform.id === platformId)?.label ?? 'A platform';
  }

  private pushKillFeed(kind: KillFeedEntry['kind'], text: string): void {
    const now = performance.now();
    this.killFeed.push({ id: `${now}-${this.killFeed.length}`, kind, text, at: now });
    while (this.killFeed.length > 6) this.killFeed.shift();
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private update(dt: number): void {
    const { net, input, store, settings } = this.options;
    this.fpsSmoothed += ((dt > 0 ? 1 / dt : 60) - this.fpsSmoothed) * 0.08;

    const samples = net.samplesFor(net.renderTime);
    const renderPlayers = samples ? this.interpolate(samples.from, samples.to, net.renderTime) : [];
    const phase = samples?.to.snapshot.phase ?? 'lobby';

    // Local prediction: run the shared movement solver with the current intent.
    if (phase === 'combat' && this.localState.alive && input.enabled) {
      this.applyLocalStep(input, net.playerId);
    }

    // Avatars.
    const alpha = 1 - Math.exp(-dt * 18);
    for (const player of renderPlayers) {
      const avatar = this.avatars.get(player.id);
      if (!avatar) continue;
      const isLocal = player.id === net.playerId;
      const target = isLocal && phase === 'combat' && this.localState.alive
        ? this.localState.position
        : player.position;
      const isFirst = !avatar.snapshot;
      if (isFirst) {
        avatar.position.set(target.x, target.y, target.z);
      } else {
        avatar.position.lerp(new THREE.Vector3(target.x, target.y, target.z), alpha);
      }
      const targetYaw = isLocal && phase === 'combat' ? input.yaw : player.yaw;
      avatar.yaw = shortestAngleLerp(avatar.yaw, targetYaw, alpha);
      const speed = Math.hypot(player.snapshot.v[0], player.snapshot.v[2]);
      avatar.update(dt, speed, settings.reducedMotion);
    }

    this.updateCamera(dt, phase, renderPlayers);
    this.arenaView.update(dt);
    this.effects.update(dt);
    this.updateBreakHighlight(phase);

    // Input transmission at a fixed rate.
    this.inputAccumulator += dt * 1000;
    while (this.inputAccumulator >= INPUT_INTERVAL_MS) {
      this.inputAccumulator -= INPUT_INTERVAL_MS;
      if (input.enabled && net.connected) {
        const frame = input.consume();
        net.sendInput(frame);
      }
    }

    // HUD at ~10 Hz.
    this.hudAccumulator += dt * 1000;
    if (this.hudAccumulator >= HUD_INTERVAL_MS) {
      this.hudAccumulator = 0;
      this.pushHud();
    }

    this.updateCountdown(phase, samples?.to.snapshot ?? null);
  }

  private updateCountdown(phase: string, snapshot: Snapshot | null): void {
    if (!snapshot) return;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.lastCountdownBeep = -1;
    }
    if (phase !== 'countdown') return;
    const remaining = Math.ceil(snapshot.countdownRemainingMs / 1000);
    if (remaining > 0 && remaining !== this.lastCountdownBeep) {
      this.lastCountdownBeep = remaining;
      this.options.audio.countdownBeep(false);
    }
  }

  private applyLocalStep(input: InputManager, selfId: string | null): void {
    // `peek` (not `consume`): pulses must survive until the fixed-rate send.
    const frame: PlayerInput = { ...input.peek(), seq: 0 };
    const now = performance.now();
    const solids = this.localPlatforms.filter(isSolid);

    if (frame.jump && !this.lastJumpHeld) {
      this.localState.jumpBufferUntil = now + PLAYER.jumpBufferMs;
    }
    if (frame.dodge && !this.lastDodgeHeld) {
      startDodge(this.localState, frame, now);
    }
    this.lastJumpHeld = frame.jump;
    this.lastDodgeHeld = frame.dodge;
    tryJump(this.localState, now);
    releaseJumpIfNeeded(this.localState, frame, now);

    stepPlayerMovement(this.localState, frame, solids, now, Math.max(1, this.lastFrameMs));
    // Running the shared solver keeps the prediction honest; the snapshot then
    // nudges it toward authority in `correctLocalState`.
    if (!selfId) this.localState.alive = false;
  }

  private lastFrameMs = 1000 / 60;

  private interpolate(
    from: { snapshot: Snapshot },
    to: { snapshot: Snapshot },
    renderTime: number,
  ): RenderPlayer[] {
    const span = to.snapshot.time - from.snapshot.time;
    const t = span > 0 ? clamp((renderTime - from.snapshot.time) / span, 0, 1) : 1;
    const result: RenderPlayer[] = [];
    const fromById = new Map(from.snapshot.players.map((player) => [player.id, player]));

    for (const player of to.snapshot.players) {
      const previous = fromById.get(player.id) ?? player;
      const position = new THREE.Vector3(
        previous.p[0] + (player.p[0] - previous.p[0]) * t,
        previous.p[1] + (player.p[1] - previous.p[1]) * t,
        previous.p[2] + (player.p[2] - previous.p[2]) * t,
      );
      const yaw = previous.yaw + shortestAngleDelta(previous.yaw, player.yaw) * t;
      result.push({ id: player.id, position, yaw, snapshot: player });
    }
    return result;
  }

  private updateCamera(dt: number, phase: string, players: RenderPlayer[]): void {
    const { net, input, settings } = this.options;
    const selfId = net.playerId;
    const self = players.find((player) => player.id === selfId);

    const target = new THREE.Vector3();
    if (phase === 'combat' && this.localState.alive) {
      target.set(this.localState.position.x, this.localState.position.y + 1.35, this.localState.position.z);
    } else if (self) {
      target.set(self.position.x, self.position.y + 1.35, self.position.z);
    } else {
      target.set(0, 1.5, 0);
    }

    // Camera angles follow the aim, with a slight lag for a game-like feel.
    const lag = input.enabled ? 1 - Math.exp(-dt * 22) : 1;
    this.cameraYaw += shortestAngleDelta(this.cameraYaw, input.yaw) * lag;
    this.cameraPitch += (input.pitch - this.cameraPitch) * lag;

    const look = dirFromYawPitch(this.cameraYaw, this.cameraPitch);
    const distance = this.options.isTouch ? 6.4 : 5.4;
    const desired = new THREE.Vector3(
      target.x - look.x * distance,
      target.y - look.y * distance + 0.35,
      target.z - look.z * distance,
    );

    // Pull the camera in when geometry is in the way.
    const solids = this.localPlatforms.filter(isSolid);
    const offset = new THREE.Vector3().subVectors(desired, target);
    let allowed = 1;
    for (const platform of solids) {
      const hit = rayAabb(
        { x: target.x, y: target.y, z: target.z },
        { x: offset.x, y: offset.y, z: offset.z },
        platform,
        offset.length(),
      );
      if (hit) allowed = Math.min(allowed, Math.max(0.28, (hit.t / offset.length()) * 0.92));
    }
    const shake = this.effects.sampleShake(dt);
    const cameraTarget = new THREE.Vector3(
      target.x + offset.x * allowed + shake.x,
      target.y + offset.y * allowed + shake.y,
      target.z + offset.z * allowed,
    );
    // Never let the camera dip below the arena floor.
    cameraTarget.y = Math.max(cameraTarget.y, -18);

    const smoothing = settings.reducedMotion ? 1 : 1 - Math.exp(-dt * 26);
    this.camera.position.lerp(cameraTarget, smoothing);
    if (Number.isNaN(this.camera.position.x)) this.camera.position.copy(cameraTarget);

    const lookAt = new THREE.Vector3(
      target.x + look.x * 12,
      target.y + look.y * 12 + 0.2,
      target.z + look.z * 12,
    );
    this.camera.lookAt(lookAt);
    this.lastFrameMs = dt * 1000;
  }

  private updateBreakHighlight(phase: string): void {
    const { store } = this.options;
    if (phase !== 'combat' || !this.localState.alive || !this.options.input.enabled) {
      this.effects.setHighlight(null);
      if (this.breakTargetId) {
        this.breakTargetId = null;
        store.update({ breakTargetName: null });
      }
      return;
    }
    const origin = playerEye(this.localState);
    const dir = dirFromYawPitch(this.options.input.yaw, this.options.input.pitch);
    const target = findBreakTarget(origin, dir, this.localPlatforms);
    if (!target) {
      this.effects.setHighlight(null);
      if (this.breakTargetId !== null) {
        this.breakTargetId = null;
        store.update({ breakTargetName: null });
      }
      return;
    }
    const bounds = this.arenaView.platformBounds(target.id);
    this.effects.setHighlight(bounds);
    if (this.breakTargetId !== target.id) {
      this.breakTargetId = target.id;
      store.update({ breakTargetName: target.label });
    }
  }

  private pushHud(): void {
    const { net, store } = this.options;
    const snapshot = net.latestSnapshot;
    if (!snapshot) return;
    const self = snapshot.players.find((player) => player.id === net.playerId) ?? null;
    const now = performance.now();
    if (store.snapshot.lastDenial && now - this.denialShownAt > 1800) {
      store.update({ lastDenial: null });
    }
    while (this.killFeed.length > 0 && now - this.killFeed[0]!.at > PRESENTATION.killFeedEntryMs) {
      this.killFeed.shift();
    }
    store.update({
      phase: snapshot.phase,
      matchRemainingMs: snapshot.matchRemainingMs,
      countdownRemainingMs: snapshot.countdownRemainingMs,
      selfId: net.playerId ?? '',
      self,
      players: snapshot.players,
      killFeed: [...this.killFeed],
      status: net.status,
      pingMs: net.pingMs,
      punchReady: this.computePunchReady(),
    });
  }

  private computePunchReady(): boolean {
    if (!this.localState.alive) return false;
    const origin = playerEye(this.localState);
    const dir = dirFromYawPitch(this.options.input.yaw, this.options.input.pitch);
    const snapshot = this.options.net.latestSnapshot;
    if (!snapshot) return false;
    const solids = this.localPlatforms.filter(isSolid);
    const targets = findPunchTargets(
      origin,
      dir,
      this.options.net.playerId ?? '',
      snapshot.players.map((player) => ({
        ...this.localState,
        id: player.id,
        position: { x: player.p[0], y: player.p[1], z: player.p[2] },
        alive: player.alive,
      })),
      solids,
      (player) => player.id === this.options.net.playerId,
    );
    return targets.length > 0;
  }

  get fps(): number {
    return this.fpsSmoothed;
  }

  /** Platform currently targeted by Platform Break (for the HUD). */
  get currentBreakTarget(): string | null {
    return this.breakTargetId;
  }
}

const ABILITY_LABELS: Record<string, string> = {
  gravity: 'Gravity Shot',
  shockwave: 'Shockwave',
  platformBreak: 'Platform Break',
  punch: 'Punch',
};

function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function shortestAngleLerp(from: number, to: number, t: number): number {
  return from + shortestAngleDelta(from, to) * t;
}


