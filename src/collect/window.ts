/**
 * An hours-of-day window a run is allowed to work in.
 *
 * Two reasons to have one. A site under load polices traffic harder than a quiet
 * one, so the same sweep at 4am is both cheaper for them and less likely to trip
 * anything. And a long sweep spread across nights is far easier to make gentle
 * than one that has to finish this afternoon.
 *
 * Windows are read in local time and may wrap midnight ("23:00-06:00").
 */

export interface ActiveWindow {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export const parseWindow = (value: string): ActiveWindow => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`--window must look like "02:00-07:00", got "${value}"`);
  }

  const [, sh, sm, eh, em] = match;
  const startMinutes = Number(sh) * 60 + Number(sm);
  const endMinutes = Number(eh) * 60 + Number(em);

  if (startMinutes > 1439 || endMinutes > 1439) {
    throw new Error(`--window hours must be 00:00-23:59, got "${value}"`);
  }
  if (startMinutes === endMinutes) {
    throw new Error(`--window "${value}" is zero minutes long`);
  }

  return { startMinutes, endMinutes };
};

const minutesOfDay = (date: Date): number => date.getHours() * 60 + date.getMinutes();

export const isOpen = (window: ActiveWindow, now: Date): boolean => {
  const minute = minutesOfDay(now);
  return window.startMinutes < window.endMinutes
    ? minute >= window.startMinutes && minute < window.endMinutes
    : // Wrapped past midnight: open at either end of the day.
      minute >= window.startMinutes || minute < window.endMinutes;
};

/** Milliseconds to wait before the window opens; 0 when it already is. */
export const msUntilOpen = (window: ActiveWindow, now: Date): number => {
  if (isOpen(window, now)) return 0;

  const minute = minutesOfDay(now);
  const secondsIntoMinute = now.getSeconds() + now.getMilliseconds() / 1000;
  const minutesAway =
    window.startMinutes > minute
      ? window.startMinutes - minute
      : 1440 - minute + window.startMinutes;

  return Math.max(0, Math.round((minutesAway * 60 - secondsIntoMinute) * 1000));
};
