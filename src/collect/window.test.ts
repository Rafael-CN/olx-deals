import { describe, it, expect } from 'vitest';
import { isOpen, msUntilOpen, parseWindow } from './window.js';

const at = (hours: number, minutes = 0, seconds = 0) =>
  new Date(2026, 7, 26, hours, minutes, seconds);

describe('parseWindow', () => {
  it('reads an ordinary window', () => {
    expect(parseWindow('02:00-07:00')).toEqual({ startMinutes: 120, endMinutes: 420 });
  });

  it('tolerates a single-digit hour and surrounding space', () => {
    expect(parseWindow(' 2:30 - 7:15 ')).toEqual({ startMinutes: 150, endMinutes: 435 });
  });

  it('rejects what it cannot read rather than guessing', () => {
    expect(() => parseWindow('2-7')).toThrow(/must look like/);
    expect(() => parseWindow('25:00-26:00')).toThrow();
    expect(() => parseWindow('03:00-03:00')).toThrow(/zero minutes/);
  });
});

describe('isOpen', () => {
  const night = parseWindow('23:00-06:00');
  const day = parseWindow('09:00-18:00');

  it('handles a window inside one day', () => {
    expect(isOpen(day, at(9))).toBe(true);
    expect(isOpen(day, at(17, 59))).toBe(true);
    expect(isOpen(day, at(18))).toBe(false);
    expect(isOpen(day, at(8, 59))).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    expect(isOpen(night, at(23, 30))).toBe(true);
    expect(isOpen(night, at(2))).toBe(true);
    expect(isOpen(night, at(5, 59))).toBe(true);
    expect(isOpen(night, at(6))).toBe(false);
    expect(isOpen(night, at(12))).toBe(false);
  });
});

describe('msUntilOpen', () => {
  it('is zero while the window is open', () => {
    expect(msUntilOpen(parseWindow('02:00-07:00'), at(3))).toBe(0);
  });

  it('counts forward to the next opening later today', () => {
    expect(msUntilOpen(parseWindow('02:00-07:00'), at(1, 30))).toBe(30 * 60_000);
  });

  it('counts across midnight when the window has already passed', () => {
    // 08:00, window opens 02:00 tomorrow: 18 hours away.
    expect(msUntilOpen(parseWindow('02:00-07:00'), at(8))).toBe(18 * 60 * 60_000);
  });

  it('accounts for seconds already elapsed, so it does not wake up early', () => {
    expect(msUntilOpen(parseWindow('02:00-07:00'), at(1, 59, 30))).toBe(30_000);
  });

  it('waits for the next opening of a wrapped window', () => {
    // 12:00 with a 23:00-06:00 window: 11 hours to 23:00.
    expect(msUntilOpen(parseWindow('23:00-06:00'), at(12))).toBe(11 * 60 * 60_000);
  });
});
