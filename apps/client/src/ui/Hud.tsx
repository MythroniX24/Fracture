/**
 * In-game HUD.
 *
 * Health, energy, ability readiness, Platform Break charges, match timer, all
 * players' scores, the event feed, connection state and touch controls. All
 * values come from authoritative snapshots.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PLATFORM_BREAK, PUNCH, GRAVITY_SHOT, SHOCKWAVE } from '@fracture/shared';
import type { PlayerSnapshot } from '@fracture/shared';
import type { HudState } from '../state/store.js';
import type { InputManager } from '../game/input.js';

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function Scoreboard({ hud }: { hud: HudState }): ReactElement {
  const sorted = [...hud.players].sort((a, b) => b.score - a.score || b.kills - a.kills);
  return (
    <div className="scoreboard" aria-label="Scores">
      {sorted.map((player) => (
        <div key={player.id} className={`score-row${player.id === hud.selfId ? ' self' : ''}`}>
          <span
            className="swatch"
            style={{ background: `#${player.color.toString(16).padStart(6, '0')}` }}
          />
          <span className="name">
            {player.name}
            {player.bot ? <em className="bot-tag">BOT</em> : null}
            {!player.connected ? ' (offline)' : ''}
          </span>
          <span className="hp-mini" title={`${Math.round(player.hp)} HP`}>
            <i style={{ width: `${Math.max(0, Math.min(100, player.hp))}%` }} />
          </span>
          <span>{player.score}</span>
        </div>
      ))}
    </div>
  );
}

function AbilityTiles({ self }: { self: PlayerSnapshot }): ReactElement {
  const abilities = [
    { key: 'Punch', hint: 'LMB', cd: self.cd[0], cost: 0, cooldown: PUNCH.cooldownMs },
    { key: 'Gravity', hint: 'RMB', cd: self.cd[1], cost: GRAVITY_SHOT.energyCost, cooldown: GRAVITY_SHOT.cooldownMs },
    { key: 'Shockwave', hint: 'Q', cd: self.cd[2], cost: SHOCKWAVE.energyCost, cooldown: SHOCKWAVE.cooldownMs },
    { key: 'Break', hint: 'E', cd: self.cd[3], cost: 0, cooldown: 0 },
  ];
  return (
    <div className="abilities">
      {abilities.map((ability) => {
        const onCooldown = ability.cd > 1;
        const lacksEnergy = ability.cost > 0 && self.en < ability.cost;
        const isBreak = ability.key === 'Break';
        const noCharges = isBreak && self.charges <= 0;
        const ready = !onCooldown && !lacksEnergy && !noCharges && self.alive;
        return (
          <div
            key={ability.key}
            className={`ability ${ready ? 'ready' : 'charging'}`}
            title={`${ability.key} — ${ability.cost > 0 ? `${ability.cost} energy` : 'no energy cost'}`}
          >
            <span className="name">{ability.key}</span>
            <span className="key">{ability.hint}</span>
            {isBreak ? <span className="charges">{self.charges}/{PLATFORM_BREAK.charges}</span> : null}
            {onCooldown ? (
              <span className="cd">{(ability.cd / 1000).toFixed(1)}s</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function KillFeed({ hud }: { hud: HudState }): ReactElement | null {
  if (hud.killFeed.length === 0) return null;
  return (
    <div className="killfeed" role="log" aria-live="polite">
      {hud.killFeed.map((entry) => (
        <div key={entry.id} className={entry.kind}>
          {entry.text}
        </div>
      ))}
    </div>
  );
}

function Joystick({ input }: { input: InputManager }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const RADIUS = 46;

  const apply = (clientX: number, clientY: number): void => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    if (length > RADIUS) {
      dx = (dx / length) * RADIUS;
      dy = (dy / length) * RADIUS;
    }
    element.style.setProperty('--jx', `${dx}px`);
    element.style.setProperty('--jy', `${dy}px`);
    // Screen-up means forward (+moveZ).
    input.setJoystick(dx / RADIUS, -dy / RADIUS);
  };

  const reset = (): void => {
    pointerId.current = null;
    const element = ref.current;
    element?.style.setProperty('--jx', '0px');
    element?.style.setProperty('--jy', '0px');
    input.setJoystick(0, 0);
  };

  return (
    <div
      ref={ref}
      className="joystick"
      aria-label="Movement joystick"
      onPointerDown={(event) => {
        pointerId.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        apply(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (pointerId.current !== event.pointerId) return;
        apply(event.clientX, event.clientY);
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
    >
      <i />
    </div>
  );
}

function LookArea({ input }: { input: InputManager }): ReactElement {
  const last = useRef<{ id: number; x: number; y: number } | null>(null);
  return (
    <div
      className="touch-controls__look"
      aria-label="Look area"
      onPointerDown={(event) => {
        last.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = last.current;
        if (!current || current.id !== event.pointerId) return;
        input.setLookDelta(event.clientX - current.x, event.clientY - current.y);
        current.x = event.clientX;
        current.y = event.clientY;
      }}
      onPointerUp={() => {
        last.current = null;
      }}
      onPointerCancel={() => {
        last.current = null;
      }}
    />
  );
}

interface TouchAbilityProps {
  label: string;
  /** Milliseconds of cooldown left (authoritative). */
  cdMs?: number;
  /** Full cooldown length, used for the radial progress ring. */
  cdTotalMs?: number;
  /** Energy cost, for the ready/low-energy state. */
  cost?: number;
  energy?: number;
  /** Remaining charges (Platform Break only). */
  charges?: number;
  maxCharges?: number;
  className?: string;
  onPress: () => void;
  onRelease?: () => void;
}

