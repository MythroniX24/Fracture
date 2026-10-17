/**
 * Out-of-match screens: main menu, lobby, results, controls/help and settings.
 * All of them are driven by authoritative room state from the server.
 */
import { useEffect, useState } from 'react';
import { MAX_PLAYERS } from '@fracture/shared';
import type { MatchResults, RoomSummary } from '@fracture/shared';
import type { Settings } from '../state/store.js';

function swatchColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export interface MainMenuProps {
  settings: Settings;
  status: string;
  error: string | null;
  busy: boolean;
  /** Room code from an invite link (?room=ABCD2). */
  initialCode?: string;
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  onNameChange?: (name: string) => void;
}

export function MainMenu({
  settings,
  status,
  error,
  busy,
  initialCode = '',
  onCreate,
  onJoin,
  onOpenHelp,
  onOpenSettings,
  onNameChange,
}: MainMenuProps): React.ReactElement {
  const [name, setName] = useState(settings.name);
  const [code, setCode] = useState(initialCode);
  const [mode, setMode] = useState<'idle' | 'join'>(initialCode.length === 5 ? 'join' : 'idle');

  return (
    <div className="screen">
      <div className="panel">
        <div className="title-block">
          <h1>FRACTURE</h1>
          <p>Arena brawler · 2–4 players · ancient ruins</p>
        </div>

        <label className="field">
          <span>Fighter name</span>
          <input
            type="text"
            value={name}
            maxLength={14}
            placeholder="Fighter"
            onChange={(event) => {
              setName(event.target.value);
              onNameChange?.(event.target.value);
            }}
            autoComplete="off"
          />
        </label>

        {mode === 'idle' ? (
          <div className="btn-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => onCreate(name.trim() || 'Fighter')}
            >
              {busy ? 'Connecting…' : 'Create room'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMode('join')}>
              Join room
            </button>
          </div>
        ) : (
          <div>
            <label className="field">
              <span>Room code</span>
              <input
                className="code-input"
                type="text"
                value={code}
                maxLength={5}
                placeholder="ABCD2"
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                autoComplete="off"
              />
            </label>
            <div className="btn-row">
              <button
                type="button"
                className="btn primary"
                disabled={busy || code.length !== 5}
                onClick={() => onJoin(code, name.trim() || 'Fighter')}
              >
                {busy ? 'Joining…' : 'Join'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setMode('idle')}>
                Back
              </button>
            </div>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: '0.85rem' }}>
          <button type="button" className="btn ghost" onClick={onOpenHelp}>
            Controls &amp; About
          </button>
          <button type="button" className="btn ghost" onClick={onOpenSettings}>
            Settings
          </button>
        </div>

        <p className="hint" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
          {status === 'online'
            ? 'Connected to the arena server.'
            : status === 'reconnecting'
              ? 'Reconnecting to the arena server…'
              : 'Create a private room and share the 5-character code with up to three friends.'}
        </p>
        {error ? <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      </div>
    </div>
  );
}

export interface LobbyProps {
  room: RoomSummary;
  selfId: string;
  isHost: boolean;
  notice: string | null;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  onOpenHelp: () => void;
}

export function Lobby({
  room,
  selfId,
  isHost,
  notice,
  onReady,
  onStart,
  onLeave,
  onOpenHelp,
}: LobbyProps): React.ReactElement {
  const self = room.players.find((player) => player.id === selfId);
  const connected = room.players.filter((player) => player.connected).length;
  const humans = room.players.filter((player) => player.connected && !player.bot).length;
  const solo = humans < 2;
  const matchmaking = room.matchmakingRemainingMs > 0;
  const soloSeconds = Math.max(0, Math.ceil(room.matchmakingRemainingMs / 1000));
  const notReady = room.players.filter((player) => player.connected && !player.ready && player.id !== room.hostId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const slots = Array.from({ length: room.maxPlayers }, (_, index) => {
    const player = room.players.find((entry) => entry.slot === index);
    return { index, player };
  });

  return (
    <div className="screen">
      <div className="panel">
        <h2>Arena lobby</h2>
        <p className="hint">
          Share the room code. Waiting on your own? Bots fill the arena — the match starts on its
          own, or immediately if you press start.
        </p>

        {matchmaking ? (
          <div className="matchmaking" role="status">
            <span className="matchmaking__pulse" aria-hidden />
            <div className="matchmaking__text">
              <strong>Finding opponents…</strong>
              <small>Bots take the empty slots in {soloSeconds}s — press start to face them now.</small>
            </div>
            <span className="matchmaking__count">{soloSeconds}s</span>
          </div>
        ) : null}

        <div className="room-code">
          <div>
            <small>Room code</small>
            <strong>{room.code}</strong>
          </div>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              const url = `${window.location.origin}${window.location.pathname}?room=${room.code}`;
              const clipboard = navigator.clipboard;
              if (clipboard?.writeText) {
                void clipboard.writeText(url).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }
            }}
          >
            {copied ? 'Copied!' : 'Copy invite'}
          </button>
        </div>

        <ul className="player-list">
          {slots.map(({ index, player }) => (
            <li key={index} className={`player-row${player ? '' : ' empty'}`}>
              <span
                className="swatch"
                style={{ background: player ? swatchColor(player.color) : 'transparent' }}
              />
              <span className="name">
                {player ? player.name : 'Open slot'}
                {player && player.id === selfId ? <em> (you)</em> : null}
              </span>
              {player?.bot ? <span className="badge bot">Bot</span> : null}
              {player?.host ? <span className="badge host">Host</span> : null}
              {player && !player.connected ? <span className="badge offline">Offline</span> : null}
              {player && player.connected && !player.host ? (
                <span className={`badge${player.ready ? ' ready' : ''}`}>
                  {player.ready ? 'Ready' : 'Waiting'}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="btn-row">
          {isHost ? (
            <button
              type="button"
              className="btn primary"
              disabled={connected < 1}
              onClick={onStart}
              title={solo ? 'Fill the empty slots with bots and start' : 'Start the match'}
            >
              {solo ? 'Start vs bots' : `Start match (${connected}/${MAX_PLAYERS})`}
            </button>
          ) : (
            <button
              type="button"
              className={`btn${self?.ready ? '' : ' primary'}`}
              onClick={() => onReady(!self?.ready)}
            >
              {self?.ready ? 'Not ready' : 'Ready up'}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onOpenHelp}>
            Controls
          </button>
          <button type="button" className="btn ghost" onClick={onLeave}>
            Leave
          </button>
        </div>

        {isHost && !solo && notReady.length > 0 ? (
          <p className="hint" style={{ marginTop: '0.8rem', marginBottom: 0 }}>
            Waiting on {notReady.map((player) => player.name).join(', ')} — you can still start.
          </p>
        ) : null}
        {solo ? (
          <p className="hint" style={{ marginTop: '0.8rem', marginBottom: 0 }}>
            Solo practice uses the same ultra-tier bots: predictive aim, orbital spacing and a habit of
            breaking the platform under your feet.
          </p>
        ) : null}
        {notice ? (
          <p className="hint" style={{ color: 'var(--bronze)', marginBottom: 0 }}>
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface ResultsProps {
  results: MatchResults;
  selfId: string;
  isHost: boolean;
  onRematch: () => void;
  onLeave: () => void;
}

export function ResultsScreen({ results, selfId, isHost, onRematch, onLeave }: ResultsProps): React.ReactElement {
  const selfEntry = results.scores.find((entry) => entry.playerId === selfId);
  const won = selfEntry ? results.winners.includes(selfEntry.playerId) : false;

  return (
    <div className="screen">
      <div className="panel">
        <h2>{won ? (results.tie ? 'Shared victory' : 'Victory') : 'Match complete'}</h2>
        <p className="hint">
          {results.tie
            ? 'Rank 1 is shared — the scores are tied.'
            : 'Highest score wins. Falls and eliminations are tracked below.'}
        </p>

        <table className="results-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Fighter</th>
              <th>Score</th>
              <th>KOs</th>
              <th>Falls</th>
            </tr>
          </thead>
          <tbody>
            {results.scores.map((entry) => (
              <tr
                key={entry.playerId}
                className={results.winners.includes(entry.playerId) ? 'winner' : ''}
              >
                <td className="rank">{entry.rank}</td>
                <td>
                  <span className="swatch" style={{ background: swatchColor(entry.color), display: 'inline-block', marginRight: 8 }} />
                  {entry.name}
                  {entry.playerId === selfId ? ' (you)' : ''}
                </td>
                <td>{entry.score}</td>
                <td>{entry.eliminations}</td>
                <td>{entry.falls}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="hint">Match length: {(results.durationMs / 60000).toFixed(2)} minutes.</p>

        <div className="btn-row">
          {isHost ? (
            <button type="button" className="btn primary" onClick={onRematch}>
              Rematch
            </button>
          ) : (
            <button type="button" className="btn" disabled title="Only the host can start a rematch">
              Waiting for host
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onLeave}>
            Return to menu
          </button>
        </div>
      </div>
    </div>
  );
}

export function HelpOverlay({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div className="screen">
      <div className="panel">
        <h2>Controls &amp; about</h2>
        <p className="hint">
          FRACTURE is a third-person physics brawler for 2–4 players. Eliminations score 1 point; a
          fall credits the last fighter who damaged you within 5 seconds. Highest score at 5:00 wins.
        </p>
        <div className="help-grid">
          <div>
            <span>Move</span>
            <span>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd>
            </span>
          </div>
          <div>
            <span>Look / aim</span>
            <span>Mouse (click to lock)</span>
          </div>
          <div>
            <span>Jump</span>
            <span>
              <kbd>Space</kbd>
            </span>
          </div>
          <div>
            <span>Dodge (grounded)</span>
            <span>
              <kbd>Shift</kbd>
            </span>
          </div>
          <div>
            <span>Punch</span>
            <span>Left click</span>
          </div>
          <div>
            <span>Gravity Shot</span>
            <span>Right click</span>
          </div>
          <div>
            <span>Shockwave</span>
            <span>
              <kbd>Q</kbd>
            </span>
          </div>
          <div>
            <span>Platform Break</span>
            <span>
              <kbd>E</kbd>
            </span>
          </div>
          <div>
            <span>Pause / settings</span>
            <span>
              <kbd>Esc</kbd>
            </span>
          </div>
        </div>
        <p className="hint">
          On touch devices the game goes fullscreen in landscape automatically: the left stick moves,
          dragging the right half looks around, and the ability buttons sit under your thumbs. The
          match clock keeps running while paused — a single player can never pause the arena. If
          nobody joins within 15 seconds the match starts against bots instead.
        </p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export interface SettingsProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsOverlay({ settings, onChange, onClose }: SettingsProps): React.ReactElement {
  const update = (partial: Partial<Settings>): void => {
    onChange({ ...settings, ...partial });
  };

  return (
    <div className="screen">
      <div className="panel">
        <h2>Settings</h2>
        <p className="hint">Stored locally in this browser. They apply instantly.</p>

        <div className="settings-row">
          <label htmlFor="sensitivity">
            <span>Look sensitivity</span>
            <span>{settings.lookSensitivity.toFixed(2)}×</span>
          </label>
          <input
            id="sensitivity"
            type="range"
            min={0.3}
            max={2.5}
            step={0.05}
            value={settings.lookSensitivity}
            onChange={(event) => update({ lookSensitivity: Number(event.target.value) })}
          />
        </div>

        <div className="settings-row">
          <label htmlFor="volume">
            <span>Volume</span>
            <span>{Math.round(settings.volume * 100)}%</span>
          </label>
          <input
            id="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            disabled={settings.muted}
            onChange={(event) => update({ volume: Number(event.target.value) })}
          />
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.muted}
            onChange={(event) => update({ muted: event.target.checked })}
          />
          Mute all audio
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.reducedMotion}
            onChange={(event) => update({ reducedMotion: event.target.checked })}
          />
          Reduce motion (fewer particles, no camera shake)
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.showFps}
            onChange={(event) => update({ showFps: event.target.checked })}
          />
          Show FPS counter
        </label>

        <div className="btn-row">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export interface OrientationProps {
  /** True when the document is already fullscreen (changes the button label). */
  fullscreen: boolean;
  onGoLandscape: () => void;
}

/**
 * Blocking rotate prompt for touch devices held in portrait. Fullscreen and an
 * orientation lock are both attempted by the caller; this is the fallback for
 * browsers (notably iOS Safari) that do not implement `screen.orientation.lock`.
 */
export function OrientationOverlay({ fullscreen, onGoLandscape }: OrientationProps): React.ReactElement {
  return (
    <div className="orientation-overlay" role="alertdialog" aria-label="Rotate your device">
      <div className="orientation-card">
        <div className="rotate-glyph" aria-hidden>
          <span />
        </div>
        <h2>Rotate to landscape</h2>
        <p>
          FRACTURE is a wide arena brawler. Landscape gives you the full field of view and puts every
          ability under your thumbs.
        </p>
        <button type="button" className="btn primary" onClick={onGoLandscape}>
          {fullscreen ? 'Lock to landscape' : 'Go fullscreen'}
        </button>
      </div>
    </div>
  );
}

export function PauseOverlay({
  onResume,
  onOpenSettings,
  onOpenHelp,
  onLeave,
}: {
  onResume: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onLeave: () => void;
}): React.ReactElement {
  return (
    <div className="screen">
      <div className="panel">
        <h2>Paused</h2>
        <p className="hint">
          Input is released locally, but the match keeps running — you cannot pause the arena for the
          other fighters.
        </p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={onResume}>
            Resume
          </button>
          <button type="button" className="btn ghost" onClick={onOpenHelp}>
            Controls
          </button>
          <button type="button" className="btn ghost" onClick={onOpenSettings}>
            Settings
          </button>
          <button type="button" className="btn ghost" onClick={onLeave}>
            Leave match
          </button>
        </div>
      </div>
    </div>
  );
}
