import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.js';
import { ProfileSchema } from '../config/profile.js';
import { Listing, ListingId } from '../core/types.js';

const profile = ProfileSchema.parse({ name: 'test', query: 's22 ultra' });

const listing = (id: string, price: string | undefined, title = `Ad ${id}`): Listing => ({
  id: id as ListingId,
  title,
  url: `https://sp.olx.com.br/celulares/ad-${id}`,
  ...(price === undefined ? {} : { price }),
  location: 'Porto Alegre, RS',
  imageUrl: 'https://img.olx.com.br/x.webp',
});

describe('Store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'garimpo-'));
    store = new Store(dir);
    store.startRun('run-1', profile, '2026-08-26T00:00:00Z');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts an ad once however many times it is seen', () => {
    const first = store.saveCards(
      'run-1',
      'rs|all||',
      [listing('1', 'R$ 950')],
      '2026-08-26T01:00:00Z'
    );
    const again = store.saveCards(
      'run-1',
      'rs|all||',
      [listing('1', 'R$ 900')],
      '2026-08-26T02:00:00Z'
    );

    expect(first).toBe(1);
    // Seen again in another slice of the same run: not a new ad.
    expect(again).toBe(0);
    expect(store.countRunAds('run-1')).toBe(1);
  });

  it('refreshes an ad price when it is seen again', () => {
    store.saveCards('run-1', 's1', [listing('1', 'R$ 950')], '2026-08-26T01:00:00Z');
    store.saveCards('run-1', 's1', [listing('1', 'R$ 800')], '2026-08-26T02:00:00Z');

    expect(store.runAds('run-1')[0]?.price).toBe(800);
  });

  it('keeps a known price rather than letting a later blank overwrite it', () => {
    store.saveCards('run-1', 's1', [listing('1', 'R$ 950')], '2026-08-26T01:00:00Z');
    store.saveCards('run-1', 's1', [listing('1', undefined)], '2026-08-26T02:00:00Z');

    expect(store.runAds('run-1')[0]?.price).toBe(950);
  });

  it('parses Brazilian prices on the way in, so aggregates are arithmetic', () => {
    store.saveCards(
      'run-1',
      's1',
      [listing('1', 'R$ 1.250'), listing('2', 'R$ 6.999'), listing('3', undefined)],
      '2026-08-26T01:00:00Z'
    );

    const stats = store.priceStats('run-1');
    expect(stats['n']).toBe(2);
    expect(stats['min']).toBe(1250);
    expect(stats['max']).toBe(6999);
  });

  it('remembers how far a shard got, which is what makes a run resumable', () => {
    store.saveShards('run-1', [
      { key: 'sp|all||', totalCount: 4000, truncated: false, depth: 1, state: 'sp' },
      { key: 'rs|all||', totalCount: 300, truncated: false, depth: 1, state: 'rs' },
    ]);

    store.updateShard('run-1', 'sp|all||', { status: 'running', pagesDone: 40, cardsSeen: 2000 });
    expect(store.pendingShards('run-1').find(s => s.key === 'sp|all||')?.pages_done).toBe(40);

    store.updateShard('run-1', 'sp|all||', { status: 'done' });
    expect(store.pendingShards('run-1').map(s => s.key)).toEqual(['rs|all||']);
  });

  it('exposes a shard running tally, so a resumed sweep continues it', () => {
    store.saveShards('run-1', [{ key: 'k', totalCount: 300, truncated: false, depth: 0 }]);
    store.updateShard('run-1', 'k', { pagesDone: 1, cardsSeen: 50 });

    // The planner's page is already counted; a resumed collect must add to this
    // rather than restart from zero, or the summary undercounts what is on disk.
    expect(store.pendingShards('run-1')[0]).toMatchObject({ pages_done: 1, cards_seen: 50 });
  });

  it('preserves progress when only the status is patched', () => {
    store.saveShards('run-1', [{ key: 'k', totalCount: 10, truncated: false, depth: 0 }]);
    store.updateShard('run-1', 'k', { pagesDone: 7, cardsSeen: 350 });
    store.updateShard('run-1', 'k', { status: 'running' });

    expect(store.pendingShards('run-1')[0]?.pages_done).toBe(7);
  });

  it('offers only card-passing, unfetched ads for enrichment, cheapest first', () => {
    store.saveCards(
      'run-1',
      's1',
      [listing('cheap', 'R$ 900'), listing('mid', 'R$ 1.500'), listing('nope', 'R$ 100')],
      '2026-08-26T01:00:00Z'
    );
    store.saveVerdicts('run-1', 'card', [
      { adId: 'cheap', passed: true, stages: [{ id: 'price-range', passed: true }] },
      { adId: 'mid', passed: true, stages: [{ id: 'price-range', passed: true }] },
      {
        adId: 'nope',
        passed: false,
        failedStage: 'price-range',
        reason: 'below R$ 800',
        stages: [{ id: 'price-range', passed: false, reason: 'below R$ 800' }],
      },
    ]);

    expect(store.adsAwaitingDetail('run-1', 10).map(ad => ad.id)).toEqual(['cheap', 'mid']);

    store.saveDetail(
      { ...listing('cheap', 'R$ 900'), description: 'tudo ok' },
      '2026-08-26T03:00:00Z'
    );
    expect(store.adsAwaitingDetail('run-1', 10).map(ad => ad.id)).toEqual(['mid']);
  });

  it('reports where ads were lost, per stage', () => {
    store.saveCards('run-1', 's1', [listing('a', 'R$ 900'), listing('b', 'R$ 100')], 'now');
    store.saveVerdicts('run-1', 'card', [
      { adId: 'a', passed: true, stages: [{ id: 'title-match', passed: true }] },
      {
        adId: 'b',
        passed: false,
        failedStage: 'title-match',
        reason: 'title lacks ultra',
        stages: [{ id: 'title-match', passed: false, reason: 'title lacks ultra' }],
      },
    ]);

    expect(store.funnel('run-1')).toEqual([{ stage: 'title-match', passed: 1, failed: 1 }]);
    expect(store.rejectionReasons('run-1', 'card', 5)[0]).toMatchObject({
      stage: 'title-match',
      reason: 'title lacks ultra',
      n: 1,
    });
  });

  it('re-running triage overwrites the previous verdict instead of doubling it', () => {
    store.saveCards('run-1', 's1', [listing('a', 'R$ 900')], 'now');
    const reject = {
      adId: 'a',
      passed: false,
      failedStage: 'defects',
      reason: 'major',
      stages: [{ id: 'defects', passed: false, reason: 'major' }],
    };
    store.saveVerdicts('run-1', 'card', [reject]);
    store.saveVerdicts('run-1', 'card', [
      { adId: 'a', passed: true, stages: [{ id: 'defects', passed: true }] },
    ]);

    expect(store.funnel('run-1')).toEqual([{ stage: 'defects', passed: 1, failed: 0 }]);
  });

  it('keeps an ad across runs but scopes the sighting to each one', () => {
    store.startRun('run-2', profile, '2026-08-27T00:00:00Z');
    store.saveCards('run-1', 's1', [listing('shared', 'R$ 900')], 'now');
    store.saveCards('run-2', 's1', [listing('shared', 'R$ 850')], 'later');

    expect(store.countRunAds('run-1')).toBe(1);
    expect(store.countRunAds('run-2')).toBe(1);
    expect(store.runAds('run-2')[0]?.price).toBe(850);
  });

  it('keeps every ad and ranks them, rather than dropping poor matches', () => {
    store.saveCards(
      'run-1',
      's1',
      [
        listing('exact', 'R$ 4.300', 'REDMAGIC 10 PRO'),
        listing('vague', 'R$ 2.700', 'Celular Redmagic'),
        listing('other', 'R$ 250', 'Capa para Redmagic'),
      ],
      'now',
      new Map([
        ['exact', { score: 100, detail: { exactPhrase: true } }],
        ['vague', { score: 70, detail: { exactPhrase: false } }],
        ['other', { score: 21, detail: { demotedBy: ['capa'] } }],
      ])
    );

    // Nothing was discarded: the vague title, which is the kind that hides a
    // bargain because nobody finds it, is still in the corpus.
    expect(store.countRunAds('run-1')).toBe(3);
    expect(store.candidates('run-1', { minMatchScore: 70 }).map(row => row['id'])).toEqual([
      'exact',
      'vague',
    ]);
    expect(store.candidates('run-1', { minMatchScore: 0 })).toHaveLength(3);
  });

  it('keeps the best score when several phrasings find the same ad', () => {
    store.saveCards(
      'run-1',
      'q1',
      [listing('a', 'R$ 100')],
      'now',
      new Map([['a', { score: 45, detail: {} }]])
    );
    store.saveCards(
      'run-1',
      'q2',
      [listing('a', 'R$ 100')],
      'now',
      new Map([['a', { score: 92, detail: {} }]])
    );
    expect(store.candidates('run-1')[0]?.['match_score']).toBe(92);

    // And a worse later score does not overwrite the better one.
    store.saveCards(
      'run-1',
      'q3',
      [listing('a', 'R$ 100')],
      'now',
      new Map([['a', { score: 30, detail: {} }]])
    );
    expect(store.candidates('run-1')[0]?.['match_score']).toBe(92);
  });

  it('buckets the corpus by match score, which is how you see if a filter ate it', () => {
    store.saveCards(
      'run-1',
      's1',
      [listing('a', 'R$ 10'), listing('b', 'R$ 20'), listing('c', 'R$ 30')],
      'now',
      new Map([
        ['a', { score: 95, detail: {} }],
        ['b', { score: 72, detail: {} }],
        ['c', { score: 5, detail: {} }],
      ])
    );

    const bands = Object.fromEntries(store.matchHistogram('run-1').map(b => [b.band, b.n]));
    expect(bands).toMatchObject({ '90-100': 1, '70-89': 1, '0-24': 1 });
  });

  it('samples which candidates to read, and honours the match floor', () => {
    store.saveCards(
      'run-1',
      's1',
      [listing('best', 'R$ 5.000'), listing('cheap', 'R$ 900'), listing('weak', 'R$ 100')],
      'now',
      new Map([
        ['best', { score: 100, detail: {} }],
        ['cheap', { score: 80, detail: {} }],
        ['weak', { score: 10, detail: {} }],
      ])
    );
    store.saveVerdicts(
      'run-1',
      'card',
      ['best', 'cheap', 'weak'].map(adId => ({
        adId,
        passed: true,
        stages: [{ id: 'for-sale', passed: true }],
      }))
    );

    const byMatch = store.adsAwaitingDetail('run-1', 10, undefined, {
      minMatchScore: 50,
      sampleBy: 'match',
    });
    expect(byMatch.map(ad => ad.id)).toEqual(['best', 'cheap']);

    const byPrice = store.adsAwaitingDetail('run-1', 10, undefined, {
      minMatchScore: 50,
      sampleBy: 'price',
    });
    expect(byPrice.map(ad => ad.id)).toEqual(['cheap', 'best']);

    // The floor keeps the weak match out of an expensive read without deleting it.
    expect(byMatch.map(ad => ad.id)).not.toContain('weak');
    expect(store.candidates('run-1', { minMatchScore: 0 })).toHaveLength(3);
  });

  it('caps the sample, so a corpus of thousands can be read in hundreds', () => {
    const many = Array.from({ length: 40 }, (_, i) => listing(`ad-${i}`, `R$ ${100 + i}`));
    store.saveCards(
      'run-1',
      's1',
      many,
      'now',
      new Map(many.map((ad, i) => [ad.id as string, { score: 100 - i, detail: {} }]))
    );
    store.saveVerdicts(
      'run-1',
      'card',
      many.map(ad => ({ adId: ad.id as string, passed: true, stages: [] }))
    );

    expect(store.adsAwaitingDetail('run-1', 5, undefined, { sampleBy: 'match' })).toHaveLength(5);
  });

  it('ranks stored gems by score and leaves rejected ones out of the report', () => {
    store.saveCards('run-1', 's1', [listing('gem', 'R$ 900'), listing('meh', 'R$ 2.400')], 'now');
    store.saveGems('run-1', [
      {
        adId: 'gem',
        score: 0.82,
        discountPct: 0.62,
        robustZ: 3.1,
        median: 2400,
        referenceSize: 20,
        verdict: 'gem',
        reasons: ['62% below median'],
      },
      {
        adId: 'meh',
        score: 0.1,
        discountPct: 0,
        robustZ: 0,
        median: 2400,
        referenceSize: 20,
        verdict: 'rejected',
        reasons: ['ordinary price'],
      },
    ]);

    const top = store.topGems('run-1', 10);
    expect(top).toHaveLength(1);
    expect(top[0]?.['id']).toBe('gem');
  });

  it('survives being reopened, which is the whole point of writing to disk', () => {
    store.saveCards('run-1', 's1', [listing('1', 'R$ 950')], 'now');
    store.close();

    const reopened = new Store(dir);
    expect(reopened.countRunAds('run-1')).toBe(1);
    expect(reopened.latestRunId()).toBe('run-1');
    reopened.close();
    store = new Store(dir);
  });
});
