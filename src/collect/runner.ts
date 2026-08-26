import { Page } from 'playwright';
import { CategoryId, LocationId, SearchFilters } from '../core/types.js';
import { Limits, Profile } from '../config/profile.js';
import { OLXBRScraper } from '../scrapers/olx/olx-br.scraper.js';
import { Store } from '../store/db.js';
import { BrowserSession } from './session.js';
import { CollectionHalted, RateGovernor, isBlockError } from './governor.js';
import { Shard, shardKey } from './shard.js';

/** Ads per search page on olx.com.br. */
const PAGE_SIZE = 50;

export interface RunnerContext {
  readonly scraper: OLXBRScraper;
  readonly session: BrowserSession;
  readonly governor: RateGovernor;
  readonly store: Store;
  readonly profile: Profile;
  readonly log: (message: string) => void;
}

export interface Budget {
  requests: number;
  cards: number;
  details: number;
  readonly deadline: number;
}

export const newBudget = (limits: Limits): Budget => ({
  requests: limits.maxRequests,
  cards: limits.maxCards,
  details: limits.maxDetails,
  deadline: Date.now() + limits.maxRunMinutes * 60_000,
});

const filtersFor = (profile: Profile, shard: Shard, page: number): SearchFilters => ({
  domain: 'olx.com.br',
  query: profile.query,
  ...(shard.category ? { category: shard.category as CategoryId } : {}),
  ...(shard.state ? { location: shard.state as LocationId } : {}),
  ...(shard.minPrice === undefined ? {} : { minPrice: shard.minPrice }),
  ...(shard.maxPrice === undefined ? {} : { maxPrice: shard.maxPrice }),
  page,
  limit: PAGE_SIZE,
  sortBy: profile.sortBy,
});

/**
 * One governed request. Everything that touches olx.com.br goes through here so
 * that pacing, block handling and the request budget cannot be bypassed by a new
 * code path forgetting to ask.
 */
const request = async <T>(
  context: RunnerContext,
  budget: Budget,
  work: (page: Page) => Promise<T>
): Promise<T> => {
  if (budget.requests <= 0) throw new CollectionHalted('request budget exhausted');
  if (Date.now() > budget.deadline) throw new CollectionHalted('run time limit reached');

  await context.governor.acquire();
  budget.requests -= 1;

  try {
    const result = await context.session.withPage(work);
    context.governor.reportSuccess();
    return result;
  } catch (error) {
    if (isBlockError(error)) {
      context.log(`blocked by olx.com.br — backing off (${context.governor.stats.currentRpm} rpm)`);
      // Throws CollectionHalted once the site has refused repeatedly.
      context.governor.reportBlocked();
    } else {
      context.governor.reportError();
    }
    throw error;
  }
};

/**
 * Reads a slice's result count without collecting it. Used by the planner, which
 * needs to know how big a slice is before deciding whether to split it — one
 * request buys the answer for a slice that might hold five thousand ads.
 */
export const makeProbe =
  (context: RunnerContext, budget: Budget) =>
  async (shard: Shard): Promise<number> => {
    const filters = filtersFor(context.profile, shard, 1);
    try {
      const result = await request(context, budget, page =>
        context.scraper.searchOn(page, { ...filters, limit: 1 })
      );
      return result.totalCount;
    } catch (error) {
      if (error instanceof CollectionHalted) throw error;
      context.log(`probe failed for ${shardKey(shard)}: ${(error as Error).message}`);
      return 0;
    }
  };

export interface CollectOutcome {
  readonly shardsDone: number;
  readonly cardsSeen: number;
  readonly newAds: number;
  readonly halted?: string | undefined;
}

/**
 * Walks every pending shard, paging until the slice is exhausted or the cap is
 * reached, writing each page to the store as it lands.
 *
 * Writing per page rather than per shard is what makes a run resumable: a block
 * on page 40 of 100 leaves 39 pages of ads on disk and a shard marked with how
 * far it got, so the same command picks up from there instead of starting over.
 */
