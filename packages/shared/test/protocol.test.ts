import { describe, expect, it } from 'vitest';
import {
  PLAYER,
  ROOM_CODE_LENGTH,
  encodeClientMessage,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseClientMessage,
  parsePlayerInput,
  sanitizeName,
} from '../src/index.js';

describe('room codes', () => {
  it('generates codes of the configured length from the safe alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRoomCode(Math.random);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it('produces different codes for different random draws', () => {
    const a = generateRoomCode(() => 0.1);
    const b = generateRoomCode(() => 0.95);
    expect(a).not.toBe(b);
  });

  it('normalises case and whitespace but rejects bad input', () => {
    expect(normalizeRoomCode(' abcd2 ')).toBe('ABCD2');
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCDI')).toBeNull(); // I is not in the alphabet
    expect(normalizeRoomCode('ABCD0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRoomCode(42)).toBeNull();
  });
});

describe('names', () => {
  it('strips control characters and clamps length', () => {
    expect(sanitizeName('  Bo  b  ')).toBe('Bo b');
    expect(sanitizeName('a'.repeat(50))).toHaveLength(PLAYER.nameMaxLength);
    expect(sanitizeName('')).toBe('Fighter');
    expect(sanitizeName(undefined)).toBe('Fighter');
  });
});

describe('input validation', () => {
  it('clamps movement, angles and coerces booleans', () => {
    const parsed = parsePlayerInput({
      seq: 12,
      moveX: 99,
      moveZ: -99,
      yaw: 40,
      pitch: -99,
      jump: 1,
      punch: 'yes',
      shockwave: true,
    });
    expect(parsed.moveX).toBe(1);
    expect(parsed.moveZ).toBe(-1);
    expect(parsed.pitch).toBe(PLAYER.pitchMin);
    expect(parsed.pitch).toBeLessThan(0);
    expect(parsed.jump).toBe(false); // only literal `true` counts
    expect(parsed.punch).toBe(false);
    expect(parsed.shockwave).toBe(true);
    expect(Math.abs(parsed.yaw)).toBeLessThanOrEqual(Math.PI);
  });

  it('returns a safe default for garbage input', () => {
    const parsed = parsePlayerInput('not-an-object');
    expect(parsed.moveX).toBe(0);
    expect(parsed.seq).toBe(0);
  });
});

describe('client messages', () => {
  it('rejects unknown types and malformed JSON', () => {
    const unknown = parseClientMessage(JSON.stringify({ t: 'nope' }));
    expect(unknown.ok).toBe(false);
    const malformed = parseClientMessage('{oops');
    expect(malformed.ok).toBe(false);
    const huge = parseClientMessage('x'.repeat(5000));
    expect(huge.ok).toBe(false);
  });

  it('validates join messages', () => {
    const bad = parseClientMessage(JSON.stringify({ t: 'join', name: 'Ann', code: 'ZZ' }));
    expect(bad.ok).toBe(false);
    const good = parseClientMessage(JSON.stringify({ t: 'join', name: 'Ann', code: 'abcd2' }));
    expect(good.ok).toBe(true);
    if (good.ok && good.message.t === 'join') {
      expect(good.message.code).toBe('ABCD2');
      expect(good.message.name).toBe('Ann');
    }
  });

  it('round-trips an input frame', () => {
    const text = encodeClientMessage({
      t: 'input',
      input: { ...parsePlayerInput({ seq: 3, moveZ: 1 }), yaw: 0.5 },
    });
    const parsed = parseClientMessage(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.t === 'input') {
      expect(parsed.message.input.seq).toBe(3);
      expect(parsed.message.input.yaw).toBeCloseTo(0.5);
    }
  });
});
