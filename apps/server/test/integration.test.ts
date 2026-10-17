/**
 * Server integration tests.
 *
 * These drive the real HTTP server and real WebSocket clients (the `ws` package)
 * through the same protocol the browser uses: create room -> join -> ready ->
 * host start -> inputs -> snapshots -> results -> rematch. They prove that
 * multiple independent clients share one authoritative simulation.
 *
 * Browser rendering and touch input still need manual verification; see
 * docs/TESTING.md for the manual smoke-test checklist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parseServerMessage, type ServerMessage, type Snapshot } from '@fracture/shared';
import { createGameServer, type GameServer } from '../src/index.js';

const servers: GameServer[] = [];
const clients: TestClient[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TestClient {
  readonly messages: ServerMessage[] = [];
  readonly ws: WebSocket;
  lastInputSeq = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const message = parseServerMessage(data.toString());
      if (message) this.messages.push(message);
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = new TestClient(ws);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor<T extends ServerMessage['t']>(
    type: T,
    predicate?: (message: Extract<ServerMessage, { t: T }>) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(
        (message): message is Extract<ServerMessage, { t: T }> =>
          message.t === type &&
          (predicate === undefined ||
            predicate(message as Extract<ServerMessage, { t: T }>)),
      );
      if (found) return found;
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `Timed out waiting for "${type}". Received: ${this.messages
            .map((m) => m.t)
            .join(', ')}`,
        );
      }
      await delay(15);
    }
  }

  async expectNoMessage<T extends ServerMessage['t']>(type: T, durationMs = 400): Promise<void> {
    await delay(durationMs);
    expect(this.messages.some((message) => message.t === type)).toBe(false);
  }

  /** Poll for a snapshot matching the predicate (mirrors a real client loop). */
  async waitForSnapshot(
    predicate: (snapshot: Snapshot) => boolean,
    timeoutMs = 5000,
  ): Promise<Snapshot> {
    const started = Date.now();
    for (;;) {
      const snapshot = this.latestSnapshot(predicate);
      if (snapshot) return snapshot;
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a snapshot');
      await delay(20);
    }
  }

  /** Latest snapshot matching the predicate (or the most recent one). */
  latestSnapshot(predicate?: (snapshot: Snapshot) => boolean): Snapshot | undefined {
    const snapshots = this.messages.filter(
      (message): message is Extract<ServerMessage, { t: 'snapshot' }> => message.t === 'snapshot',
    );
    if (!predicate) return snapshots.at(-1)?.snapshot;
    for (let i = snapshots.length - 1; i >= 0; i -= 1) {
      const snapshot = snapshots[i]!.snapshot;
      if (predicate(snapshot)) return snapshot;
    }
    return undefined;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function startServer(options: { botFillDelayMs?: number } = {}): Promise<{
  server: GameServer;
  port: number;
}> {
  const server = createGameServer({
    config: {
      port: 0,
      host: '127.0.0.1',
      clientOrigins: ['*'],
      serveClient: false,
      // Automatic bot fill is opt-in per test so the timing-independent suites
      // are never perturbed by a matchmaking countdown.
      botFillDelayMs: options.botFillDelayMs ?? 0,
    },
  });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  server.start();
  return { server, port };
}

async function joinRoom(
  port: number,
  create: boolean,
  name: string,
  code?: string,
  token?: string,
): Promise<{ client: TestClient; playerId: string; code: string; token: string }> {
  const client = await TestClient.connect(port);
  client.send(create ? { t: 'create', name, token } : { t: 'join', name, code, token });
  const joined = await client.waitFor('joined');
  return { client, playerId: joined.playerId, code: joined.code, token: joined.token };
}

/** Send a steady stream of input frames, mirroring what the browser client does. */
async function streamInputs(
  client: TestClient,
  fields: Record<string, unknown>,
  durationMs: number,
): Promise<void> {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    client.lastInputSeq += 1;
    client.send({
      t: 'input',
      input: {
        seq: client.lastInputSeq,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        pitch: 0,
        jump: false,
        dodge: false,
        punch: false,
        gravity: false,
        shockwave: false,
        breakPlatform: false,
        ...fields,
      },
    });
    await delay(1000 / 40);
  }
}

