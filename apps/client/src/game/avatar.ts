/**
 * Procedural low-poly fighter.
 *
 * No external models or Blender: the robot is built from boxes and animated in
 * code (idle, move, jump, fall, punch, hit, dodge, down, respawn). Each avatar
 * owns cloned materials so hit flashes and shield tints never leak between
 * players, and everything is disposed on teardown.
 */
import * as THREE from 'three';
import type { AnimationState, PlayerSnapshot } from '@fracture/shared';

const BODY_COLOR = 0x4c4a52;
const LIMB_COLOR = 0x3b3a42;
const DARK_COLOR = 0x2a2930;

function makeNameTag(name: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = 'bold 30px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(12,10,8,0.55)';
    if (typeof context.roundRect === 'function') {
      context.beginPath();
      context.roundRect(6, 12, canvas.width - 12, 40, 12);
      context.fill();
    } else {
      // Older canvas implementations (pre-2023 Safari/Firefox) lack roundRect.
      context.fillRect(6, 12, canvas.width - 12, 40);
    }
    context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.fillText(name.slice(0, 14), canvas.width / 2, canvas.height / 2 + 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.5, 0.375, 1);
  return sprite;
}

function makeBarMaterial(color: number): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({ color, transparent: true, depthWrite: false, depthTest: false });
}

export class Avatar {
  readonly group = new THREE.Group();
  snapshot: PlayerSnapshot | null = null;
  /** Render position/rotation, smoothed by the caller. */
  readonly position = new THREE.Vector3();
  yaw = 0;
  /** Interpolated health used for the bar below the name tag. */
  private displayedHealth = 100;

  private readonly body = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly leftArm = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly accentMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly bodyMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly healthFill: THREE.Sprite;
  private readonly healthBack: THREE.Sprite;
  private readonly shield: THREE.Mesh;
  private readonly nameTag: THREE.Sprite;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private animationClock = 0;
  private hitFlash = 0;
  private punchTime = 999;
  private wasAlive = true;
  private hasAppeared = false;
  private appearTime = 0;

