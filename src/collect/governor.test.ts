import { describe, it, expect } from 'vitest';
import { CollectionHalted, RateGovernor, isBlockError } from './governor.js';
import { PacingSchema } from '../config/profile.js';

/** A governor on a fake clock, so pacing is asserted rather than waited for. */
const build = (overrides: Record<string, unknown> = {}) => {
  let clock = 0;
  const slept: number[] = [];
  const pacing = PacingSchema.parse({ jitterMs: 0, ...overrides });
  const governor = new RateGovernor(
    pacing,
    async ms => {
      slept.push(ms);
      clock += ms;
    },
    () => clock,
    () => 0
  );
  return { governor, slept, tick: (ms: number) => (clock += ms), now: () => clock };
};

describe('RateGovernor', () => {
  it('spaces requests at the starting rate', async () => {
    const { governor, slept } = build({ startRequestsPerMinute: 12 });

    await governor.acquire();
    await governor.acquire();
    await governor.acquire();

    // 12 rpm is one every 5s; the first request goes out immediately.
    expect(slept).toEqual([5000, 5000]);
  });

  it('raises the rate only after a clean streak, and never past the ceiling', async () => {
    const { governor } = build({
      startRequestsPerMinute: 10,
      maxRequestsPerMinute: 11,
      increaseAfterCleanRequests: 3,
    });

    expect(governor.stats.currentRpm).toBe(10);
    for (let i = 0; i < 3; i += 1) governor.reportSuccess();
    expect(governor.stats.currentRpm).toBe(11);

    for (let i = 0; i < 30; i += 1) governor.reportSuccess();
    expect(governor.stats.currentRpm).toBe(11);
  });

  it('halves the rate on a block and sits out the cooldown', async () => {
    const { governor, slept } = build({
      startRequestsPerMinute: 20,
      cooldownSeconds: 60,
      backoffFactor: 0.5,
    });

    await governor.acquire();
    governor.reportBlocked();
    expect(governor.stats.currentRpm).toBe(10);

    await governor.acquire();
    // The next request waits out the whole cooldown, not the ordinary interval.
    expect(slept.at(-1)).toBe(60_000);
  });

  it('waits out a Retry-After that came with something other than a block', async () => {
    const { governor, slept } = build({ startRequestsPerMinute: 60, maxCooldownSeconds: 900 });

    // The standard "please pause" is a 503 with Retry-After. Routing it only
    // through reportBlocked meant the politest thing a server can say was
    // handled worse than a 429: a flat rate cut, and the stated wait ignored.
    governor.reportError(120);

    await governor.acquire();
    expect(slept.at(-1)).toBe(120_000);
  });

  it('does not let a Retry-After outstay the cooldown ceiling', async () => {
    const { governor, slept } = build({ startRequestsPerMinute: 60, maxCooldownSeconds: 300 });

    governor.reportError(9999);

    await governor.acquire();
    expect(slept.at(-1)).toBe(300_000);
  });

  it('slows for an error without escalating it into a block', () => {
    const { governor } = build({ haltAfterConsecutiveBlocks: 2 });

    // An error is not a refusal of us: it must not count toward the halt, or a
    // flaky connection reads as a ban.
    governor.reportError(30);
    governor.reportError(30);
    governor.reportError(30);
    expect(governor.stats.blocks).toBe(0);
    expect(() => governor.reportBlocked()).not.toThrow();
  });

  it('gives up rather than retrying through a sustained block', async () => {
    const { governor } = build({ haltAfterConsecutiveBlocks: 3, minRequestsPerMinute: 1 });

    governor.reportBlocked();
    governor.reportBlocked();
    expect(() => governor.reportBlocked()).toThrow(CollectionHalted);
  });

  it('forgets the block streak once a request succeeds', () => {
    const { governor } = build({ haltAfterConsecutiveBlocks: 2 });

    governor.reportBlocked();
    governor.reportSuccess();
    // Were the streak still standing, this second block would halt the run.
    expect(() => governor.reportBlocked()).not.toThrow();
  });

  it('never drops below the floor, however many blocks arrive', () => {
    const { governor } = build({
      startRequestsPerMinute: 30,
      minRequestsPerMinute: 5,
      backoffFactor: 0.5,
      haltAfterConsecutiveBlocks: 99,
    });

    for (let i = 0; i < 20; i += 1) governor.reportBlocked();
    expect(governor.stats.currentRpm).toBe(5);
  });

  it('slows for a transport error without treating it as a refusal', () => {
    const { governor } = build({ startRequestsPerMinute: 20, haltAfterConsecutiveBlocks: 1 });

    governor.reportError();
    expect(governor.stats.currentRpm).toBeLessThan(20);
    expect(governor.stats.blocks).toBe(0);
    expect(governor.stats.errors).toBe(1);
  });

  it('accounts for what it spent waiting, so a run can report its own pacing', async () => {
    const { governor } = build({ startRequestsPerMinute: 60 });

    await governor.acquire();
    await governor.acquire();
    await governor.acquire();

    expect(governor.stats.requests).toBe(3);
    expect(governor.stats.waitedMs).toBe(2000);
  });
});

describe('isBlockError', () => {
  it('recognises the refusal the scraper reports', () => {
    expect(
      isBlockError(new Error('olx.com.br answered 403 for https://... — blocked or rate-limited'))
    ).toBe(true);
    expect(isBlockError(new Error('olx.com.br answered 429 for https://...'))).toBe(true);
  });

  it('does not mistake an ordinary failure for a block', () => {
    expect(isBlockError(new Error('page.goto: Timeout 30000ms exceeded'))).toBe(false);
    expect(isBlockError(new Error('olx.com.br answered 503 — the page was not served.'))).toBe(
      false
    );
    expect(isBlockError(undefined)).toBe(false);
  });
});