/**
 * A round touch button that carries its own state: cooldown sweep, remaining
 * charges and a low-energy warning. Keeping readiness on the button (rather
 * than in a separate tile row) is what makes the mobile HUD readable in
 * landscape — your eyes never leave your thumbs.
 */
function TouchAbility({
  label,
  cdMs = 0,
  cdTotalMs = 0,
  cost = 0,
  energy = 100,
  charges,
  maxCharges,
  className = '',
  onPress,
  onRelease,
}: TouchAbilityProps): ReactElement {
  const [pressed, setPressed] = useState(false);
  const cooling = cdMs > 1;
  const lacksEnergy = cost > 0 && energy < cost;
  const empty = charges !== undefined && charges <= 0;
  const ready = !cooling && !lacksEnergy && !empty;
  const sweep = cooling && cdTotalMs > 0 ? Math.max(0, Math.min(1, cdMs / cdTotalMs)) : 0;

  return (
    <button
      type="button"
      className={`touch-btn ${className}${pressed ? ' pressed' : ''}${ready ? ' ready' : ' spent'}`}
      style={{ '--sweep': `${Math.round(sweep * 100)}%` } as React.CSSProperties}
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setPressed(true);
        onPress();
      }}
      onPointerUp={() => {
        setPressed(false);
        onRelease?.();
      }}
      onPointerCancel={() => {
        setPressed(false);
        onRelease?.();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="touch-btn__label">{label}</span>
      {cooling ? <span className="touch-btn__cd">{(cdMs / 1000).toFixed(1)}</span> : null}
      {!cooling && lacksEnergy ? <span className="touch-btn__cd">{cost}⚡</span> : null}
      {charges !== undefined ? (
        <span className="touch-btn__charges">
          {charges}/{maxCharges ?? charges}
        </span>
      ) : null}
    </button>
  );
}

function MobileControls({
  input,
  self,
}: {
  input: InputManager;
  self: PlayerSnapshot | null;
}): ReactElement {
  const energy = self?.en ?? 100;
  const alive = self?.alive ?? false;
  return (
    <div className="touch-controls">
      <LookArea input={input} />
      <Joystick input={input} />
      <div className="touch-actions" aria-label="Abilities">
        <TouchAbility
          label="Break"
          className="break"
          charges={self?.charges}
          maxCharges={PLATFORM_BREAK.charges}
          cdMs={self?.cd[3] ?? 0}
          onPress={() => input.pressButton('breakPlatform')}
        />
        <TouchAbility
          label="Grav"
          className="grav"
          cost={GRAVITY_SHOT.energyCost}
          energy={energy}
          cdMs={self?.cd[1] ?? 0}
          cdTotalMs={GRAVITY_SHOT.cooldownMs}
          onPress={() => input.pressButton('gravity')}
        />
        <TouchAbility
          label="Shock"
          className="shock"
          cost={SHOCKWAVE.energyCost}
          energy={energy}
          cdMs={self?.cd[2] ?? 0}
          cdTotalMs={SHOCKWAVE.cooldownMs}
          onPress={() => input.pressButton('shockwave')}
        />
        <TouchAbility
          label="Dodge"
          className="dodge"
          onPress={() => input.pressButton('dodge')}
          onRelease={() => input.releaseButton('dodge')}
        />
        <TouchAbility
          label="Punch"
          className="punch"
          cdMs={self?.cd[0] ?? 0}
          cdTotalMs={PUNCH.cooldownMs}
          onPress={() => input.pressButton('punch')}
        />
        <TouchAbility
          label="Jump"
          className="jump"
          onPress={() => input.pressButton('jump')}
          onRelease={() => input.releaseButton('jump')}
        />
      </div>
      {!alive ? <div className="touch-actions__veil" aria-hidden /> : null}
    </div>
  );
}