async function waitForCombat(client: TestClient, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const snapshot = client.latestSnapshot((s) => s.phase === 'combat');
    if (snapshot) return;
    if (Date.now() - started > timeoutMs) throw new Error('match never reached the combat phase');
    await delay(20);
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

describe('http surface', () => {
  it('reports health with room and player counts', async () => {
    const { port } = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.tickRate).toBe(30);
    expect(typeof body.rooms).toBe('number');
  });

  it('rejects a websocket upgrade from a disallowed origin', async () => {
    const server = createGameServer({
      config: { port: 0, host: '127.0.0.1', clientOrigins: ['https://fracture.example'], serveClient: false },
    });
    servers.push(server);
    const port = await server.listen(0, '127.0.0.1');
    server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('unexpected-response', (_req, res) => resolve(`status:${res.statusCode}`));
      ws.once('error', (error) => resolve(`error:${error.message}`));
      ws.once('open', () => resolve('open'));
    });
    expect(outcome.startsWith('status:403') || outcome.startsWith('error')).toBe(true);
    ws.close();
  });
});

describe('rooms and lobby', () => {
  it('creates a private room and lets a second client join by code', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    expect(host.code).toHaveLength(5);

    const guest = await joinRoom(port, false, 'Guest', host.code);
    expect(guest.playerId).not.toBe(host.playerId);

    const summary = await host.client.waitFor(
      'room',
      (message) => message.room.players.length === 2,
    );
    expect(summary.room.hostId).toBe(host.playerId);
    expect(summary.room.players.map((p) => p.name).sort()).toEqual(['Guest', 'Host']);
  });

  it('reports an invalid room code', async () => {
    const { port } = await startServer();
    const client = await TestClient.connect(port);
    client.send({ t: 'join', name: 'Lost', code: 'ZZZZZ' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('room-not-found');
  });

  it('enforces the four player capacity', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    await joinRoom(port, false, 'Two', host.code);
    await joinRoom(port, false, 'Three', host.code);
    await joinRoom(port, false, 'Four', host.code);

    const fifth = await TestClient.connect(port);
    fifth.send({ t: 'join', name: 'Five', code: host.code });
    const error = await fifth.waitFor('error');
    expect(error.code).toBe('room-full');
  });

  it('only the host can start, and a solo host starts against bots', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);

    // A guest can never start the match.
    guest.client.send({ t: 'start' });
    const notHost = await guest.client.waitFor('error');
    expect(notHost.code).toBe('not-host');
    expect(host.client.latestSnapshot()?.phase).not.toBe('countdown');

    host.client.send({ t: 'start' });
    const countdown = await host.client.waitFor('room', (m) => m.room.phase === 'countdown');
    expect(countdown.room.phase).toBe('countdown');
  });

  it('a lone host is never blocked by the two-player minimum', async () => {
    const { port } = await startServer({ botFillDelayMs: 0 });
    const host = await joinRoom(port, true, 'Host');

    host.client.send({ t: 'start' });
    const countdown = await host.client.waitFor('room', (m) => m.room.phase === 'countdown');
    expect(countdown.room.players.filter((p) => p.bot).length).toBeGreaterThan(0);
    expect(countdown.room.humans).toBe(1);
  });

  it('tracks ready state authoritatively', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);

    guest.client.send({ t: 'ready', ready: true });
    const summary = await host.client.waitFor(
      'room',
      (m) => m.room.players.some((p) => p.id === guest.playerId && p.ready),
    );
    expect(summary.room.players.find((p) => p.id === guest.playerId)!.ready).toBe(true);
  });

  it('rejects malformed messages without crashing', async () => {
    const { port } = await startServer();
    const client = await TestClient.connect(port);
    client.ws.send('{not json');
    const error = await client.waitFor('error');
    expect(error.code).toBe('bad-message');

    client.ws.send(JSON.stringify({ t: 'nonsense' }));
    const second = await client.waitFor('error', (m) => m.message.includes('Unknown'));
    expect(second.code).toBe('bad-message');
  });
});

