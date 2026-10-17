/**
 * FRACTURE wire protocol.
 *
 * The server never trusts a client message: every inbound field is validated,
 * clamped and defaulted here before it reaches the simulation. Messages are
 * plain JSON; anything malformed or oversized is rejected with an error code.
 */
import {
  MAX_MESSAGE_BYTES,
  PLAYER,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from './config.js';
import { clamp, type Vec3 } from './math.js';
import type {
  ClientMessage,
  ErrorCode,
  PlayerInput,
  ServerMessage,
} from './types.js';
import { emptyInput } from './types.js';

export interface ParseFailure {
  ok: false;
  code: ErrorCode;
  message: string;
}

export interface ParseSuccess<T> {
  ok: true;
  message: T;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/**
 * Cryptographically-flavoured room code. `random` must return [0, 1); the
 * server passes a CSPRNG-backed function so codes are not guessable.
 */
export function generateRoomCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const index = Math.floor(random() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length;
    code += ROOM_CODE_ALPHABET[index]!;
  }
  return code;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const char of code) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

export function isValidRoomCode(raw: unknown): boolean {
  return normalizeRoomCode(raw) !== null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function sanitizeName(raw: unknown, fallback = 'Fighter'): string {
  if (typeof raw !== 'string') return fallback;
  // Strip control characters and collapse whitespace.
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, PLAYER.nameMaxLength);
}

export function isValidName(raw: unknown): boolean {
  return typeof raw === 'string' && sanitizeName(raw, '').length >= PLAYER.nameMinLength;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a < -Math.PI) a += twoPi;
  return a;
}

/** Validate and clamp a client input frame. Never throws. */
export function parsePlayerInput(raw: unknown): PlayerInput {
  if (typeof raw !== 'object' || raw === null) return emptyInput();
  const source = raw as Record<string, unknown>;
  const seq = Math.floor(asFiniteNumber(source.seq, 0));
  return {
    seq: clamp(seq, 0, 2_147_483_000),
    moveX: clamp(asFiniteNumber(source.moveX, 0), -1, 1),
    moveZ: clamp(asFiniteNumber(source.moveZ, 0), -1, 1),
    yaw: normalizeAngle(asFiniteNumber(source.yaw, 0)),
    pitch: clamp(asFiniteNumber(source.pitch, 0), PLAYER.pitchMin, PLAYER.pitchMax),
    jump: asBool(source.jump),
    dodge: asBool(source.dodge),
    punch: asBool(source.punch),
    gravity: asBool(source.gravity),
    shockwave: asBool(source.shockwave),
    breakPlatform: asBool(source.breakPlatform),
  };
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Parse a client message. The transport is responsible for decoding binary
 * frames into text (the server calls `Buffer.toString('utf8')`), which keeps
 * this package free of both DOM and Node type dependencies.
 */
export function parseClientMessage(text: string): ParseResult<ClientMessage> {
  if (text.length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: 'bad-message', message: 'Message too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad-message', message: 'Malformed JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: 'bad-message', message: 'Message must be an object' };
  }
  const source = parsed as Record<string, unknown>;
  const type = source.t;

  switch (type) {
    case 'create':
      return {
        ok: true,
        message: {
          t: 'create',
          name: sanitizeName(source.name),
          token: typeof source.token === 'string' ? source.token.slice(0, 64) : undefined,
          version: typeof source.version === 'string' ? source.version.slice(0, 32) : undefined,
        },
      };
    case 'join': {
      const code = normalizeRoomCode(source.code);
      if (!code) return { ok: false, code: 'bad-message', message: 'Invalid room code' };
      if (!isValidName(source.name)) {
        return { ok: false, code: 'name-invalid', message: 'Choose a valid name' };
      }
      return {
        ok: true,
        message: {
          t: 'join',
          name: sanitizeName(source.name),
          code,
          token: typeof source.token === 'string' ? source.token.slice(0, 64) : undefined,
        },
      };
    }
    case 'ready':
      return { ok: true, message: { t: 'ready', ready: asBool(source.ready) } };
    case 'start':
      return { ok: true, message: { t: 'start' } };
    case 'input':
      return {
        ok: true,
        message: { t: 'input', input: parsePlayerInput(source.input) },
      };
    case 'rematch':
      return { ok: true, message: { t: 'rematch' } };
    case 'leave':
      return { ok: true, message: { t: 'leave' } };
    case 'ping':
      return { ok: true, message: { t: 'ping', ts: clamp(asFiniteNumber(source.ts, 0), 0, 1e15) } };
    default:
      return { ok: false, code: 'bad-message', message: `Unknown message type: ${String(type)}` };
  }
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Client-side parse of a server message (the client is trusting here). */
export function parseServerMessage(text: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(text) as ServerMessage;
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { t?: unknown }).t !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Convenience: JSON-stringify a server message. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Serialisation helpers used by the client renderer
// ---------------------------------------------------------------------------

export function toVec3(tuple: readonly [number, number, number]): Vec3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}
