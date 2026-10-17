/**
 * Tiny external stores consumed by React through `useSyncExternalStore`.
 *
 * The renderer writes HUD values at ~10 Hz (never per frame) so React re-renders
 * stay cheap while the WebGL loop runs at full speed.
 */
import type { MatchPhase, PlayerSnapshot } from '@fracture/shared';
import type { ConnectionStatus } from '../net/NetClient.js';

export interface KillFeedEntry {
  id: string;
  kind: 'elimination' | 'platform' | 'info';
  text: string;
  at: number;
}

export interface HudState {
  phase: MatchPhase;
  matchRemainingMs: number;
  countdownRemainingMs: number;
  selfId: string;
  self: PlayerSnapshot | null;
  players: PlayerSnapshot[];
  killFeed: KillFeedEntry[];
  status: ConnectionStatus;
  pingMs: number;
  notice: string | null;
  /** Last rejected ability, e.g. "Not enough energy". */
  lastDenial: string | null;
  /** Destructible platform currently under the reticle (Platform Break). */
  breakTargetName: string | null;
  /** Crosshair state: true when an enemy is within punch reach. */
  punchReady: boolean;
}

export const initialHudState: HudState = {
  phase: 'lobby',
  matchRemainingMs: 0,
  countdownRemainingMs: 0,
  selfId: '',
  self: null,
  players: [],
  killFeed: [],
  status: 'idle',
  pingMs: 0,
  notice: null,
  lastDenial: null,
  breakTargetName: null,
  punchReady: false,
};

export class HudStore {
  private state: HudState = initialHudState;
  private listeners = new Set<() => void>();

  get snapshot(): HudState {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(partial: Partial<HudState>): void {
    let changed = false;
    for (const key of Object.keys(partial) as Array<keyof HudState>) {
      if (this.state[key] !== partial[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.state = { ...initialHudState, status: this.state.status };
    for (const listener of this.listeners) listener();
  }
}

export function hudStateFromSnapshot(
  snapshot: { phase: MatchPhase; matchRemainingMs: number; countdownRemainingMs: number },
): Partial<HudState> {
  return {
    phase: snapshot.phase,
    matchRemainingMs: snapshot.matchRemainingMs,
    countdownRemainingMs: snapshot.countdownRemainingMs,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  name: string;
  lookSensitivity: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
  reducedMotion: boolean;
  showFps: boolean;
}

const SETTINGS_KEY = 'fracture.settings.v1';

export const defaultSettings: Settings = {
  name: '',
  lookSensitivity: 1,
  volume: 0.6,
  muted: false,
  reducedMotion:
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  showFps: false,
};

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage may be unavailable */
  }
}