describe('authoritative match', () => {
  it('synchronises movement between two clients and never trusts client positions', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);
    host.client.send({ t: 'start' });
    await waitForCombat(host.client);
    await waitForCombat(guest.client);

    const before = guest.client.latestSnapshot()!;
    const startZ = before.players.find((p) => p.id === host.playerId)!.p[2];

    // Host walks forward; the guest must observe the authoritative position.
    await streamInputs(host.client, { moveZ: 1 }, 1200);

    const moved = guest.client.latestSnapshot(
      (s) => Math.abs(s.players.find((p) => p.id === host.playerId)!.p[2] - startZ) > 0.8,
    );
    expect(moved).toBeDefined();

    // Client-supplied speed cannot be forged: a bogus huge input is clamped.
    client: {
      for (let i = 0; i < 20; i += 1) {
        host.client.lastInputSeq += 1;
        host.client.send({
          t: 'input',
          input: {
            seq: host.client.lastInputSeq,
            moveX: 999,
            moveZ: 999,
            yaw: 0,
            pitch: 0,
            jump: false,
            dodge: false,
            punch: false,
            gravity: false,
            shockwave: false,
            breakPlatform: false,
          },
        });
      }
      await delay(400);
      const snapshot = guest.client.latestSnapshot()!;
      const position = snapshot.players.find((p) => p.id === host.playerId)!.p;
      expect(Math.abs(position[0])).toBeLessThan(18);
      expect(Math.abs(position[2])).toBeLessThan(18);
      break client;
    }
  });

  it('broadcasts ability and damage events produced by the server', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);
    host.client.send({ t: 'start' });
    await waitForCombat(host.client);
    await waitForCombat(guest.client);

    // Walk into punch range, then punch once.
    await streamInputs(host.client, { moveZ: 1, yaw: Math.PI }, 1200);
    host.client.lastInputSeq += 1;
    host.client.send({
      t: 'input',
      input: {
        seq: host.client.lastInputSeq,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        pitch: 0,
        jump: false,
        dodge: false,
        punch: true,
        gravity: false,
        shockwave: false,
        breakPlatform: false,
      },
    });

    const withAbility = await guest.client.waitForSnapshot((s) =>
      s.events.some((e) => e.type === 'ability' && e.detail === 'punch'),
    );
    expect(withAbility.events.some((e) => e.type === 'ability')).toBe(true);
  });

  it('applies damage to another player and reports it to every client', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);
    host.client.send({ t: 'start' });
    await waitForCombat(host.client);
    await waitForCombat(guest.client);

    const room = servers.at(-1)!.rooms.get(host.code)!;
    // Place the fighters in melee range (white-box: the sim owns positions).
    const attacker = room.sim.getPlayer(host.playerId)!;
    const victim = room.sim.getPlayer(guest.playerId)!;
    await delay(1700); // let the initial spawn protection expire
    attacker.position = { x: 0, y: 0, z: 0 };
    attacker.velocity = { x: 0, y: 0, z: 0 };
    victim.position = { x: 0, y: 0, z: -1.5 };
    victim.velocity = { x: 0, y: 0, z: 0 };

    host.client.lastInputSeq += 1;
    host.client.send({
      t: 'input',
      input: {
        seq: host.client.lastInputSeq,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        pitch: 0,
        jump: false,
        dodge: false,
        punch: true,
        gravity: false,
        shockwave: false,
        breakPlatform: false,
      },
    });

    const damaged = await guest.client.waitForSnapshot(
      (snapshot) => (snapshot.players.find((p) => p.id === guest.playerId)?.hp ?? 100) < 100,
    );
    const victimState = damaged.players.find((p) => p.id === guest.playerId)!;
    expect(victimState.hp).toBe(85); // 100 - PUNCH.damage
    expect(damaged.players.find((p) => p.id === host.playerId)!.hp).toBe(100);
  });

  it('collapses the same platform for every client', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);
    host.client.send({ t: 'start' });
    await waitForCombat(host.client);
    await waitForCombat(guest.client);

    const room = servers.at(-1)!.rooms.get(host.code)!;
    const attacker = room.sim.getPlayer(host.playerId)!;
    const bridge = room.sim.platforms.find((p) => p.id === 'north-bridge')!;
    const neutralInput = (): void => {
      host.client.lastInputSeq += 1;
      host.client.send({
        t: 'input',
        input: {
          seq: host.client.lastInputSeq,
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          dodge: false,
          punch: false,
          gravity: false,
          shockwave: false,
          breakPlatform: false,
        },
      });
    };

    const breakOnce = async (): Promise<void> => {
      // Real clients stream frames continuously; abilities are edge-triggered, so
      // a released frame must arrive between two activations.
      neutralInput();
      await delay(80);
      attacker.position = { x: bridge.center.x, y: 3, z: bridge.center.z };
      attacker.velocity = { x: 0, y: 0, z: 0 };
      attacker.yaw = 0;
      attacker.pitch = -Math.PI / 2;
      host.client.lastInputSeq += 1;
      host.client.send({
        t: 'input',
        input: {
          seq: host.client.lastInputSeq,
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: -Math.PI / 2,
          jump: false,
          dodge: false,
          punch: false,
          gravity: false,
          shockwave: false,
          breakPlatform: true,
        },
      });
      await delay(400);
    };

    await breakOnce();
    const cracked = await guest.client.waitForSnapshot(
      (s) => s.platforms.find((p) => p.id === 'north-bridge')?.state === 'CRACKED',
    );
    expect(cracked.platforms.find((p) => p.id === 'north-bridge')!.durability).toBe(30);

    await breakOnce();
    const collapsing = await host.client.waitForSnapshot(
      (s) => s.platforms.find((p) => p.id === 'north-bridge')?.state === 'COLLAPSING',
    );
    expect(collapsing.platforms.find((p) => p.id === 'north-bridge')!.solid).toBe(true);

    const destroyed = await guest.client.waitForSnapshot(
      (s) => s.platforms.find((p) => p.id === 'north-bridge')?.state === 'DESTROYED',
      4000,
    );
    expect(destroyed.platforms.find((p) => p.id === 'north-bridge')!.solid).toBe(false);
    // The safe centre platform can never be destroyed.
    expect(destroyed.platforms.find((p) => p.id === 'center-safe')!.state).toBe('INTACT');
  });

  it('ends the match, delivers results and supports a host-only rematch', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);
    host.client.send({ t: 'start' });
    await waitForCombat(host.client);
    await waitForCombat(guest.client);

    // White-box: shorten the authoritative clock so the 5 minute match ends now.
    const room = servers.at(-1)!.rooms.get(host.code)!;
    room.sim.combatEndsTick = room.sim.tick + 3;

    const results = await host.client.waitFor('results', undefined, 5000);
    expect(results.results.scores).toHaveLength(2);
    // The clock was shortened white-box, so the reported duration is small but
    // never exceeds the configured 5 minute match length.
    expect(results.results.durationMs).toBeGreaterThan(0);
    expect(results.results.durationMs).toBeLessThanOrEqual(300_000);
    // Both players are on zero points, which must produce a shared rank.
    expect(results.results.tie).toBe(true);
    expect(results.results.winners).toHaveLength(2);
    await guest.client.waitFor('results');

    guest.client.send({ t: 'rematch' });
    const notHost = await guest.client.waitFor('error', (m) => m.code === 'not-host');
    expect(notHost.code).toBe('not-host');

    host.client.send({ t: 'rematch' });
    const countdown = await host.client.waitFor('room', (m) => m.room.phase === 'countdown');
    expect(countdown.room.phase).toBe('countdown');
  });
});

