/**
 * Visual effects.
 *
 * Everything is pooled or capped so a long match cannot leak geometry,
 * materials or animation frames: one particle `Points` cloud with a fixed pool,
 * a small ring pool and a single reusable highlight wireframe.
 */
import * as THREE from 'three';

const MAX_PARTICLES = 320;
const RING_POOL = 10;

interface Particle {
  active: boolean;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
  gravity: number;
  size: number;
}

export class EffectsManager {
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly particles: Particle[] = [];
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringStates: Array<{ life: number; maxLife: number; from: number; to: number }> = [];
  private readonly highlight: THREE.LineSegments;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private cursor = 0;
  private shakeAmount = 0;
  private shakeTime = 0;
  private readonly cameraShakeOffset = new THREE.Vector3();

  private reducedMotion: boolean;

  constructor(private readonly scene: THREE.Scene, reducedMotion = false) {
    this.reducedMotion = reducedMotion;
    const geometry = this.track(new THREE.BufferGeometry());
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      this.particles.push({
        active: false,
        life: 0,
        maxLife: 1,
        velocity: new THREE.Vector3(),
        gravity: 0,
        size: 1,
      });
      this.positions[i * 3 + 1] = -10_000;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    // Custom attribute names (`aColor`, `aSize`) rather than `color`/`size`: a
    // user shader must not depend on how the engine injects built-in attributes.
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));

    const material = this.track(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: `
          attribute vec3 aColor;
          attribute float aSize;
          varying vec3 vColor;
          void main() {
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * 320.0 / max(1.0, -mv.z);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          void main() {
            vec2 d = gl_PointCoord - vec2(0.5);
            float dist = length(d);
            if (dist > 0.5) discard;
            float alpha = smoothstep(0.5, 0.1, dist);
            gl_FragColor = vec4(vColor, alpha);
          }
        `,
      }),
    );
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Shockwave / impact rings.
    const ringGeometry = this.track(new THREE.TorusGeometry(1, 0.045, 6, 48));
    ringGeometry.rotateX(Math.PI / 2);
    for (let i = 0; i < RING_POOL; i += 1) {
      const ringMaterial = this.track(
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
      );
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.visible = false;
      this.rings.push(ring);
      this.ringStates.push({ life: 0, maxLife: 1, from: 1, to: 3 });
      this.scene.add(ring);
    }

    // Platform Break targeting highlight.
    const box = this.track(new THREE.BoxGeometry(1, 1, 1));
    const edges = this.track(new THREE.EdgesGeometry(box));
    const highlightMaterial = this.track(
      new THREE.LineBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.85 }),
    );
    this.highlight = new THREE.LineSegments(edges, highlightMaterial);
    this.highlight.visible = false;
    this.scene.add(this.highlight);
  }

  /** Toggle accessibility mode at runtime (React settings change). */
  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.shakeAmount = 0;
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private allocate(): number {
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      const index = (this.cursor + i) % MAX_PARTICLES;
      if (!this.particles[index]!.active) {
        this.cursor = (index + 1) % MAX_PARTICLES;
        return index;
      }
    }
    // Pool exhausted: recycle the oldest slot.
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return index;
  }

  spawnParticle(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    color: THREE.Color,
    options: { life?: number; size?: number; gravity?: number } = {},
  ): void {
    const index = this.allocate();
    const particle = this.particles[index]!;
    particle.active = true;
    particle.life = 0;
    particle.maxLife = options.life ?? 0.7;
    particle.velocity.copy(velocity);
    particle.gravity = options.gravity ?? -6;
    particle.size = options.size ?? 0.16;
    this.positions[index * 3] = position.x;
    this.positions[index * 3 + 1] = position.y;
    this.positions[index * 3 + 2] = position.z;
    this.colors[index * 3] = color.r;
    this.colors[index * 3 + 1] = color.g;
    this.colors[index * 3 + 2] = color.b;
  }

  burst(position: THREE.Vector3, color: THREE.Color, count = 12, speed = 5, size = 0.16): void {
    if (this.reducedMotion) count = Math.ceil(count / 3);
    for (let i = 0; i < count; i += 1) {
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 1.2,
        Math.random() * 2 - 1,
      ).normalize();
      this.spawnParticle(position, dir.multiplyScalar(speed * (0.5 + Math.random())), color, {
        life: 0.4 + Math.random() * 0.4,
        size: size * (0.7 + Math.random() * 0.7),
      });
    }
  }

  ring(position: THREE.Vector3, color: number, options: { from?: number; to?: number; life?: number } = {}): void {
    const index = this.ringStates.findIndex((state) => state.life >= state.maxLife);
    const slot = index >= 0 ? index : 0;
    const ring = this.rings[slot]!;
    const state = this.ringStates[slot]!;
    state.life = 0;
    state.maxLife = options.life ?? 0.5;
    state.from = options.from ?? 1;
    state.to = options.to ?? 5;
    ring.position.copy(position);
    ring.scale.setScalar(state.from);
    (ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.75;
    ring.visible = true;
  }

  setHighlight(bounds: { center: THREE.Vector3; size: THREE.Vector3 } | null): void {
    if (!bounds) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.copy(bounds.center);
    this.highlight.scale.set(bounds.size.x * 1.02, bounds.size.y * 1.4, bounds.size.z * 1.02);
  }

  shake(intensity: number): void {
    if (this.reducedMotion) return;
    this.shakeAmount = Math.min(0.6, this.shakeAmount + intensity);
  }

  /**
   * Current camera shake offset for this frame. The caller *adds* it to the
   * desired camera position, so it can never accumulate into camera drift.
   */
  sampleShake(dt: number): THREE.Vector3 {
    if (this.shakeAmount <= 0.0001) {
      this.cameraShakeOffset.set(0, 0, 0);
      return this.cameraShakeOffset;
    }
    this.shakeTime += dt;
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 1.6);
    const magnitude = this.shakeAmount;
    this.cameraShakeOffset.set(
      Math.sin(this.shakeTime * 61) * magnitude * 0.12,
      Math.cos(this.shakeTime * 47) * magnitude * 0.1,
      0,
    );
    return this.cameraShakeOffset;
  }

  update(dt: number): void {
    const geometry = this.points.geometry as THREE.BufferGeometry;

    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      const particle = this.particles[i]!;
      if (!particle.active) continue;
      particle.life += dt;
      if (particle.life >= particle.maxLife) {
        particle.active = false;
        this.positions[i * 3 + 1] = -10_000;
        this.sizes[i] = 0;
        continue;
      }
      const velocity = particle.velocity;
      velocity.y += particle.gravity * dt;
      // Float32Array reads are `number | undefined` under noUncheckedIndexedAccess.
      this.positions[i * 3] = (this.positions[i * 3] ?? 0) + velocity.x * dt;
      this.positions[i * 3 + 1] = (this.positions[i * 3 + 1] ?? 0) + velocity.y * dt;
      this.positions[i * 3 + 2] = (this.positions[i * 3 + 2] ?? 0) + velocity.z * dt;
      const fade = 1 - particle.life / particle.maxLife;
      this.sizes[i] = particle.size * fade;
    }

    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;

    for (let i = 0; i < this.rings.length; i += 1) {
      const ring = this.rings[i]!;
      const state = this.ringStates[i]!;
      if (!ring.visible) continue;
      state.life += dt;
      const t = Math.min(1, state.life / state.maxLife);
      ring.scale.setScalar(state.from + (state.to - state.from) * t);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - t);
      if (t >= 1) ring.visible = false;
    }
  }

  dispose(): void {
    for (const ring of this.rings) this.scene.remove(ring);
    this.scene.remove(this.points);
    this.scene.remove(this.highlight);
    for (const resource of this.disposables.splice(0)) resource.dispose();
  }
}
