#!/usr/bin/env node
/**
 * FRACTURE smoke test — two real WebSocket clients over the origin the browser
 * uses (defaults to the Vite dev proxy on port 3000, so it exercises the same
 * path as the browser: Vite proxy -> game server).
 *
 * Usage:
 *   node scripts/smoke.mjs                                  # through the dev proxy
 *   WS_URL=ws://127.0.0.1:2567/ws node scripts/smoke.mjs    # straight to the server
 *
 * It creates a private room, joins with a second client, starts the match,
 * verifies synchronised movement, fires every ability and prints the
 * server-emitted events it observed.
 */
import { WebSocket } from 'ws';

const URL_BASE = process.env.WS_URL ?? 'ws://127.0.0.1:3000/ws';
const HOST_HEADER = process.env.WS_HOST_HEADER;
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

function send(client, message) {
  client.ws.send(JSON.stringify(message));
}

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

function latestSnapshot(client) {
  return client.messages.filter((m) => m.t === 'snapshot').at(-1)?.snapshot;
}

async function main() {
  console.log(`Connecting to ${URL_BASE} …`);
  const host = await connect('host');
  send(host, { t: 'create', name: 'SmokeHost' });
  await sleep(500);
  const joined = host.messages.find((m) => m.t === 'joined');
  if (!joined) throw new Error(`no "joined" message received: ${JSON.stringify(host.messages)}`);
  console.log(`✓ room created: ${joined.code}`);

  const guest = await connect('guest');
  send(guest, { t: 'join', name: 'SmokeGuest', code: joined.code });
  await sleep(500);
  if (!guest.messages.some((m) => m.t === 'joined')) throw new Error('second client failed to join');
  console.log('✓ second client joined the same room');

  send(host, { t: 'start' });
  await sleep(4400);

  const snapshot = latestSnapshot(host);
  if (!snapshot) throw new Error('no snapshots received');
  const destructible = snapshot.platforms.filter((p) => p.maxDurability > 0);
  console.log(
    `✓ phase=${snapshot.phase} players=${snapshot.players.length} tick=${snapshot.tick} ` +
      `platforms=${snapshot.platforms.length} (destructible ${destructible.length})`,
  );
  if (snapshot.phase !== 'combat') throw new Error(`expected combat, got ${snapshot.phase}`);

  const start = snapshot.players.find((p) => p.id === joined.playerId);
  for (let i = 0; i < 40; i += 1) {
    sendInput(host, { moveZ: 1 });
    await sleep(25);
  }
  const later = latestSnapshot(guest);
  const moved = later.players.find((p) => p.id === joined.playerId);
  const delta = Math.hypot(moved.p[0] - start.p[0], moved.p[2] - start.p[2]);
  console.log(`✓ other client observed movement: ${delta.toFixed(2)} m`);
  if (delta < 0.5) throw new Error('movement did not synchronise between clients');

  for (const button of ['punch', 'gravity', 'shockwave', 'breakPlatform']) {
    sendInput(host, { [button]: true, yaw: 0, pitch: -0.35 });
    await sleep(150);
  }
  await sleep(600);

  const events = host.messages.flatMap((m) => (m.t === 'snapshot' ? m.snapshot.events : []));
  const kinds = [...new Set(events.map((event) => `${event.type}:${event.detail ?? ''}`))];
  console.log(`✓ server events: ${kinds.join(', ') || '(none)'}`);

  const self = latestSnapshot(host).players.find((p) => p.id === joined.playerId);
  console.log(
    `✓ authoritative self state: hp=${self.hp} energy=${self.en} breakCharges=${self.charges} alive=${self.alive}`,
  );

  host.ws.close();
  guest.ws.close();
  console.log('\nSMOKE TEST PASSED');
}

main().catch((error) => {
  console.error(`\nSMOKE TEST FAILED: ${error.message}`);
  process.exitCode = 1;
});