export interface HudProps {
  hud: HudState;
  fps: number;
  showFps: boolean;
  isTouch: boolean;
  input: InputManager;
  /** True while the gameplay HUD should be interactive (combat/countdown). */
  controlsActive: boolean;
}

export function Hud({ hud, fps, showFps, isTouch, input, controlsActive }: HudProps): ReactElement {
  const self = hud.self;
  const [hitMark, setHitMark] = useState(0);
  const previousHp = useRef<number>(100);

  // Hit marker + vignette when the local player takes damage.
  useEffect(() => {
    if (!self) return;
    if (self.hp < previousHp.current) setHitMark((value) => value + 1);
    previousHp.current = self.hp;
  }, [self?.hp, self]);

  const connectionClass =
    hud.status === 'online' ? '' : hud.status === 'reconnecting' ? 'stale' : 'offline';

  return (
    <div className={`hud${isTouch ? ' hud--touch' : ''}`}>
      <div className="hud-top">
        <div className={`connection ${connectionClass}`}>
          <span>
            <i className="dot" />
            {hud.status === 'online' ? 'Online' : hud.status === 'reconnecting' ? 'Reconnecting' : 'Offline'}
          </span>
          <span>{hud.pingMs} ms</span>
          {showFps ? <span>{Math.round(fps)} fps</span> : null}
        </div>
        <div className="hud-top__center">
          <div className={`timer${hud.matchRemainingMs < 30_000 && hud.phase === 'combat' ? ' urgent' : ''}`}>
            {hud.phase === 'combat' ? formatClock(hud.matchRemainingMs) : '—:—'}
          </div>
          <div className="phase-label">
            {hud.phase === 'combat'
              ? 'Free-for-all · 5:00'
              : hud.phase === 'countdown'
                ? 'Get ready'
                : hud.phase === 'results'
                  ? 'Match over'
                  : 'Lobby'}
          </div>
        </div>
        <Scoreboard hud={hud} />
      </div>

      {hud.phase === 'combat' ? (
        <>
          <div
            className={`crosshair${hud.punchReady ? ' armed' : ''}`}
            aria-hidden
          >
            {hitMark > 0 ? <span key={hitMark} className="hit-mark" /> : null}
          </div>
          {hud.breakTargetName ? (
            <div className="target-hint">Platform Break → {hud.breakTargetName}</div>
          ) : null}
        </>
      ) : null}

      {self ? (
        <div className="bars">
          <div className="bar">
            <span className="label">Health</span>
            <span className="track">
              <i
                className={`fill hp${self.hp <= 30 ? ' low' : self.hp <= 60 ? ' warn' : ''}`}
                style={{ width: `${Math.max(0, Math.min(100, self.hp))}%` }}
              />
              <span className="value">{Math.round(self.hp)}</span>
            </span>
          </div>
          <div className="bar">
            <span className="label">Energy</span>
            <span className="track">
              <i className="fill energy" style={{ width: `${Math.max(0, Math.min(100, self.en))}%` }} />
              <span className="value">{Math.round(self.en)}</span>
            </span>
          </div>
        </div>
      ) : null}

      {self ? <AbilityTiles self={self} /> : null}
      <KillFeed hud={hud} />

      {hud.phase === 'countdown' ? (
        <div className="countdown">
          <strong>{Math.max(1, Math.ceil(hud.countdownRemainingMs / 1000))}</strong>
          <span>Prepare</span>
        </div>
      ) : null}

      {self && !self.alive && hud.phase === 'combat' ? (
        <div className="respawn">
          <strong>Down</strong>
          <span>Respawning in {(Math.max(0, self.respawnInMs) / 1000).toFixed(1)}s</span>
        </div>
      ) : null}

      {self?.prot && hud.phase === 'combat' ? (
        <div className="notice">Spawn protection — {(self.shieldMs / 1000).toFixed(1)}s</div>
      ) : null}

      {hud.lastDenial ? <div className="denial">{hud.lastDenial}</div> : null}

      {!isTouch ? (
        <div className="controls-hint">
          <div>
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> move · <kbd>Space</kbd> jump · <kbd>Shift</kbd> dodge
          </div>
          <div>
            <kbd>LMB</kbd> punch · <kbd>RMB</kbd> gravity · <kbd>Q</kbd> shockwave · <kbd>E</kbd> break
          </div>
        </div>
      ) : null}

      {isTouch && controlsActive ? <MobileControls input={input} self={self} /> : null}
    </div>
  );
}