describe('disconnects', () => {
  it('keeps the slot for a reconnect and awards no points for the drop', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);
    host.client.send({ t: 'start' });
    await waitForCombat(host.client);
    await waitForCombat(guest.client);

    const room = servers.at(-1)!.rooms.get(host.code)!;
    const scoreBefore = room.sim.getPlayer(host.playerId)!.score;

    guest.client.close();

    // The host is told the fighter is disconnected but still present.
    const afterDrop = await host.client.waitFor(
      'room',
      (m) => m.room.players.some((p) => p.id === guest.playerId && !p.connected),
      5000,
    );
    expect(afterDrop.room.players).toHaveLength(2);

    // Reconnecting with the stored token restores the same fighter and score.
    const reconnected = await joinRoom(port, false, 'Guest', host.code, guest.token);
    expect(reconnected.playerId).toBe(guest.playerId);
    const room2 = servers.at(-1)!.rooms.get(host.code)!;
    expect(room2.sim.getPlayer(host.playerId)!.score).toBe(scoreBefore);
    expect(room2.sim.players).toHaveLength(2);

    const summary = await host.client.waitFor(
      'room',
      (m) => m.room.players.find((p) => p.id === guest.playerId)?.connected === true,
    );
    expect(summary.room.players.find((p) => p.id === guest.playerId)!.connected).toBe(true);
  });

  it('migrates host ownership when the host leaves the lobby', async () => {
    const { port } = await startServer();
    const host = await joinRoom(port, true, 'Host');
    const guest = await joinRoom(port, false, 'Guest', host.code);

    host.client.send({ t: 'leave' });
    const summary = await guest.client.waitFor(
      'room',
      (m) => m.room.hostId === guest.playerId && m.room.players.length === 1,
    );
    expect(summary.room.hostId).toBe(guest.playerId);
  });
});

