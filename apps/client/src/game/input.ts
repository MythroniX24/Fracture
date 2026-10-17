/**
 * Input manager.
 *
 * Owns the player's *intent*: `moveX/moveZ` (unit clamped), absolute
 * `yaw/pitch`, held buttons and one-frame pulses. It never produces positions,
 * so nothing here can be used to cheat.
 *
 * Sources: keyboard + pointer lock on desktop, virtual joystick + drag-look +
 * on-screen buttons on touch devices. Both may be active at the same time.
 */
import { PLAYER, clamp } from '@fracture/shared';

export type PulseButton = 'punch' | 'gravity' | 'shockwave' | 'breakPlatform';
export type HeldButton = 'jump' | 'dodge';
export type ButtonName = PulseButton | HeldButton;

export interface InputFrame {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  dodge: boolean;
  punch: boolean;
  gravity: boolean;
  shockwave: boolean;
  breakPlatform: boolean;
}

export interface InputManagerOptions {
  canvas: HTMLCanvasElement;
  onPauseToggle: () => void;
  onPointerLockChange: (locked: boolean) => void;
  onFirstInteraction?: () => void;
  /** One-frame pulses (used to fire audio/effects immediately on press). */
  onPulse?: (button: PulseButton) => void;
}

const KEY_BINDINGS: Record<string, HeldButton | PulseButton> = {
  Space: 'jump',
  ShiftLeft: 'dodge',
  ShiftRight: 'dodge',
  KeyQ: 'shockwave',
  KeyE: 'breakPlatform',
};

const MAX_PITCH = PLAYER.pitchMax;

export class InputManager {
  yaw = 0;
  pitch = 0;
  /** Movement intent in local space, -1..1. */
  moveX = 0;
  moveZ = 0;
  /** True while the game is playing (menus lock input out). */
  enabled = false;
  paused = false;
  pointerLocked = false;
  sensitivity = 1;

  private held: Record<HeldButton, boolean> = { jump: false, dodge: false };
  private pulses: Record<PulseButton, boolean> = {
    punch: false,
    gravity: false,
    shockwave: false,
    breakPlatform: false,
  };
  /** Buttons still physically down (touch/keyboard) for repeat handling. */
  private keyDown = new Set<string>();
  private joystick = { x: 0, y: 0 };
  private keys = { forward: false, back: false, left: false, right: false };
  private disposers: Array<() => void> = [];
  private options: InputManagerOptions;

  constructor(options: InputManagerOptions) {
    this.options = options;
  }

  attach(): void {
    const { canvas } = this.options;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        this.options.onPauseToggle();
        return;
      }
      if (this.isTypingTarget(event.target)) return;
      if (this.keyDown.has(event.code)) return;
      this.keyDown.add(event.code);

      const binding = KEY_BINDINGS[event.code];
      if (binding === 'jump' || binding === 'dodge') {
        this.held[binding] = true;
      } else if (binding) {
        this.pulses[binding] = true;
        this.options.onPulse?.(binding);
      }
      if (this.handleMovementKey(event.code, true)) event.preventDefault();
      if (binding) event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      this.keyDown.delete(event.code);
      const binding = KEY_BINDINGS[event.code];
      if (binding === 'jump' || binding === 'dodge') this.held[binding] = false;
      this.handleMovementKey(event.code, false);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (!this.enabled) return;
      if (event.button === 0) {
        this.pulses.punch = true;
        this.options.onPulse?.('punch');
      } else if (event.button === 2) {
        this.pulses.gravity = true;
        this.options.onPulse?.('gravity');
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.applyLook(event.movementX, event.movementY);
    };

    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      this.options.onPointerLockChange(this.pointerLocked);
    };

    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    const onCanvasClick = () => {
      this.options.onFirstInteraction?.();
      if (!this.enabled) return;
      if (!this.pointerLocked && typeof canvas.requestPointerLock === 'function') {
        void canvas.requestPointerLock();
      }
    };

    const onBlur = () => this.releaseAll();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    this.disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('click', onCanvasClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || target.isContentEditable;
  }

  private handleMovementKey(code: string, down: boolean): boolean {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.forward = down;
        return true;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.back = down;
        return true;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = down;
        return true;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = down;
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Touch API (driven by the on-screen controls)
  // -------------------------------------------------------------------------

  setJoystick(x: number, y: number): void {
    this.joystick.x = clamp(x, -1, 1);
    this.joystick.y = clamp(y, -1, 1);
  }

  setLookDelta(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.applyLook(dx, dy);
  }

  pressButton(button: ButtonName): void {
    if (button === 'jump' || button === 'dodge') {
      this.held[button] = true;
      return;
    }
    this.pulses[button] = true;
    this.options.onPulse?.(button);
  }

  releaseButton(button: HeldButton): void {
    this.held[button] = false;
  }

  /** Drop every input (pause, disconnect, focus loss). */
  releaseAll(): void {
    this.keyDown.clear();
    this.keys.forward = this.keys.back = this.keys.left = this.keys.right = false;
    this.held.jump = false;
    this.held.dodge = false;
    this.pulses.punch = this.pulses.gravity = this.pulses.shockwave = this.pulses.breakPlatform = false;
    this.joystick.x = 0;
    this.joystick.y = 0;
  }

  // -------------------------------------------------------------------------

  private applyLook(dx: number, dy: number): void {
    const scale = 0.0022 * this.sensitivity;
    this.yaw -= dx * scale;
    this.pitch = clamp(this.pitch - dy * scale, -MAX_PITCH, MAX_PITCH);
    // Keep yaw bounded so it never loses precision in long sessions.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Set the aim angles directly (used when respawning/joining). */
  setAim(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH);
  }

  /** Combine keyboard and joystick movement into -1..1 intent. */
  private computeMove(): { moveX: number; moveZ: number } {
    let x = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    let z = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
    if (Math.abs(this.joystick.x) > 0.01 || Math.abs(this.joystick.y) > 0.01) {
      x += this.joystick.x;
      z += this.joystick.y;
    }
    const length = Math.hypot(x, z);
    if (length > 1) {
      x /= length;
      z /= length;
    }
    return { moveX: x, moveZ: z };
  }

  /**
   * Read the current intent **without** clearing pulses. Used by local
   * prediction every frame; the pulses must survive until the fixed-rate send.
   */
  peek(): InputFrame {
    const move = this.computeMove();
    this.moveX = move.moveX;
    this.moveZ = move.moveZ;
    return {
      moveX: move.moveX,
      moveZ: move.moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.held.jump,
      dodge: this.held.dodge,
      punch: this.pulses.punch,
      gravity: this.pulses.gravity,
      shockwave: this.pulses.shockwave,
      breakPlatform: this.pulses.breakPlatform,
    };
  }

  /**
   * Build the frame to send, clearing one-frame pulses. Called at a fixed rate
   * by the game loop (never per rendered frame) so every press reaches the
   * server exactly once.
   */
  consume(): InputFrame {
    const frame = this.peek();
    this.pulses.punch = false;
    this.pulses.gravity = false;
    this.pulses.shockwave = false;
    this.pulses.breakPlatform = false;
    return frame;
  }
}
