/**
 * Room registry.
 *
 * Creates rooms with unguessable codes, looks them up for joins, ticks them all
 * from one loop and destroys abandoned ones. Room codes are generated from a
 * CSPRNG and retried on (unlikely) collision.
 */
import { randomBytes } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_TTL_MS } from '@fracture/shared';
import { Room, type JoinResult, type RoomOptions, type SocketLike } from './room.js';
import type { Logger } from './logger.js';

const MAX_ROOMS = 1000;

function randomInt(maxExclusive: number): number {
  // Rejection sampling over a 32-bit draw keeps the distribution uniform.
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  let value = 0;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % maxExclusive;
}

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]!;
  }
  return code;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly log: Logger,
    private readonly options: RoomOptions = {},
  ) {}

  get size(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let total = 0;
    for (const room of this.rooms.values()) total += room.sim.connectedCount;
    return total;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  create(): Room {
    if (this.rooms.size >= MAX_ROOMS) {
      // Reclaim anything that is already disposable before refusing.
      this.sweep();
    }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const code = generateRoomCode();
      if (this.rooms.has(code)) continue;
      const room = new Room(code, this.log, this.options);
      this.rooms.set(code, room);
      this.log.info('room created', { code, rooms: this.rooms.size });
      return room;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  join(
    code: string,
    socket: SocketLike,
    name: string,
    token?: string,
  ): { ok: true; room: Room; result: JoinResult } | { ok: false; code: 'room-not-found' } {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, code: 'room-not-found' };
    return { ok: true, room, result: room.join(socket, name, token) };
  }

  /** Tick every room exactly once. */
  tickAll(): void {
    for (const room of this.rooms.values()) {
      try {
        room.tick();
      } catch (error) {
        this.log.error('room tick failed', {
          code: room.code,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      }
    }
  }

  /** Destroy rooms that are empty/abandoned or whose results are stale. */
  sweep(now = Date.now()): number {
    let destroyed = 0;
    for (const [code, room] of [...this.rooms]) {
      if (room.shouldBeDestroyed(now, ROOM_TTL_MS)) {
        this.rooms.delete(code);
        destroyed += 1;
      }
    }
    if (destroyed > 0) this.log.info('rooms swept', { destroyed, remaining: this.rooms.size });
    return destroyed;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      room.broadcast({ t: 'left', reason: 'server-shutdown' });
    }
    this.rooms.clear();
  }

  describe(): string[] {
    return [...this.rooms.values()].map((room) => room.describe());
  }
}
