/**
 * Immersive display helpers.
 *
 * On phones and tablets the game should fill the screen and sit in landscape —
 * the arena is a wide third-person brawler and the touch layout is designed for
 * it. Browsers only grant fullscreen and orientation locks from a user gesture,
 * so `enterImmersiveMode` is called directly from the menu buttons.
 *
 * Everything degrades gracefully: iOS Safari has no orientation lock and
 * desktop browsers ignore it, so the rotate prompt is a fallback, never a hard
 * requirement.
 */

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape' | 'portrait' | 'any') => Promise<void>;
};

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** True for phones/tablets (coarse pointer or a touch event surface). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarse || 'ontouchstart' in window;
}

/** True when the viewport is taller than it is wide. */
export function isPortrait(): boolean {
  if (typeof window === 'undefined') return false;
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return height > width;
}

/** True when the document is currently fullscreen. */
export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement);
}

/**
 * Try to go fullscreen and lock the orientation to landscape.
 * Must be called synchronously from a user gesture (a click/tap handler).
 * Never throws: an unsupported or refused request is normal.
 */
export async function enterImmersiveMode(): Promise<void> {
  if (typeof document === 'undefined') return;

  if (!isFullscreen()) {
    const root = document.documentElement as WebkitFullscreenElement;
    try {
      const request = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
      const result = request?.();
      if (result instanceof Promise) await result;
    } catch {
      /* Refused (no gesture, or an embedded frame): keep playing windowed. */
    }
  }

  try {
    const orientation = screen.orientation as LockableOrientation | undefined;
    await orientation?.lock?.('landscape');
  } catch {
    /* No lock support (iOS) — the rotate prompt covers this case. */
  }
}

/**
 * Subscribe to viewport-orientation changes. Uses the media query where it is
 * reliable and a resize listener as a backstop, because some mobile browsers
 * stop reporting orientation changes while in fullscreen.
 * Returns an unsubscribe function.
 */
export function watchOrientation(callback: (portrait: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  let last = isPortrait();
  const notify = (): void => {
    const next = isPortrait();
    if (next === last) return;
    last = next;
    callback(next);
  };

  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait)') : null;
  query?.addEventListener?.('change', notify);
  window.addEventListener('resize', notify);
  window.addEventListener('orientationchange', notify);
  window.visualViewport?.addEventListener('resize', notify);

  return () => {
    query?.removeEventListener?.('change', notify);
    window.removeEventListener('resize', notify);
    window.removeEventListener('orientationchange', notify);
    window.visualViewport?.removeEventListener('resize', notify);
  };
}

interface WakeLockSentinel {
  release: () => Promise<void>;
  addEventListener: (type: 'release', callback: () => void) => void;
}

let wakeLock: WakeLockSentinel | null = null;
let watchingVisibility = false;

/**
 * Ask the OS to keep the display awake for the duration of the match.
 *
 * A screen wake lock is released automatically whenever the page is hidden, so
 * the acquisition is re-run on `visibilitychange` instead of handing the caller
 * a handle it would have to remember to release. Safe to call repeatedly and
 * from any browser: one that lacks the API simply does nothing.
 */
export async function requestWakeLock(): Promise<void> {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
  };
  if (!nav.wakeLock || typeof document === 'undefined') return;

  if (!watchingVisibility) {
    watchingVisibility = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    });
  }

  if (wakeLock) return;
  try {
    const lock = await nav.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    /* Denied (battery saver, not visible): the game still runs. */
  }
}
