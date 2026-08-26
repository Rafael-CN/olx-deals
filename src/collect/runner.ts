import { Page } from 'playwright';
import { CategoryId, Listing, LocationId, SearchFilters, SellerInfo } from '../core/types.js';
import { Limits, Profile } from '../config/profile.js';
import { OLXBRScraper } from '../scrapers/olx/olx-br.scraper.js';
import { Store } from '../store/db.js';
import { BrowserSession } from './session.js';
import { CollectionHalted, RateGovernor, isBlockError } from './governor.js';
import { FetchOutcome, HtmlFetcher, RequestMeter, looksBlocked } from './fetcher.js';
import { BlockMemory } from './cooldown.js';
import { Shard, shardKey } from './shard.js';

/** Ads per search page on olx.com.br. */
const PAGE_SIZE = 50;

export interface RunnerContext {
  readonly scraper: OLXBRScraper;
  readonly session: BrowserSession;
  readonly governor: RateGovernor;
  readonly fetcher: HtmlFetcher;
  readonly meter: RequestMeter;
  readonly blockMemory: BlockMemory;
  readonly store: Store;
  readonly profile: Profile;
  /**
   * The seller fields the profile's gates have to be able to read.
   *
   * Empty means no ad ever justifies a full page load and the run costs one
   * request per ad. Otherwise an ad is upgraded only when the cheap read came back
   * missing one of these — so which gates you set decides what the sweep costs.
   */
  readonly neededSellerFields: ReadonlyArray<keyof SellerInfo>;
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

const spend = (context: RunnerContext, budget: Budget): void => {
  if (budget.requests <= 0) throw new CollectionHalted('request budget exhausted');
  if (Date.now() > budget.deadline) throw new CollectionHalted('run time limit reached');
  void context;
};

const noteBlock = (context: RunnerContext, retryAfterSeconds?: number): never | void => {
  context.blockMemory.recordBlock();
  context.log(
    `olx.com.br refused the request — backing off to ${context.governor.stats.currentRpm} rpm`
  );
  // Throws CollectionHalted once the site has refused repeatedly.
  context.governor.reportBlocked(retryAfterSeconds);
};

/**
 * One governed HTTP request for a page's HTML.
 *
 * This is the cheap path and the default one. A browser navigation to an OLX page
 * is not a request, it is dozens — the document, then chunks, then analytics,
 * then the page's own API calls, many of them to olx.com.br. Fetching the
 * document alone is a single hit, and the document already contains the cards and
 * the ad's structured data.
 */
const fetchHtml = async (
  context: RunnerContext,
  budget: Budget,
  url: string
): Promise<FetchOutcome> => {
  spend(context, budget);
  await context.governor.acquire();
  budget.requests -= 1;

  let outcome: FetchOutcome;
  try {
    outcome = await context.fetcher.get(url);
  } catch (error) {
    context.governor.reportError();
    throw error;
  }

  if (looksBlocked(outcome)) {
    noteBlock(context, outcome.retryAfterSeconds);
    throw new Error(
      `olx.com.br answered ${outcome.status} for ${url} — blocked or rate-limited, not answered ` +
        `with an empty result set.`
    );
  }

  if (outcome.status >= 400) {
    context.governor.reportError();
    throw new Error(`olx.com.br answered ${outcome.status} for ${url}`);
  }

  context.governor.reportSuccess();
  return outcome;
};

/**
 * A governed full page load, with JavaScript. Reserved for the one thing the
 * HTML does not carry — the seller card, which hydrates on the client — so it is
 * spent per ad and only when a stage will actually read it.
 */
const loadPage = async <T>(
  context: RunnerContext,
  budget: Budget,
  work: (page: Page) => Promise<T>
): Promise<T> => {
  spend(context, budget);
  await context.governor.acquire();

  // Charged by measurement, not by guess. A hydrated olx.com.br ad page was
  // observed to make about sixty requests to the site — the document, the Next.js
  // chunks, analytics, ad slots and the page's own API calls. An earlier version
  // of this charged ten, which is why a run that believed it had budget left kept
  // going until the site said no.
  const before = context.meter.total;
  try {
    const result = await context.session.withPage(work);
    context.governor.reportSuccess();
    return result;
  } catch (error) {
    if (isBlockError(error)) noteBlock(context);
    else context.governor.reportError();
    throw error;
  } finally {
    const spent = Math.max(1, context.meter.total - before);
    budget.requests -= spent;
  }
};

/**
 * Reads a slice's result count, and keeps the page it had to fetch to find out.
 *
 * The count lives in the same document as the first fifty cards, so throwing
 * those away and re-fetching the identical page during collection was one wasted
 * request per surviving slice — 27 of them on a nationwide plan, and a doubling
 * of the cost for every slice that fits in a single page. `harvest` collects them
 * so the caller can hand them straight to the store.
 */
export const makeProbe =
  (context: RunnerContext, budget: Budget, harvest?: Map<string, ProbedPage>) =>
  async (shard: Shard): Promise<number> => {
    const filters = filtersFor(context.profile, shard, 1);
    const url = context.scraper.searchUrlFor(filters);
    try {
      const outcome = await fetchHtml(context, budget, url);
      const result = await context.fetcher.parse(outcome, page =>
        context.scraper.readSearchPage(page, filters)
      );
      harvest?.set(shardKey(shard), {
        listings: result.listings,
        hasNextPage: result.hasNextPage,
      });
      return result.totalCount;
    } catch (error) {
      if (error instanceof CollectionHalted) throw error;
      context.log(`probe failed for ${shardKey(shard)}: ${(error as Error).message}`);
      return 0;
    }
  };

export interface ProbedPage {
  readonly listings: Awaited<ReturnType<OLXBRScraper['readSearchPage']>>['listings'];
  readonly hasNextPage: boolean;
}

/**
 * Writes the pages the planner already fetched, marking those slices as one page
 * in so collection starts at page two.
 */
export const flushProbedPages = (
  context: RunnerContext,
  runId: string,
  harvest: Map<string, ProbedPage>
): { pages: number; newAds: number } => {
  let pages = 0;
  let newAds = 0;
  const seenAt = new Date().toISOString();

  for (const shard of context.store.pendingShards(runId)) {
    const probed = harvest.get(shard.key);
    if (!probed || probed.listings.length === 0) continue;

    newAds += context.store.saveCards(runId, shard.key, probed.listings, seenAt);
    context.store.updateShard(runId, shard.key, {
      pagesDone: 1,
      cardsSeen: probed.listings.length,
      status: probed.hasNextPage ? 'pending' : 'done',
    });
    pages += 1;
  }

  return { pages, newAds };
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
    // Continues the shard's tally rather than restarting it: the planner's page
    // and any pages a previous attempt got through are already counted, and
    // zeroing here made the summary report less than the store actually holds.
    let shardCards = shard.cards_seen;

    try {
      for (let pageNumber = pagesDone + 1; pageNumber <= lastPage; pageNumber += 1) {
        if (budget.cards <= 0) {
          halted = 'card budget reached';
          break;
        }

        const filters = filtersFor(profile, slice, pageNumber);
        const outcome = await fetchHtml(context, budget, context.scraper.searchUrlFor(filters));
        const result = await context.fetcher.parse(outcome, page =>
          context.scraper.readSearchPage(page, filters)
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
  readonly upgraded: number;
  readonly halted?: string | undefined;
}

/**
 * Reads the ad pages of everything that survived card-level triage.
 *
 * Two tiers. Every ad is fetched as HTML — one request — which yields the
 * description, the attributes, the price and the images. Only if a stage needs
 * the seller card, and only if the HTML did not somehow contain it, does that ad
 * get a full page load. So a profile with no seller gate never pays for
 * JavaScript at all, and one with a gate pays for it once per surviving ad rather
 * than once per collected ad.
 *
 * Ordered cheapest first, because when the budget runs out mid-list the ads worth
 * having read are the ones a bargain hunt is about.
 */
export const enrich = async (
  context: RunnerContext,
  runId: string,
  budget: Budget
): Promise<EnrichOutcome> => {
  const { store, log } = context;
  let fetched = 0;
  let failed = 0;
  let upgraded = 0;
  let halted: string | undefined;

  const pending = store.adsAwaitingDetail(
    runId,
    Math.min(budget.details, 5000),
    context.profile.limits.refreshDetailAfterDays
  );
  const needed = context.neededSellerFields;
  log(
    `${pending.length} ad page(s) to read` +
      (needed.length > 0
        ? ` (gates need seller ${needed.join(', ')}; ads missing any of those get a full load)`
        : ' (no seller gate, so one request each)')
  );

  for (const ad of pending) {
    if (budget.details <= 0) {
      halted = 'detail budget reached';
      break;
    }

    try {
      const outcome = await fetchHtml(context, budget, ad.url);
      let listing: Listing = await context.fetcher.parse(outcome, page =>
        context.scraper.readListingPage(page, ad.url, { hydrated: false })
      );

      // The HTML carries the sales record and the badges but never the join date,
      // the name or the rating. So the question is not "did we get a seller" but
      // "did we get the fields this profile's gates will read".
      const missing = needed.filter(field => listing.seller?.[field] === undefined);
      if (missing.length > 0) {
        listing = await loadPage(context, budget, page => context.scraper.detailOn(page, ad.url));
        upgraded += 1;
      }

      store.saveDetail(listing, new Date().toISOString());
      fetched += 1;
      budget.details -= 1;

      if (fetched % 10 === 0) {
        log(
          `read ${fetched}/${pending.length} (${context.governor.stats.currentRpm} rpm, ` +
            `${upgraded} needed a full load)`
        );
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

  return { fetched, failed, upgraded, halted };
};