export const collect = async (
  context: RunnerContext,
  runId: string,
  budget: Budget
): Promise<CollectOutcome> => {
  const { store, profile, log } = context;
  const cap = Math.min(profile.limits.adsPerShardCap, 5000);

  let shardsDone = 0;
  let cardsSeen = 0;
  let newAds = 0;
  let halted: string | undefined;

  const shards = store.pendingShards(runId);
  log(`${shards.length} shard(s) to sweep`);

  for (const shard of shards) {
    if (budget.cards <= 0) {
      halted = 'card budget reached';
      break;
    }

    const slice: Shard = {
      ...(shard.state ? { state: shard.state } : {}),
      ...(shard.category ? { category: shard.category } : {}),
      ...(shard.min_price === null ? {} : { minPrice: shard.min_price }),
      ...(shard.max_price === null ? {} : { maxPrice: shard.max_price }),
    };

    const reachable = Math.min(shard.total_count, cap);
    const lastPage = Math.max(1, Math.ceil(reachable / PAGE_SIZE));
    store.updateShard(runId, shard.key, { status: 'running' });

    let pagesDone = shard.pages_done;
    let shardCards = 0;

    try {
      for (let pageNumber = pagesDone + 1; pageNumber <= lastPage; pageNumber += 1) {
        if (budget.cards <= 0) {
          halted = 'card budget reached';
          break;
        }

        const result = await request(context, budget, page =>
          context.scraper.searchOn(page, filtersFor(profile, slice, pageNumber))
        );

        const fresh = store.saveCards(runId, shard.key, result.listings, new Date().toISOString());
        newAds += fresh;
        shardCards += result.listings.length;
        cardsSeen += result.listings.length;
        budget.cards -= result.listings.length;
        pagesDone = pageNumber;

        store.updateShard(runId, shard.key, {
          pagesDone,
          cardsSeen: shardCards,
          status: 'running',
        });

        // An empty page before the computed last one means the slice ran out
        // early, which happens when ads are removed between the probe and now.
        if (result.listings.length === 0 || !result.hasNextPage) break;
      }

      store.updateShard(runId, shard.key, {
        status: 'done',
        pagesDone,
        cardsSeen: shardCards,
      });
      shardsDone += 1;
      log(
        `${shard.key}: ${shardCards} cards over ${pagesDone} page(s) ` +
          `(${newAds} new so far, ${context.governor.stats.currentRpm} rpm)`
      );
      await context.session.saveState();
    } catch (error) {
      const message = (error as Error).message;
      store.updateShard(runId, shard.key, {
        status: 'pending',
        pagesDone,
        cardsSeen: shardCards,
        error: message,
      });

      if (error instanceof CollectionHalted) {
        halted = message;
        break;
      }
      log(`${shard.key} failed: ${message}`);
    }

    if (halted) break;
  }

  return { shardsDone, cardsSeen, newAds, halted };
};

export interface EnrichOutcome {
  readonly fetched: number;
  readonly failed: number;
  readonly halted?: string | undefined;
}

/**
 * Fetches the ad pages of everything that survived card-level triage.
 *
 * This is where the money goes: one request per ad, against fifty ads per
 * request during collection. Ordered cheapest first, because when the budget runs
 * out mid-list the ads worth having read are the ones a bargain hunt is about.
 */
export const enrich = async (
  context: RunnerContext,
  runId: string,
  budget: Budget
): Promise<EnrichOutcome> => {
  const { store, log } = context;
  let fetched = 0;
  let failed = 0;
  let halted: string | undefined;

  const pending = store.adsAwaitingDetail(runId, Math.min(budget.details, 5000));
  log(`${pending.length} ad page(s) to read`);

  for (const ad of pending) {
    if (budget.details <= 0) {
      halted = 'detail budget reached';
      break;
    }

    try {
      const listing = await request(context, budget, page =>
        context.scraper.detailOn(page, ad.url)
      );
      store.saveDetail(listing, new Date().toISOString());
      fetched += 1;
      budget.details -= 1;

      if (fetched % 10 === 0) {
        log(`read ${fetched}/${pending.length} (${context.governor.stats.currentRpm} rpm)`);
        await context.session.saveState();
      }
    } catch (error) {
      if (error instanceof CollectionHalted) {
        halted = (error as Error).message;
        break;
      }
      failed += 1;
      // A removed ad is the common case here and is not worth a line each.
      if (failed <= 5) log(`could not read ${ad.url}: ${(error as Error).message}`);
    }
  }

  return { fetched, failed, halted };
};