describe('matchmaking bots', () => {
  it('reports a matchmaking countdown while a solo host waits', async () => {
    const { port } = await startServer({ botFillDelayMs: 4000 });
    const host = await joinRoom(port, true, 'Host');

    const waiting = await host.client.waitFor('room', (m) => m.room.matchmakingRemainingMs > 0);
    expect(waiting.room.phase).toBe('lobby');
    expect(waiting.room.humans).toBe(1);
    expect(waiting.room.matchmakingRemainingMs).toBeLessThanOrEqual(4000);
  });

  it('starts the match on its own once the timer expires', async () => {
    const { port } = await startServer({ botFillDelayMs: 400 });
    const host = await joinRoom(port, true, 'Host');

    const countdown = await host.client.waitFor(
      'room',
      (m) => m.room.phase === 'countdown',
      5000,
    );

    // One human plus bots, to one below capacity so a friend can still join.
    expect(countdown.room.humans).toBe(1);
    expect(countdown.room.matchmakingRemainingMs).toBe(0);
    const bots = countdown.room.players.filter((p) => p.bot);
    expect(bots.length).toBeGreaterThanOrEqual(2);
    expect(countdown.room.hostId).toBe(host.playerId);

    const snapshot = await host.client.waitForSnapshot((s) => s.phase === 'combat', 8000);
    expect(snapshot.players.filter((p) => p.bot).length).toBe(bots.length);
  });

  it('bots actually play: they move and damage a passive human', async () => {
    const { port } = await startServer({ botFillDelayMs: 300 });
    const host = await joinRoom(port, true, 'Host');
    await host.client.waitFor('room', (m) => m.room.phase === 'combat', 8000);

    const start = await host.client.waitForSnapshot((s) => s.phase === 'combat', 8000);
    const botStart = new Map(
      start.players.filter((p) => p.bot).map((p) => [p.id, { x: p.p[0], z: p.p[2] }]),
    );

    // Hold still for a few seconds and let the bots come to us.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      host.client.lastInputSeq += 1;
      host.client.send({
        t: 'input',
        input: {
          seq: host.client.lastInputSeq,
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          jump: false,
          dodge: false,
          punch: false,
          gravity: false,
          shockwave: false,
          breakPlatform: false,
        },
      });
      await delay(50);
    }

    const latest = host.client.latestSnapshot((s) => s.phase === 'combat')!;
    const moved = latest.players
      .filter((p) => p.bot)
      .filter((p) => {
        const from = botStart.get(p.id);
        return from !== undefined && Math.hypot(p.p[0] - from.x, p.p[2] - from.z) > 1.5;
      });
    expect(moved.length).toBeGreaterThan(0);

    const self = latest.players.find((p) => p.id === host.playerId)!;
    const damage = 100 - self.hp + self.deaths * 100;
    expect(damage).toBeGreaterThan(0);
  });

  it('a second human cancels the countdown so friends play together', async () => {
    const { port } = await startServer({ botFillDelayMs: 3000 });
    const host = await joinRoom(port, true, 'Host');
    await host.client.waitFor('room', (m) => m.room.matchmakingRemainingMs > 0);

    const guest = await joinRoom(port, false, 'Guest', host.code);
    expect(guest.playerId).not.toBe(host.playerId);

    const cancelled = await host.client.waitFor(
      'room',
      (m) => m.room.humans === 2 && m.room.matchmakingRemainingMs === 0,
      4000,
    );
    expect(cancelled.room.players.every((p) => !p.bot)).toBe(true);

    // Still in the lobby after the original timer would have fired.
    await delay(3200);
    const room = servers.at(-1)!.rooms.get(host.code)!;
    expect(room.sim.phase).toBe('lobby');
    expect(room.sim.botCount).toBe(0);
  });

  it('a solo host can start against bots immediately', async () => {
    const { port } = await startServer({ botFillDelayMs: 0 });
    const host = await joinRoom(port, true, 'Host');

    host.client.send({ t: 'start' });
    const countdown = await host.client.waitFor('room', (m) => m.room.phase === 'countdown');
    expect(countdown.room.players.filter((p) => p.bot).length).toBeGreaterThan(0);
  });
});
