import { describe, it, expect } from 'vitest';
import { planShards, shardKey, Shard } from './shard.js';
import { LimitsSchema, ProfileSchema } from '../config/profile.js';

const profile = (overrides: Record<string, unknown> = {}) =>
  ProfileSchema.parse({ name: 'test', query: 'iphone', ...overrides });

const limits = (overrides: Record<string, unknown> = {}) =>
  LimitsSchema.parse({ adsPerShardCap: 5000, maxShards: 500, maxSplitDepth: 6, ...overrides });

/** Counts probes and answers from a table keyed by shard. */
const stubProbe = (counts: (shard: Shard) => number) => {
  const seen: Shard[] = [];
  return {
    seen,
    probe: async (shard: Shard) => {
      seen.push(shard);
      return counts(shard);
    },
  };
};

describe('planShards', () => {
  it('does not split a query that already fits, and spends one probe on it', async () => {
    const { probe, seen } = stubProbe(() => 120);
    const outcome = await planShards(profile({ states: ['rs'] }), probe, limits());

    expect(seen).toHaveLength(1);
    expect(outcome.shards).toHaveLength(1);
    expect(outcome.shards[0]?.totalCount).toBe(120);
    expect(outcome.shards[0]?.truncated).toBe(false);
  });

  it('collects nothing for a query with no results', async () => {
    const { probe } = stubProbe(() => 0);
    const outcome = await planShards(profile(), probe, limits());
    expect(outcome.shards).toHaveLength(0);
  });

  it('splits a nationwide query by state first, the cheapest axis', async () => {
    // 100k nationwide, a manageable slice per state.
    const { probe } = stubProbe(shard => (shard.state === undefined ? 100_000 : 300));
    const outcome = await planShards(profile(), probe, limits());

    expect(outcome.shards).toHaveLength(27);
    expect(outcome.shards.every(shard => shard.state !== undefined)).toBe(true);
    expect(outcome.shards.every(shard => shard.minPrice === undefined)).toBe(true);
  });

  it('falls back to price bands for a state that is still too big', async () => {
    const { probe } = stubProbe(shard => {
      if (shard.state === undefined) return 400_000;
      if (shard.maxPrice === undefined && shard.minPrice === undefined) return 40_000;
      return 200;
    });

    const outcome = await planShards(profile({ states: ['sp'] }), probe, limits());

    expect(outcome.shards.length).toBeGreaterThan(1);
    expect(outcome.shards.every(shard => shard.state === 'sp')).toBe(true);
    expect(
      outcome.shards.every(shard => shard.minPrice !== undefined || shard.maxPrice !== undefined)
    ).toBe(true);
  });

  it('bisects a band the ladder could not cut finely enough', async () => {
    // Everything is over the cap until the band is narrower than 25 currency units.
    const { probe } = stubProbe(shard => {
      const min = shard.minPrice ?? 0;
      const max = shard.maxPrice ?? 1_000_000;
      return max - min <= 25 ? 100 : 9_000;
    });

    const outcome = await planShards(
      profile({ states: ['rs'], minPrice: 100, maxPrice: 200 }),
      probe,
      limits({ maxSplitDepth: 8 })
    );

    expect(outcome.shards.some(shard => (shard.maxPrice ?? 0) - (shard.minPrice ?? 0) <= 25)).toBe(
      true
    );
  });

  it('reports a slice it could not cut small enough instead of pretending it fits', async () => {
    const { probe } = stubProbe(() => 50_000);
    const outcome = await planShards(
      profile({ states: ['sp'] }),
      probe,
      limits({ maxSplitDepth: 1 })
    );

    expect(outcome.truncatedShards.length).toBeGreaterThan(0);
    expect(outcome.notes.join(' ')).toMatch(/only the first 5000 are reachable/);
  });

  it('warns that price-banded slices cannot reach ads listed without a price', async () => {
    const { probe } = stubProbe(shard =>
      shard.minPrice === undefined && shard.maxPrice === undefined ? 40_000 : 100
    );
    const outcome = await planShards(profile({ states: ['sp'] }), probe, limits());

    expect(outcome.notes.join(' ')).toMatch(/without a price/);
  });

  it('caps the plan at maxShards so a bad query cannot fan out forever', async () => {
    const { probe } = stubProbe(() => 100_000);
    const outcome = await planShards(profile(), probe, limits({ maxShards: 10 }));

    expect(outcome.shards.length).toBeLessThanOrEqual(10);
  });

  it('bounds reachable ads by the cap rather than by the reported total', async () => {
    const { probe } = stubProbe(shard => (shard.state === undefined ? 100_000 : 9_000));
    const outcome = await planShards(
      profile({ states: ['rs'] }),
      probe,
      limits({ maxSplitDepth: 0 + 1, adsPerShardCap: 5000 })
    );

    expect(outcome.reachableAds).toBeLessThanOrEqual(outcome.shards.length * 5000);
  });
});

describe('shardKey', () => {
  it('is stable and distinguishes every axis, so resume matches the right slice', () => {
    expect(shardKey({ state: 'sp' })).toBe('sp|all||');
    expect(shardKey({ state: 'sp', minPrice: 100, maxPrice: 200 })).toBe('sp|all|100|200');
    expect(shardKey({ category: 'celulares' })).toBe('br|celulares||');
    expect(shardKey({ state: 'sp', minPrice: 100 })).not.toBe(
      shardKey({ state: 'sp', maxPrice: 100 })
    );
  });
});