  constructor(private readonly scene: THREE.Scene, color: number, name: string, slot: number) {
    this.scene.add(this.group);
    this.group.visible = false;

    const accent = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.45,
      metalness: 0.35,
      flatShading: true,
    });
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: BODY_COLOR,
      roughness: 0.75,
      metalness: 0.15,
      flatShading: true,
    });
    const limbMaterial = new THREE.MeshStandardMaterial({
      color: LIMB_COLOR,
      roughness: 0.8,
      metalness: 0.1,
      flatShading: true,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: DARK_COLOR,
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    });
    this.accentMaterials.push(accent);
    this.bodyMaterials.push(bodyMaterial, limbMaterial, darkMaterial);

    const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      this.disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    this.group.add(this.body);

    // Legs (pivot at the hips).
    this.leftLeg.position.set(-0.18, 0.82, 0);
    this.rightLeg.position.set(0.18, 0.82, 0);
    this.body.add(this.leftLeg, this.rightLeg);
    for (const leg of [this.leftLeg, this.rightLeg]) {
      add(leg, new THREE.BoxGeometry(0.19, 0.68, 0.22), limbMaterial, 0, -0.34, 0);
      add(leg, new THREE.BoxGeometry(0.24, 0.12, 0.32), darkMaterial, 0, -0.72, 0.03);
    }

    // Torso + chest plate. Note the model's front is local **-Z**: the shared
    // `dirFromYawPitch` convention is that yaw 0 looks down -Z, so the visor and
    // chest detail must sit at negative Z for `group.rotation.y = yaw` to aim
    // the fighter (and the punch animation) the same way the server does.
    const torsoMesh = add(this.body, new THREE.BoxGeometry(0.64, 0.62, 0.42), bodyMaterial, 0, 1.13, 0);
    this.torso = torsoMesh;
    add(this.body, new THREE.BoxGeometry(0.68, 0.2, 0.46), accent, 0, 1.24, 0);
    add(this.body, new THREE.BoxGeometry(0.3, 0.16, 0.06), accent, 0, 1.0, -0.23);

    // Head and visor.
    this.head = add(this.body, new THREE.BoxGeometry(0.42, 0.36, 0.4), bodyMaterial, 0, 1.62, 0);
    add(this.body, new THREE.BoxGeometry(0.34, 0.11, 0.06), accent, 0, 1.63, -0.21);
    add(this.body, new THREE.BoxGeometry(0.06, 0.22, 0.06), darkMaterial, 0.18, 1.86, 0);

    // Arms (pivot at the shoulders).
    this.leftArm.position.set(-0.42, 1.38, 0);
    this.rightArm.position.set(0.42, 1.38, 0);
    this.body.add(this.leftArm, this.rightArm);
    for (const arm of [this.leftArm, this.rightArm]) {
      add(arm, new THREE.BoxGeometry(0.17, 0.56, 0.19), limbMaterial, 0, -0.28, 0);
      add(arm, new THREE.BoxGeometry(0.22, 0.22, 0.22), accent, 0, -0.62, 0);
    }

    // Name tag, health bar and spawn shield.
    this.nameTag = makeNameTag(name, color);
    this.nameTag.position.set(0, 2.32, 0);
    this.group.add(this.nameTag);

    this.healthBack = new THREE.Sprite(makeBarMaterial(0x1a1512));
    this.healthBack.center.set(0, 0.5);
    this.healthBack.position.set(-0.5, 2.08, 0);
    this.healthBack.scale.set(1.0, 0.1, 1);
    this.group.add(this.healthBack);

    this.healthFill = new THREE.Sprite(makeBarMaterial(0x7ddc6a));
    this.healthFill.center.set(0, 0.5);
    this.healthFill.position.set(-0.48, 2.08, 0.01);
    this.healthFill.scale.set(0.96, 0.07, 1);
    this.group.add(this.healthFill);

    const shieldGeometry = new THREE.IcosahedronGeometry(0.95, 1);
    const shieldMaterial = new THREE.MeshBasicMaterial({
      color: 0x9ad8ff,
      transparent: true,
      opacity: 0.17,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(shieldGeometry, shieldMaterial, this.nameTag.material, this.nameTag.material.map as THREE.Texture, this.healthBack.material, this.healthFill.material);
    this.shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
    this.shield.position.set(0, 0.9, 0);
    this.shield.visible = false;
    this.group.add(this.shield);

    this.group.userData.slot = slot;
  }

  private get anim(): AnimationState {
    return this.snapshot?.anim ?? 'idle';
  }

  /** Feed the authoritative state; the caller smooths position itself. */
  apply(snapshot: PlayerSnapshot): void {
    if (!this.hasAppeared) {
      this.position.set(snapshot.p[0], snapshot.p[1], snapshot.p[2]);
      this.group.position.copy(this.position);
      this.hasAppeared = true;
    }
    if (this.snapshot && snapshot.hitTick !== this.snapshot.hitTick && snapshot.hitTick !== null) {
      this.hitFlash = 1;
    }
    if (snapshot.alive && !this.wasAlive) this.appearTime = 0.6;
    if (snapshot.anim === 'punch' && this.snapshot?.anim !== 'punch') this.punchTime = 0;
    this.wasAlive = snapshot.alive;
    this.snapshot = snapshot;
    this.group.visible = true;
    (this.group.userData as { id?: string }).id = snapshot.id;
  }

  update(dt: number, movingSpeed: number, reducedMotion: boolean): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.animationClock += dt;
    this.punchTime += dt;
    if (this.appearTime > 0) this.appearTime = Math.max(0, this.appearTime - dt);

    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;

    const anim = this.anim;
    const t = this.animationClock;
    const speedFactor = Math.min(1, movingSpeed / 7);

    // Reset default pose.
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.leftArm.rotation.set(0, 0, 0);
    this.rightArm.rotation.set(0, 0, 0);
    this.leftLeg.rotation.set(0, 0, 0);
    this.rightLeg.rotation.set(0, 0, 0);
    this.torso.rotation.set(0, 0, 0);

    const amount = reducedMotion ? 0.4 : 1;

    switch (anim) {
      case 'idle': {
        this.body.position.y = Math.sin(t * 2.2) * 0.022 * amount;
        this.leftArm.rotation.z = 0.12;
        this.rightArm.rotation.z = -0.12;
        this.head.rotation.y = Math.sin(t * 0.7) * 0.25 * amount;
        break;
      }
      case 'move': {
        const swing = Math.sin(t * 11) * 0.75 * speedFactor * amount;
        this.leftLeg.rotation.x = swing;
        this.rightLeg.rotation.x = -swing;
        this.leftArm.rotation.x = -swing * 0.8;
        this.rightArm.rotation.x = swing * 0.8;
        this.body.position.y = Math.abs(Math.sin(t * 11)) * 0.05 * amount;
        // Negative X rotation leans the torso toward -Z, i.e. forward.
        this.body.rotation.x = -0.09 * speedFactor;
        break;
      }
      case 'jump': {
        this.leftLeg.rotation.x = 0.7;
        this.rightLeg.rotation.x = -0.35;
        this.leftArm.rotation.x = -2.0;
        this.rightArm.rotation.x = -2.0;
        break;
      }
      case 'fall': {
        this.leftLeg.rotation.x = 0.5;
        this.rightLeg.rotation.x = -0.25;
        this.leftArm.rotation.z = 1.1;
        this.rightArm.rotation.z = -1.1;
        break;
      }
      case 'dodge': {
        this.body.rotation.x = -0.55;
        this.leftLeg.rotation.x = -0.9;
        this.rightLeg.rotation.x = -0.6;
        this.leftArm.rotation.x = -1.5;
        this.rightArm.rotation.x = -1.5;
        break;
      }
      case 'punch': {
        // +X rotation swings the fist toward -Z (forward) and slightly upward.
        const progress = Math.min(1, this.punchTime / 0.24);
        const extension = Math.sin(progress * Math.PI);
        this.rightArm.rotation.x = 2.2 * extension;
        this.leftArm.rotation.x = -0.6 * extension;
        this.body.rotation.y = -0.35 * extension;
        break;
      }
      case 'hit': {
        // Positive X rotation recoils the torso backwards (+Z).
        this.body.rotation.x = 0.4 * amount;
        this.leftArm.rotation.x = 0.9;
        this.rightArm.rotation.x = 0.9;
        break;
      }
      case 'down': {
        this.body.rotation.x = -Math.PI / 2.05;
        this.body.position.y = 0.28;
        this.leftArm.rotation.z = 1.3;
        this.rightArm.rotation.z = -1.3;
        break;
      }
      default:
        break;
    }

    // Respawn pop-in.
    if (this.appearTime > 0) {
      const scale = 1 - this.appearTime / 0.6;
      this.group.scale.setScalar(0.55 + 0.45 * scale);
    } else {
      this.group.scale.setScalar(1);
    }

    // Damage flash on the armour plates.
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.4);
    const flash = this.hitFlash * (reducedMotion ? 0.3 : 0.9);
    for (const material of this.bodyMaterials) {
      material.emissive.setRGB(flash * 0.55, flash * 0.08, flash * 0.05);
    }
    for (const material of this.accentMaterials) {
      material.emissive.setRGB(flash * 0.4, flash * 0.1, flash * 0.05);
    }

    // Health bar.
    const target = snapshot.hp / 100;
    this.displayedHealth += (target - this.displayedHealth) * Math.min(1, dt * 8);
    const ratio = Math.max(0, Math.min(1, this.displayedHealth));
    this.healthFill.scale.set(Math.max(0.001, 0.96 * ratio), 0.07, 1);
    const color = ratio > 0.6 ? 0x7ddc6a : ratio > 0.3 ? 0xe8c04a : 0xe2583f;
    (this.healthFill.material as THREE.SpriteMaterial).color.setHex(color);
    const showBar = snapshot.alive;
    this.healthBack.visible = showBar;
    this.healthFill.visible = showBar;
    this.nameTag.visible = snapshot.alive;

    // Spawn protection shield.
    this.shield.visible = snapshot.prot;
    if (snapshot.prot) {
      const pulse = 0.9 + Math.sin(t * 10) * 0.08;
      this.shield.scale.setScalar(pulse);
      (this.shield.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.abs(Math.sin(t * 6)) * 0.12;
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const material of [...this.bodyMaterials, ...this.accentMaterials]) material.dispose();
    for (const resource of this.disposables.splice(0)) resource.dispose();
  }
}
