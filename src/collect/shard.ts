import { allQueries, BRAZIL_STATES, Limits, Profile } from '../config/profile.js';

/**
 * One addressable slice of a search: a state, a category and a price band, any
 * of which may be open.
 */
export interface Shard {
  /** Which phrasing this slice searches; absent means the profile's primary. */
  readonly query?: string | undefined;
  readonly state?: string | undefined;
  readonly category?: string | undefined;
  readonly minPrice?: number | undefined;
  readonly maxPrice?: number | undefined;
}

export interface PlannedShard extends Shard {
  readonly key: string;
  readonly totalCount: number;
  /**
   * The slice still exceeds what OLX will page through and could not be split
   * further. Recorded rather than hidden: a sweep that silently drops ads is
   * worse than one that says which ads it could not reach.
   */
  readonly truncated: boolean;
  readonly depth: number;
}

export interface PlanOutcome {
  readonly shards: PlannedShard[];
  readonly probes: number;
  readonly truncatedShards: PlannedShard[];
  /** Sum of the leaf counts; double-counts overlap, so an upper bound. */
  readonly reachableAds: number;
  readonly notes: string[];
}

export const shardKey = (shard: Shard): string =>
  [shard.state ?? 'br', shard.category ?? 'all', shard.minPrice ?? '', shard.maxPrice ?? ''].join(
    '|'
  );

/**
 * Price rungs used to break up a slice that is too big to page through.
 *
 * Geometric rather than linear because used-goods prices are: the gap between
 * R$ 50 and R$ 100 separates as many ads as the gap between R$ 8.000 and
 * R$ 15.000. The open top rung catches everything above the ladder.
 */
export const PRICE_LADDER: readonly number[] = [
  50, 100, 150, 200, 300, 400, 500, 700, 900, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 7000, 10000,
  15000, 25000, 40000, 70000, 120000,
];

type PriceBand = { minPrice?: number; maxPrice?: number };

/** Bands covering the whole range, from "up to the first rung" to "above the last". */
const ladderBands = (min?: number, max?: number): PriceBand[] => {
  const rungs = PRICE_LADDER.filter(
    rung => (min === undefined || rung > min) && (max === undefined || rung < max)
  );

  const bands: PriceBand[] = [];
  let lower = min;
  for (const rung of rungs) {
    bands.push({ ...(lower === undefined ? {} : { minPrice: lower }), maxPrice: rung });
    lower = rung;
  }
  bands.push({
    ...(lower === undefined ? {} : { minPrice: lower }),
    ...(max === undefined ? {} : { maxPrice: max }),
  });
  return bands;
};

/** Halves a closed band; used once the ladder itself is not fine enough. */
const bisect = (min: number, max: number): PriceBand[] => {
  const mid = Math.floor((min + max) / 2);
  if (mid <= min || mid >= max) return [];
  return [
    { minPrice: min, maxPrice: mid },
    { minPrice: mid, maxPrice: max },
  ];
};

export type ProbeFn = (shard: Shard) => Promise<number>;

/**
 * Works out which slices to sweep so that a query far larger than OLX's
 * 5.000-ad ceiling can still be collected.
 *
 * The shape of the problem: `q=iphone` across Brazil reports over a hundred
 * thousand results, and paging stops at 100 pages. So the query has to be cut
 * into pieces each of which fits under the ceiling. Splitting is tried in
 * increasing cost order — states first (27 ways, one probe each), then
 * categories if given, then price bands — and every branch is measured before it
 * is split, so a state with 12 matching ads costs one probe and no more.
 *
 * Known gap, stated rather than papered over: ads OLX lists without a price fall
 * outside every price band, so a slice that had to be split by price cannot
 * reach them. The unpriced ads are still collected from any ancestor slice that
 * fitted under the ceiling; where none did, `notes` says so.
 */
