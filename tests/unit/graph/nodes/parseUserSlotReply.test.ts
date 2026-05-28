import { describe, expect, it } from 'vitest';
import { parseUserSlotReply } from '../../../../src/graph/nodes/parseUserSlotReply.js';

const TZ = 'America/Argentina/Buenos_Aires';
// Pin "now" a un miércoles 27 mayo 2026 a las 12:00 UTC (≈ 09:00 hora AR)
const NOW = new Date('2026-05-27T12:00:00Z');

describe('parseUserSlotReply — date extraction', () => {
  it('parses "hoy" → today in timezone', () => {
    const out = parseUserSlotReply('hoy a las 4', TZ, NOW);
    expect(out.date).toBe('2026-05-27');
  });

  it('parses "mañana" → +1 day', () => {
    const out = parseUserSlotReply('mañana 10hs', TZ, NOW);
    expect(out.date).toBe('2026-05-28');
  });

  it('parses "pasado mañana" → +2 days (before matching "mañana")', () => {
    const out = parseUserSlotReply('pasado mañana', TZ, NOW);
    expect(out.date).toBe('2026-05-29');
  });

  it('parses weekday → next occurrence (never today)', () => {
    // miércoles is today; "miércoles" should jump to NEXT wednesday (+7)
    const out = parseUserSlotReply('el miércoles', TZ, NOW);
    expect(out.date).toBe('2026-06-03');
  });

  it('parses next weekday day correctly (jueves = +1)', () => {
    const out = parseUserSlotReply('jueves', TZ, NOW);
    expect(out.date).toBe('2026-05-28');
  });

  it('parses ISO YYYY-MM-DD', () => {
    const out = parseUserSlotReply('para el 2026-06-15', TZ, NOW);
    expect(out.date).toBe('2026-06-15');
  });

  it('parses "15 de marzo" (current year)', () => {
    const out = parseUserSlotReply('quiero el 15 de marzo', TZ, NOW);
    expect(out.date).toBe('2026-03-15');
  });

  it('parses "15/03" (current year)', () => {
    const out = parseUserSlotReply('el 15/03', TZ, NOW);
    expect(out.date).toBe('2026-03-15');
  });

  it('parses "15/03/2027" (explicit year)', () => {
    const out = parseUserSlotReply('el 15/03/2027', TZ, NOW);
    expect(out.date).toBe('2027-03-15');
  });

  it('returns null date when text has no date', () => {
    expect(parseUserSlotReply('a las 4', TZ, NOW).date).toBeNull();
  });
});

describe('parseUserSlotReply — time extraction', () => {
  it('parses explicit HH:mm (24h)', () => {
    expect(parseUserSlotReply('a las 14:30', TZ, NOW).time).toBe('14:30');
  });

  it('PM heuristic: "4" → 16:00 (in business window)', () => {
    expect(parseUserSlotReply('a las 4', TZ, NOW).time).toBe('16:00');
  });

  it('PM heuristic: "6" → 18:00', () => {
    expect(parseUserSlotReply('a las 6', TZ, NOW).time).toBe('18:00');
  });

  it('AM literal: "9" → 09:00 (above PM threshold)', () => {
    expect(parseUserSlotReply('a las 9', TZ, NOW).time).toBe('09:00');
  });

  it('AM suffix forces AM: "4am" → 04:00', () => {
    expect(parseUserSlotReply('a las 4am', TZ, NOW).time).toBe('04:00');
  });

  it('PM suffix forces PM: "4pm" → 16:00', () => {
    expect(parseUserSlotReply('a las 4pm', TZ, NOW).time).toBe('16:00');
  });

  it('PM suffix on 12: "12pm" → 12:00', () => {
    expect(parseUserSlotReply('12pm', TZ, NOW).time).toBe('12:00');
  });

  it('AM suffix on 12: "12am" → 00:00', () => {
    expect(parseUserSlotReply('12am', TZ, NOW).time).toBe('00:00');
  });

  it('"hs" suffix keeps the hour as-is (24h): "16hs" → 16:00', () => {
    expect(parseUserSlotReply('a las 16hs', TZ, NOW).time).toBe('16:00');
  });

  it('returns null time when ambiguous (no time mention)', () => {
    expect(parseUserSlotReply('mañana', TZ, NOW).time).toBeNull();
  });
});

describe('parseUserSlotReply — combined', () => {
  it('extracts both date and time from one phrase', () => {
    const out = parseUserSlotReply('mañana a las 4', TZ, NOW);
    expect(out).toEqual({ date: '2026-05-28', time: '16:00' });
  });

  it('handles "jueves a las 17"', () => {
    const out = parseUserSlotReply('jueves a las 17', TZ, NOW);
    expect(out).toEqual({ date: '2026-05-28', time: '17:00' });
  });

  it('returns both null on empty string', () => {
    expect(parseUserSlotReply('', TZ, NOW)).toEqual({ date: null, time: null });
  });
});
