/**
 * FRACTURE application shell.
 *
 * Owns the network client, renderer, audio engine and input manager, and routes
 * between the menu, lobby, in-match HUD, results screen and overlays. Screen
 * decisions come from authoritative room state; the simulated world is rendered
 * behind the menus at all times.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MatchResults, RoomSummary } from '@fracture/shared';
import { NetClient, type ConnectionStatus } from './net/NetClient.js';
import {
  HudStore,
  loadSettings,
  saveSettings,
  type Settings,
} from './state/store.js';
import { AudioEngine } from './audio.js';
import { InputManager } from './game/input.js';
import { Game } from './game/Game.js';
import {
  enterImmersiveMode,
  isFullscreen,
  isPortrait,
  isTouchDevice,
  requestWakeLock,
  watchOrientation,
} from './game/display.js';
import { Hud } from './ui/Hud.js';
import {
  HelpOverlay,
  Lobby,
  MainMenu,
  OrientationOverlay,
  PauseOverlay,
  ResultsScreen,
  SettingsOverlay,
} from './ui/Screens.js';

type Overlay = 'none' | 'help' | 'settings' | 'pause';

export function App(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const netRef = useRef<NetClient | null>(null);
  const storeRef = useRef<HudStore | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const inputRef = useRef<InputManager | null>(null);
  const gameRef = useRef<Game | null>(null);

  if (!netRef.current) netRef.current = new NetClient();
  if (!storeRef.current) storeRef.current = new HudStore();
  if (!audioRef.current) audioRef.current = new AudioEngine();

  const net = netRef.current;
  const store = storeRef.current;
  const audio = audioRef.current;

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [results, setResults] = useState<MatchResults | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [busy, setBusy] = useState(false);
  const [isTouch] = useState(isTouchDevice);
  const [portrait, setPortrait] = useState(isPortrait);
  const [fullscreen, setFullscreen] = useState(isFullscreen);

  const hud = useSyncExternalStore(store.subscribe, () => store.snapshot);

  // Keep the rotate prompt and the fullscreen button in sync with the device.
  useEffect(() => watchOrientation(setPortrait), []);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = (): void => setFullscreen(isFullscreen());
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // -------------------------------------------------------------------------
  // Bootstrap renderer + input + network subscriptions (once)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const input = new InputManager({
      canvas,
      onPauseToggle: () => setOverlay((current) => (current === 'pause' ? 'none' : 'pause')),
      onPointerLockChange: () => {
        /* pointer lock only affects desktop look; nothing to persist */
      },
      onFirstInteraction: () => audio.unlock(),
      onPulse: () => audio.unlock(),
    });
    input.attach();
    inputRef.current = input;

    const game = new Game({
      canvas,
      net,
      store,
      input,
      audio,
      settings,
      isTouch,
    });
    gameRef.current = game;
    game.start();

    const unsubscribe = net.subscribe({
      onRoom: (next) => {
        setRoom(next);
        setBusy(false);
        setError(null);
      },
      onStatus: (next) => {
        setStatus(next);
        if (next === 'offline') {
          setRoom(null);
        }
      },
      onError: (code, message) => {
        setBusy(false);
        setError(message);
        if (code === 'room-not-found' || code === 'room-full' || code === 'bad-message') {
          setRoom(null);
        }
      },
      onResults: (next) => setResults(next),
      onNotice: (message) => setNotice(message),
      onJoined: () => {
        setBusy(false);
        setError(null);
        setResults(null);
      },
    });

    return () => {
      unsubscribe();
      game.dispose();
      input.dispose();
      inputRef.current = null;
      gameRef.current = null;
    };
    // Intentionally runs once: `settings` changes are pushed through updateSettings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply settings everywhere they matter.
  useEffect(() => {
    saveSettings(settings);
    audio.setVolume(settings.volume);
    audio.setMuted(settings.muted);
    gameRef.current?.updateSettings(settings);
    if (inputRef.current) {
      inputRef.current.sensitivity = settings.lookSensitivity;
    }
  }, [settings, audio]);

  // Enable input only while the player is actually fighting.
  const playing = room !== null && (hud.phase === 'combat' || hud.phase === 'countdown');
  const controlsActive = playing && overlay === 'none';
  useEffect(() => {
    const input = inputRef.current;
    document.body.dataset.playing = controlsActive ? 'true' : 'false';
    if (!input) return;
    input.enabled = controlsActive;
    input.paused = overlay === 'pause';
    if (!controlsActive) {
      input.releaseAll();
      if (typeof document.exitPointerLock === 'function' && document.pointerLockElement) {
        document.exitPointerLock();
      }
    }
    return () => {
      document.body.dataset.playing = 'false';
    };
  }, [controlsActive, overlay]);

  // Auto-dismiss transient messages.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Starting a match is a user gesture, which is the only moment browsers allow
   * fullscreen + a landscape lock. On touch devices we take it, then ask for a
   * screen wake lock so a five-minute match cannot dim mid-fight.
   */
  const goImmersive = useCallback(() => {
    if (!isTouchDevice()) return;
    void enterImmersiveMode();
    void requestWakeLock();
  }, []);

  const handleCreate = useCallback(
    (name: string) => {
      goImmersive();
      audio.unlock();
      audio.uiClick();
      setBusy(true);
      setError(null);
      net.setName(name);
      net.createRoom(name);
    },
    [audio, goImmersive, net],
  );

  const handleJoin = useCallback(
    (code: string, name: string) => {
      goImmersive();
      audio.unlock();
      audio.uiClick();
      setBusy(true);
      setError(null);
      net.setName(name);
      net.joinRoom(code, name);
    },
    [audio, goImmersive, net],
  );

  const handleLeave = useCallback(() => {
    audio.uiClick();
    net.leaveRoom();
    setRoom(null);
    setResults(null);
    setOverlay('none');
    store.reset();
  }, [audio, net, store]);

  const handleRematch = useCallback(() => {
    audio.uiClick();
    net.requestRematch();
  }, [audio, net]);

  const openOverlay = useCallback((next: Overlay) => {
    setOverlay(next);
  }, []);

  const initialRoomCode = (() => {
    if (typeof window === 'undefined') return '';
    return (new URLSearchParams(window.location.search).get('room') ?? '').toUpperCase();
  })();

  const selfId = hud.selfId || net.playerId || '';
  const isHost = room?.hostId === selfId;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <>
      <canvas id="game-canvas" ref={canvasRef} />

      {room === null ? (
        <MainMenu
          settings={settings}
          status={status}
          error={error ?? notice}
          busy={busy}
          onCreate={handleCreate}
          onJoin={handleJoin}
          onOpenHelp={() => openOverlay('help')}
          onOpenSettings={() => openOverlay('settings')}
          initialCode={initialRoomCode}
        />
      ) : null}

      {room !== null && room.phase === 'lobby' ? (
        <Lobby
          room={room}
          selfId={selfId}
          isHost={isHost}
          notice={notice}
          onReady={(ready) => net.setReady(ready)}
          onStart={() => net.requestStart()}
          onLeave={handleLeave}
          onOpenHelp={() => openOverlay('help')}
        />
      ) : null}

      {room !== null ? (
        <Hud
          hud={hud}
          fps={gameRef.current?.fps ?? 0}
          showFps={settings.showFps}
          isTouch={isTouch}
          input={inputRef.current as InputManager}
          controlsActive={controlsActive}
        />
      ) : null}

      {room !== null && room.phase === 'results' && results ? (
        <ResultsScreen
          results={results}
          selfId={selfId}
          isHost={isHost}
          onRematch={handleRematch}
          onLeave={handleLeave}
        />
      ) : null}

      {notificationBanner(status, notice, error)}

      {overlay === 'help' ? <HelpOverlay onClose={() => setOverlay('none')} /> : null}
      {overlay === 'settings' ? (
        <SettingsOverlay
          settings={settings}
          onChange={setSettings}
          onClose={() => setOverlay('none')}
        />
      ) : null}
      {overlay === 'pause' ? (
        <PauseOverlay
          onResume={() => setOverlay('none')}
          onOpenHelp={() => setOverlay('help')}
          onOpenSettings={() => setOverlay('settings')}
          onLeave={handleLeave}
        />
      ) : null}

      {isTouch && portrait ? (
        <OrientationOverlay
          fullscreen={fullscreen}
          onGoLandscape={() => void enterImmersiveMode()}
        />
      ) : null}
    </>
  );
}

function notificationBanner(
  status: ConnectionStatus,
  notice: string | null,
  error: string | null,
): React.ReactElement | null {
  if (status === 'reconnecting') {
    return <div className="notice">{notice ?? 'Reconnecting to the arena…'}</div>;
  }
  if (status === 'offline' && error) {
    return <div className="notice">{error}</div>;
  }
  if (notice) return <div className="notice">{notice}</div>;
  return null;
}
