/**
 * Arena renderer.
 *
 * Builds every mesh from the shared `ARENA` definition (so collision and visuals
 * can never disagree) and drives the platform state machine visuals:
 * `INTACT → CRACKED → CRITICAL → COLLAPSING → DESTROYED`.
 */
import * as THREE from 'three';
import { ARENA, type ArenaDef, type PlatformSnapshot } from '@fracture/shared';

const COLORS = {
  safe: 0xd8c39b,
  destructible: 0xc4a678,
  static: 0x8f8779,
  mesa: 0x6d6155,
  pillar: 0x7d7265,
  arch: 0x9a8d78,
  void: 0x2b241d,
};

interface PlatformView {
  id: string;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  basePosition: THREE.Vector3;
  baseRotation: THREE.Euler;
  /** Untouched material colour, used as the baseline for damage tinting. */
  baseColor: number;
  /** Full size of the platform box (kept because geometry params are untyped). */
  size: THREE.Vector3;
  destructible: boolean;
  state: string;
  solid: boolean;
  collapseProgress: number;
  crack?: THREE.Mesh;
}

export class ArenaView {
  readonly group = new THREE.Group();
  private readonly platformViews = new Map<string, PlatformView>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private elapsed = 0;

  constructor(scene: THREE.Scene, arena: ArenaDef = ARENA) {
    scene.add(this.group);
    this.buildSky(scene, arena);
    this.buildPlatforms(arena);
    this.buildDecor(arena);
    this.buildVoid(arena);
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private buildSky(scene: THREE.Scene, arena: ArenaDef): void {
    const geometry = this.track(new THREE.SphereGeometry(400, 24, 16));
    const material = this.track(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          topColor: { value: new THREE.Color(arena.theme.skyTop) },
          bottomColor: { value: new THREE.Color(arena.theme.skyBottom) },
        },
        vertexShader: `
          varying float vHeight;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vHeight = normalize(world.xyz).y;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 topColor;
          uniform vec3 bottomColor;
          varying float vHeight;
          void main() {
            float t = clamp(vHeight * 0.9 + 0.32, 0.0, 1.0);
            gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
          }
        `,
      }),
    );
    const sky = new THREE.Mesh(geometry, material);
    sky.frustumCulled = false;
    this.group.add(sky);

    scene.fog = new THREE.Fog(arena.theme.fog, 70, 260);
  }

  private buildPlatforms(arena: ArenaDef): void {
    for (const def of arena.platforms) {
      const geometry = this.track(new THREE.BoxGeometry(def.size.x, def.size.y, def.size.z));
      const color =
        def.kind === 'safe' ? COLORS.safe : def.kind === 'static' ? COLORS.static : COLORS.destructible;
      const material = this.track(
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.92,
          metalness: 0.02,
          flatShading: true,
        }),
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(def.center.x, def.center.y, def.center.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `platform-${def.id}`;
      this.group.add(mesh);

      const view: PlatformView = {
        id: def.id,
        mesh,
        material,
        basePosition: mesh.position.clone(),
        baseRotation: mesh.rotation.clone(),
        baseColor: color,
        size: new THREE.Vector3(def.size.x, def.size.y, def.size.z),
        destructible: def.kind === 'destructible',
        state: 'INTACT',
        solid: true,
        collapseProgress: 0,
      };

      if (def.kind === 'destructible') {
        // Thin emissive slab on the top face communicates damage stages.
        const crackGeometry = this.track(new THREE.BoxGeometry(def.size.x * 0.94, 0.04, def.size.z * 0.94));
        const crackMaterial = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x2c241c,
            emissive: 0x000000,
            emissiveIntensity: 0,
            transparent: true,
            opacity: 0,
          }),
        );
        const crack = new THREE.Mesh(crackGeometry, crackMaterial);
        crack.position.set(0, def.size.y / 2 + 0.01, 0);
        crack.visible = false;
        mesh.add(crack);
        view.crack = crack;
      }

      this.platformViews.set(def.id, view);
    }
  }

  private buildDecor(arena: ArenaDef): void {
    for (const decor of arena.decor) {
      const geometry = this.track(new THREE.BoxGeometry(decor.size.x, decor.size.y, decor.size.z));
      const color =
        decor.kind === 'mesa' ? COLORS.mesa : decor.kind === 'pillar' ? COLORS.pillar : COLORS.arch;
      const material = this.track(
        new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, flatShading: true }),
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(decor.center.x, decor.center.y, decor.center.z);
      mesh.rotation.y = decor.rotationY ?? 0;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  private buildVoid(arena: ArenaDef): void {
    const geometry = this.track(new THREE.PlaneGeometry(900, 900));
    const material = this.track(
      new THREE.MeshStandardMaterial({ color: COLORS.void, roughness: 1, metalness: 0 }),
    );
    const floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = arena.theme.voidFloorY;
    this.group.add(floor);
  }

  /** Apply an authoritative platform snapshot. */
  applySnapshot(platforms: readonly PlatformSnapshot[]): void {
    for (const platform of platforms) {
      const view = this.platformViews.get(platform.id);
      if (!view) continue;
      if (view.state !== platform.state) {
        view.state = platform.state;
        if (platform.state === 'COLLAPSING') view.collapseProgress = 0;
      }
      view.solid = platform.solid;
      const ratio =
        platform.maxDurability > 0 ? platform.durability / platform.maxDurability : 1;
      if (view.crack) {
        const crackMaterial = view.crack.material as THREE.MeshStandardMaterial;
        const visible = platform.state !== 'INTACT' && platform.state !== 'DESTROYED';
        view.crack.visible = visible;
        if (visible) {
          crackMaterial.opacity = 0.35 + (1 - ratio) * 0.45;
          crackMaterial.emissive.setHex(0x1a1108);
          crackMaterial.emissiveIntensity = platform.state === 'CRITICAL' ? 0.8 : 0.3;
        }
      }
      if (view.destructible) {
        const tinted =
          platform.state === 'CRITICAL' || platform.state === 'COLLAPSING'
            ? 0xa8855a
            : platform.state === 'CRACKED'
              ? 0xbb9a6c
              : view.baseColor;
        view.material.color.setHex(tinted);
      }
      if (platform.state === 'DESTROYED') {
        view.mesh.visible = false;
        if (view.crack) view.crack.visible = false;
      } else {
        view.mesh.visible = true;
      }
    }
  }

  /**
   * Animate collapse warnings. `dt` is seconds; destroyed platforms are already
   * hidden, so this only handles the shake/sink during COLLAPSING.
   */
  update(dt: number): void {
    this.elapsed += dt;
    for (const view of this.platformViews.values()) {
      if (view.state === 'COLLAPSING') {
        view.collapseProgress = Math.min(1, view.collapseProgress + dt / 1.2);
        const shake = (1 - view.collapseProgress) * 0.06;
        view.mesh.position.x = view.basePosition.x + Math.sin(this.elapsed * 42) * shake;
        view.mesh.position.z = view.basePosition.z + Math.cos(this.elapsed * 37) * shake;
        view.mesh.position.y = view.basePosition.y - view.collapseProgress * 0.35;
        view.mesh.rotation.z = Math.sin(this.elapsed * 20) * 0.02;
      } else if (
        view.mesh.position.x !== view.basePosition.x ||
        view.mesh.position.y !== view.basePosition.y ||
        view.mesh.position.z !== view.basePosition.z
      ) {
        view.mesh.position.copy(view.basePosition);
        view.mesh.rotation.copy(view.baseRotation);
      }
    }
  }

  /** Centre/size of a platform, for effect anchoring and highlight boxes. */
  platformBounds(id: string): { center: THREE.Vector3; size: THREE.Vector3 } | null {
    const view = this.platformViews.get(id);
    if (!view) return null;
    return { center: view.basePosition.clone(), size: view.size.clone() };
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const resource of this.disposables.splice(0)) resource.dispose();
    this.platformViews.clear();
  }
}
