#!/usr/bin/env node
/**
 * FRACTURE solo-matchmaking smoke test.
 *
 * One real WebSocket client over the origin the browser uses (defaults to the
 * Vite dev proxy on port 3000, so the path is Vite proxy -> game server). It
 * creates a private room and does nothing else: no second player ever arrives,
 * so the server has to notice the wait, top the arena up with bots and start
 * the match on its own.
 *
 * Usage:
 *   node scripts/smoke-solo.mjs                                 # through the dev proxy
 *   WS_URL=ws://127.0.0.1:2567/ws node scripts/smoke-solo.mjs   # straight to the server
 *
 * Set FRACTURE_BOT_FILL_MS on the server to shorten the wait (15000 ms default).
 */
import { WebSocket } from 'ws';

const URL_BASE = process.env.WS_URL ?? 'ws://127.0.0.1:3000/ws';
const HOST_HEADER = process.env.WS_HOST_HEADER;
const WAIT_BUDGET_MS = Number.parseInt(process.env.SOLO_WAIT_MS ?? '45000', 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_BASE, HOST_HEADER ? { headers: { host: HOST_HEADER } } : undefined);
    const client = { name, ws, messages: [], seq: 0 };
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
    ws.on('message', (data) => client.messages.push(JSON.parse(data.toString())));
  });
}

const send = (client, message) => client.ws.send(JSON.stringify(message));

function sendInput(client, fields) {
  client.seq += 1;
  send(client, {
    t: 'input',
    input: {
      seq: client.seq,
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
}

const snapshots = (client) =>
  client.messages.filter((m) => m.t === 'snapshot').map((m) => m.snapshot);
const rooms = (client) => client.messages.filter((m) => m.t === 'room').map((m) => m.room);

function fail(message) {
  console.error(`\nSOLO SMOKE TEST FAILED: ${message}`);
  process.exit(1);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

async function main() {
  console.log(`Connecting to ${URL_BASE} …`);
  const host = await connect('Solo');

  send(host, { t: 'create', name: 'Solo' });
  const joined = await waitFor(() => host.messages.find((m) => m.t === 'joined'), 5000, 'joined');
  console.log(`✓ private room created: ${joined.code}`);

  const waiting = await waitFor(
    () => rooms(host).find((room) => room.matchmakingRemainingMs > 0),
    10000,
    'the matchmaking countdown',
  );
  console.log(
    `✓ matchmaking started: humans=${waiting.humans} countdown=${Math.round(
      waiting.matchmakingRemainingMs / 1000,
    )}s`,
  );

  const combat = await waitFor(
    () => snapshots(host).find((snapshot) => snapshot.phase === 'combat'),
    WAIT_BUDGET_MS,
    'the automatic match start',
  );
  const bots = combat.players.filter((player) => player.bot);
  if (bots.length === 0) fail('the match started but no bots filled the arena');
  console.log(
    `✓ match started on its own: players=${combat.players.length} bots=${bots
      .map((bot) => bot.name)
      .join(', ')}`,
  );

  const hostStart = combat.players.find((player) => !player.bot);
  const botStart = new Map(bots.map((bot) => [bot.id, { x: bot.p[0], z: bot.p[2] }]));

  // Stand still and let them come: this is exactly what an AFK player sees.
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    sendInput(host, {});
    await sleep(60);
  }

  const latest = snapshots(host).at(-1);
  const moved = latest.players
    .filter((player) => player.bot)
    .filter((bot) => {
      const from = botStart.get(bot.id);
      return from && Math.hypot(bot.p[0] - from.x, bot.p[2] - from.z) > 1.5;
    });
  if (moved.length === 0) fail('the bots never moved');
  console.log(
    `✓ bots are hunting the player: ${moved
      .map((bot) => `${bot.name} moved ${Math.hypot(
        bot.p[0] - botStart.get(bot.id).x,
        bot.p[2] - botStart.get(bot.id).z,
      ).toFixed(1)} m`)
      .join(', ')}`,
  );

  const self = latest.players.find((player) => player.id === hostStart.id);
  if (self.hp >= 100 && self.deaths === 0) fail('the bots never landed a hit on a stationary player');
  console.log(`✓ bots dealt damage: hp=${self.hp.toFixed(1)} deaths=${self.deaths}`);

  const events = latest.events.map((event) => `${event.type}:${event.detail ?? ''}`);
  console.log(`✓ latest server events: ${events.join(', ') || '(none this tick)'}`);

  console.log('\nSOLO SMOKE TEST PASSED');
  host.ws.close();
  process.exit(0);
}

main().catch((error) => fail(error?.message ?? String(error)));