export const planShards = async (
  profile: Profile,
  probe: ProbeFn,
  limits: Limits = profile.limits
): Promise<PlanOutcome> => {
  const shards: PlannedShard[] = [];
  const truncatedShards: PlannedShard[] = [];
  const notes: string[] = [];
  const note = (message: string) => {
    if (!notes.includes(message)) notes.push(message);
  };
  let probes = 0;

  const states = profile.states.length > 0 ? profile.states : [...BRAZIL_STATES];
  const categories = profile.categories;

  const visit = async (shard: Shard, depth: number, splitsUsed: Set<string>): Promise<void> => {
    if (shards.length + truncatedShards.length >= limits.maxShards) return;
    if (probes >= limits.maxShards * 2) return;

    probes += 1;
    const totalCount = await probe(shard);

    if (totalCount === 0) return;

    const key = shardKey(shard);

    if (totalCount <= limits.adsPerShardCap) {
      shards.push({ ...shard, key, totalCount, truncated: false, depth });
      return;
    }

    if (depth >= limits.maxSplitDepth) {
      truncatedShards.push({ ...shard, key, totalCount, truncated: true, depth });
      note(
        `${key} holds ${totalCount} ads and hit the split-depth limit; only the first ` +
          `${limits.adsPerShardCap} are reachable.`
      );
      return;
    }

    // Cheapest split first: one probe per state, and it is the axis that most
    // reliably cuts a nationwide query down to size.
    if (!splitsUsed.has('state') && shard.state === undefined && states.length > 1) {
      const used = new Set(splitsUsed).add('state');
      for (const state of states) {
        await visit({ ...shard, state }, depth + 1, used);
      }
      return;
    }

    if (!splitsUsed.has('category') && shard.category === undefined && categories.length > 0) {
      const used = new Set(splitsUsed).add('category');
      for (const category of categories) {
        await visit({ ...shard, category }, depth + 1, used);
      }
      return;
    }

    if (!splitsUsed.has('ladder')) {
      const bands = ladderBands(shard.minPrice, shard.maxPrice);
      if (bands.length > 1) {
        const used = new Set(splitsUsed).add('ladder');
        for (const band of bands) {
          await visit({ ...shard, ...band }, depth + 1, used);
        }
        return;
      }
    }

    if (shard.minPrice !== undefined && shard.maxPrice !== undefined) {
      const halves = bisect(shard.minPrice, shard.maxPrice);
      if (halves.length === 2) {
        for (const half of halves) {
          await visit({ ...shard, ...half }, depth + 1, splitsUsed);
        }
        return;
      }
    }

    truncatedShards.push({ ...shard, key, totalCount, truncated: true, depth });
    note(
      `${key} holds ${totalCount} ads and cannot be split any further ` +
        `(the price band is already one unit wide); only the first ${limits.adsPerShardCap} are reachable.`
    );
  };

  const root: Shard = {
    ...(profile.minPrice === undefined ? {} : { minPrice: profile.minPrice }),
    ...(profile.maxPrice === undefined ? {} : { maxPrice: profile.maxPrice }),
    ...(profile.states.length === 1 && profile.states[0] ? { state: profile.states[0] } : {}),
    ...(categories.length === 1 && categories[0] ? { category: categories[0] } : {}),
  };

  // Each phrasing is planned independently: their result sets overlap, and the
  // store deduplicates by ad id, so the union costs less than the sum.
  for (const query of allQueries(profile)) {
    await visit({ ...root, query }, 0, new Set());
  }

  const all = [...shards, ...truncatedShards];
  if (all.some(shard => shard.minPrice !== undefined || shard.maxPrice !== undefined)) {
    note(
      'Some slices had to be split by price. Ads that OLX lists without a price do not appear in ' +
        'any price band, so they are only reachable where an unbanded slice fitted under the cap.'
    );
  }

  return {
    shards: all,
    probes,
    truncatedShards,
    reachableAds: all.reduce(
      (sum, shard) => sum + Math.min(shard.totalCount, limits.adsPerShardCap),
      0
    ),
    notes,
  };
};
