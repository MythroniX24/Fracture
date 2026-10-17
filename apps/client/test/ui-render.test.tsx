/**
 * UI render tests.
 *
 * `renderToStaticMarkup` executes the real component code (hooks, formatting,
 * conditionals) in Node without a DOM or WebGL context. This catches crashes and
 * obviously broken markup in every screen — browser-only behaviour (pointer
 * lock, touch gestures, rendering) still needs the manual checklist in
 * docs/TESTING.md.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MatchResults, PlayerSnapshot, RoomSummary } from '@fracture/shared';
import { defaultSettings, initialHudState, type HudState } from '../src/state/store.js';
import type { InputManager } from '../src/game/input.js';
import {
  HelpOverlay,
  Lobby,
  MainMenu,
  OrientationOverlay,
  ResultsScreen,
  SettingsOverlay,
} from '../src/ui/Screens.js';
import { Hud } from '../src/ui/Hud.js';

const inputStub = {} as unknown as InputManager;

function player(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    id: 'p1',
    slot: 0,
    color: 0xd4622f,
    name: 'Host',
    p: [0, 0, 0],
    v: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    hp: 85,
    en: 60,
    alive: true,
    grounded: true,
    score: 2,
    kills: 2,
    falls: 1,
    deaths: 1,
    cd: [0, 1200, 0, 0],
    charges: 1,
    prot: false,
    shieldMs: 0,
    respawnInMs: 0,
    anim: 'idle',
    animTick: 10,
    hitTick: null,
    connected: true,
    bot: false,
    ...overrides,
  };
}

const room: RoomSummary = {
  code: 'H4KQ7',
  phase: 'lobby',
  hostId: 'p1',
  maxPlayers: 4,
  countdownRemainingMs: 0,
  matchRemainingMs: 0,
  matchmakingRemainingMs: 0,
  humans: 2,
  tick: 12,
  players: [
    { id: 'p1', name: 'Host', color: 0xd4622f, ready: true, connected: true, host: true, bot: false, slot: 0 },
    { id: 'p2', name: 'Guest', color: 0x2f7fd9, ready: false, connected: true, host: false, bot: false, slot: 1 },
    { id: 'p3', name: 'Offline', color: 0x3fae6a, ready: false, connected: false, host: false, bot: false, slot: 2 },
  ],
};

function hudState(overrides: Partial<HudState> = {}): HudState {
  return {
    ...initialHudState,
    phase: 'combat',
    matchRemainingMs: 245_000,
    selfId: 'p1',
    self: player(),
    players: [player(), player({ id: 'p2', name: 'Guest', color: 0x2f7fd9, hp: 100, score: 1 })],
    status: 'online',
    pingMs: 32,
    killFeed: [{ id: '1', kind: 'elimination', text: 'Host eliminated Guest', at: 0 }],
    punchReady: true,
    breakTargetName: 'North Causeway',
    lastDenial: 'Shockwave — Not enough energy',
    ...overrides,
  };
}

describe('menus', () => {
  it('renders the main menu with room actions', () => {
    const markup = renderToStaticMarkup(
      <MainMenu
        settings={defaultSettings}
        status="online"
        error={null}
        busy={false}
        onCreate={() => undefined}
        onJoin={() => undefined}
        onOpenHelp={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(markup).toContain('FRACTURE');
    expect(markup).toContain('Create room');
    expect(markup).toContain('Join room');
  });

  it('prefills an invite code and shows the join form', () => {
    const markup = renderToStaticMarkup(
      <MainMenu
        settings={defaultSettings}
        status="offline"
        error="Room not found"
        busy={false}
        initialCode="H4KQ7"
        onCreate={() => undefined}
        onJoin={() => undefined}
        onOpenHelp={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(markup).toContain('value="H4KQ7"');
    expect(markup).toContain('Room not found');
  });
});

describe('lobby', () => {
  it('shows the code, slots, readiness and the host start button', () => {
    const markup = renderToStaticMarkup(
      <Lobby
        room={room}
        selfId="p1"
        isHost
        notice={null}
        onReady={() => undefined}
        onStart={() => undefined}
        onLeave={() => undefined}
        onOpenHelp={() => undefined}
      />,
    );
    expect(markup).toContain('H4KQ7');
    expect(markup).toContain('Start match (2/4)');
    expect(markup).toContain('Open slot');
    expect(markup).toContain('Offline');
    expect(markup).toContain('Waiting on Guest');
  });

  it('gives non-hosts a ready toggle instead of a start button', () => {
    const markup = renderToStaticMarkup(
      <Lobby
        room={room}
        selfId="p2"
        isHost={false}
        notice={null}
        onReady={() => undefined}
        onStart={() => undefined}
        onLeave={() => undefined}
        onOpenHelp={() => undefined}
      />,
    );
    expect(markup).toContain('Ready up');
    expect(markup).not.toContain('Start match');
  });
});

describe('results', () => {
  const results: MatchResults = {
    finishedAt: 300_000,
    durationMs: 300_000,
    winners: ['p1'],
    tie: false,
    scores: [
      { playerId: 'p1', name: 'Host', color: 0xd4622f, score: 3, eliminations: 3, falls: 2, deaths: 4, rank: 1 },
      { playerId: 'p2', name: 'Guest', color: 0x2f7fd9, score: 2, eliminations: 2, falls: 1, deaths: 3, rank: 2 },
    ],
  };

  it('renders ranks, scores and the winner for the host', () => {
    const markup = renderToStaticMarkup(
      <ResultsScreen results={results} selfId="p1" isHost onRematch={() => undefined} onLeave={() => undefined} />,
    );
    expect(markup).toContain('Victory');
    expect(markup).toContain('Rematch');
    expect(markup).toContain('5.00');
  });

  it('renders a shared victory on a tie', () => {
    const tied: MatchResults = {
      ...results,
      winners: ['p1', 'p2'],
      tie: true,
    };
    const markup = renderToStaticMarkup(
      <ResultsScreen results={tied} selfId="p2" isHost={false} onRematch={() => undefined} onLeave={() => undefined} />,
    );
    expect(markup).toContain('Shared victory');
    expect(markup).toContain('Waiting for host');
  });
});

describe('in-match HUD', () => {
  it('renders timer, bars, abilities, feed and target hint', () => {
    const markup = renderToStaticMarkup(
      <Hud hud={hudState()} fps={58} showFps isTouch={false} input={inputStub} controlsActive />,
    );
    expect(markup).toContain('4:05');
    expect(markup).toContain('85');
    expect(markup).toContain('Shockwave');
    expect(markup).toContain('1/2');
    expect(markup).toContain('North Causeway');
    expect(markup).toContain('Not enough energy');
    expect(markup).toContain('58 fps');
  });

  it('shows the countdown, respawn overlay and spawn protection states', () => {
    const countdown = renderToStaticMarkup(
      <Hud
        hud={hudState({ phase: 'countdown', countdownRemainingMs: 2200 })}
        fps={60}
        showFps={false}
        isTouch={false}
        input={inputStub}
        controlsActive={false}
      />,
    );
    expect(countdown).toContain('Prepare');

    const downed = renderToStaticMarkup(
      <Hud
        hud={hudState({ self: player({ alive: false, hp: 0, respawnInMs: 2100 }) })}
        fps={60}
        showFps={false}
        isTouch={false}
        input={inputStub}
        controlsActive
      />,
    );
    expect(downed).toContain('Respawning in 2.1s');

    const protectedPlayer = renderToStaticMarkup(
      <Hud
        hud={hudState({ self: player({ prot: true, shieldMs: 900 }) })}
        fps={60}
        showFps={false}
        isTouch={false}
        input={inputStub}
        controlsActive
      />,
    );
    expect(protectedPlayer).toContain('Spawn protection');
  });

  it('never renders touch controls on desktop', () => {
    const markup = renderToStaticMarkup(
      <Hud hud={hudState()} fps={60} showFps={false} isTouch={false} input={inputStub} controlsActive />,
    );
    expect(markup).not.toContain('joystick');
  });
});

describe('overlays', () => {
  it('renders the help sheet with every binding', () => {
    const markup = renderToStaticMarkup(<HelpOverlay onClose={() => undefined} />);
    for (const label of ['Move', 'Jump', 'Dodge (grounded)', 'Punch', 'Gravity Shot', 'Shockwave', 'Platform Break']) {
      expect(markup).toContain(label);
    }
  });

  it('renders settings with the current values', () => {
    const markup = renderToStaticMarkup(
      <SettingsOverlay
        settings={{ ...defaultSettings, volume: 0.25, muted: true, showFps: true }}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(markup).toContain('25%');
    expect(markup).toContain('Look sensitivity');
    expect(markup).toContain('checked');
  });

  it('renders the landscape rotate prompt with a fullscreen action', () => {
    const markup = renderToStaticMarkup(
      <OrientationOverlay fullscreen={false} onGoLandscape={() => undefined} />,
    );
    expect(markup).toContain('Rotate to landscape');
    expect(markup).toContain('Go fullscreen');

    const locked = renderToStaticMarkup(
      <OrientationOverlay fullscreen onGoLandscape={() => undefined} />,
    );
    expect(locked).toContain('Lock to landscape');
  });
});

describe('matchmaking', () => {
  it('counts down to the bot fill and offers an immediate solo start', () => {
    const soloRoom: RoomSummary = {
      ...room,
      phase: 'lobby',
      humans: 1,
      matchmakingRemainingMs: 12_400,
      players: [
        { id: 'p1', name: 'Host', color: 0xd4622f, ready: true, connected: true, host: true, bot: false, slot: 0 },
      ],
    };
    const markup = renderToStaticMarkup(
      <Lobby
        room={soloRoom}
        selfId="p1"
        isHost
        notice={null}
        onReady={() => undefined}
        onStart={() => undefined}
        onLeave={() => undefined}
        onOpenHelp={() => undefined}
      />,
    );
    expect(markup).toContain('Finding opponents');
    expect(markup).toContain('13s');
    expect(markup).toContain('Start vs bots');
    expect(markup).not.toContain('Start match (');
  });

  it('badges bot fighters in the lobby list', () => {
    const botRoom: RoomSummary = {
      ...room,
      matchmakingRemainingMs: 0,
      humans: 1,
      players: [
        { id: 'p1', name: 'Host', color: 0xd4622f, ready: true, connected: true, host: true, bot: false, slot: 0 },
        { id: 'bot-1', name: 'Vane', color: 0x2f7fd9, ready: false, connected: true, host: false, bot: true, slot: 1 },
      ],
    };
    const markup = renderToStaticMarkup(
      <Lobby
        room={botRoom}
        selfId="p1"
        isHost
        notice={null}
        onReady={() => undefined}
        onStart={() => undefined}
        onLeave={() => undefined}
        onOpenHelp={() => undefined}
      />,
    );
    expect(markup).toContain('Vane');
    expect(markup).toContain('badge bot');
    // Only one human is connected, so the host is offered the solo start.
    expect(markup).toContain('Start vs bots');
  });
});
