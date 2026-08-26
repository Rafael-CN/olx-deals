import { describe, it, expect } from 'vitest';
import { assessGem, buildReference, rankGems } from './gems.js';
import { GemConfigSchema } from '../config/profile.js';
import { Candidate } from './stages.js';

const config = GemConfigSchema.parse({ enabled: true, minReferenceSize: 5 });
const now = new Date('2026-08-26T12:00:00Z');

const ad = (overrides: Partial<Candidate> & { id: string; price: number }): Candidate => ({
  title: 'Galaxy S22 Ultra 256GB',
  url: `https://sp.olx.com.br/celulares/x-${overrides.id}`,
  enriched: true,
  publishedAt: new Date('2026-08-24T12:00:00Z'),
  ...overrides,
});

/** A tight cluster around 2.500 plus the junk a real result page carries. */
const marketPrices = [2300, 2400, 2450, 2500, 2500, 2550, 2600, 2700, 2800];

describe('buildReference', () => {
  it('is not moved by placeholder listings the way a mean would be', () => {
    const clean = buildReference(marketPrices);
    const salted = buildReference([...marketPrices, 1, 1, 1, 99999]);

    expect(clean.median).toBe(2500);
    // A mean over the salted set lands near 8.000; the median barely notices.
    expect(salted.median).toBeCloseTo(2500, 0);
  });

  it('reports the spread with MAD rather than a standard deviation', () => {
    const reference = buildReference(marketPrices);
    expect(reference.mad).toBeGreaterThan(0);
    expect(reference.mad).toBeLessThan(200);
    expect(reference.size).toBe(9);
  });

  it('survives an empty set without producing a bogus median', () => {
    expect(buildReference([]).median).toBe(0);
    expect(buildReference([]).size).toBe(0);
  });
});

describe('assessGem', () => {
  const reference = buildReference(marketPrices);

  it('calls a deep discount on a clean unit from a good seller a gem', () => {
    const assessment = assessGem(
      ad({
        id: 'gem',
        price: 1500,
        seller: {
          rating: 5,
          reviewCount: 12,
          salesCompleted: 20,
          salesCancelled: 0,
          verified: true,
          memberSince: new Date('2021-01-01'),
        },
      }),
      reference,
      config,
      'none',
      now
    );

    expect(assessment.verdict).toBe('gem');
    expect(assessment.discountPct).toBeCloseTo(0.4, 2);
    expect(assessment.score).toBeGreaterThan(config.alertScore);
    expect(assessment.reasons.join(' ')).toContain('median');
  });

  it('flags an implausible price as suspect, not as the best find of the run', () => {
    // A tenth of the going rate is a scam, a typo, a deposit or an accessory.
    const assessment = assessGem(ad({ id: 'scam', price: 250 }), reference, config, 'none', now);

    expect(assessment.verdict).toBe('suspect');
    expect(assessment.score).toBe(0);
    expect(assessment.reasons.join(' ')).toMatch(/too far under/);
  });

  it('will not let a discount buy its way past a broken unit', () => {
    const cheapAndBroken = assessGem(
      ad({ id: 'broken', price: 1400 }),
      reference,
      config,
      'broken',
      now
    );
    const cheapAndClean = assessGem(
      ad({ id: 'clean', price: 1400 }),
      reference,
      config,
      'none',
      now
    );

    expect(cheapAndBroken.score).toBeLessThan(cheapAndClean.score);
    expect(cheapAndBroken.verdict).not.toBe('gem');
  });

  it('refuses to judge anything from too few comparables', () => {
    const thin = buildReference([2500, 2600]);
    const assessment = assessGem(ad({ id: 'x', price: 900 }), thin, config, 'none', now);

    expect(assessment.verdict).toBe('rejected');
    expect(assessment.reasons.join(' ')).toMatch(/comparable ads/);
  });

  it('rejects an ordinary price rather than calling it a bargain', () => {
    const assessment = assessGem(ad({ id: 'meh', price: 2450 }), reference, config, 'none', now);
    expect(assessment.verdict).toBe('rejected');
    expect(assessment.discountPct).toBeLessThan(config.minDiscountPct);
  });

  it('prefers a fresh listing to a stale one at the same price', () => {
    const seller = { salesCompleted: 10, salesCancelled: 0, verified: true };
    const fresh = assessGem(
      ad({ id: 'fresh', price: 1500, seller, publishedAt: new Date('2026-08-25T12:00:00Z') }),
      reference,
      config,
      'none',
      now
    );
    const stale = assessGem(
      ad({ id: 'stale', price: 1500, seller, publishedAt: new Date('2026-05-01T12:00:00Z') }),
      reference,
      config,
      'none',
      now
    );

    expect(fresh.score).toBeGreaterThan(stale.score);
  });
});

describe('rankGems', () => {
  it('builds the reference from clean ads only, so damage cannot lower the bar', () => {
    const entries = [
      ...marketPrices.map((price, index) => ({
        candidate: ad({ id: `clean-${index}`, price }),
        severity: 'none' as const,
        clean: true,
      })),
      // Six wrecks at a fifth of the price: including them would drag the median
      // down and make a real bargain look like an ordinary listing.
      ...[400, 450, 500, 520, 540, 560].map((price, index) => ({
        candidate: ad({ id: `broken-${index}`, price }),
        severity: 'broken' as const,
        clean: false,
      })),
    ];

    const clean = rankGems(entries, config, now);
    const all = rankGems(entries, { ...config, reference: 'all' }, now);

    expect(clean.reference.median).toBe(2500);
    expect(all.reference.median).toBeLessThan(clean.reference.median);
  });

  it('ranks by score and puts the best find first', () => {
    const entries = [
      ...marketPrices.map((price, index) => ({
        candidate: ad({ id: `c-${index}`, price }),
        severity: 'none' as const,
        clean: true,
      })),
      {
        candidate: ad({
          id: 'bargain',
          price: 1450,
          seller: { salesCompleted: 30, salesCancelled: 0, verified: true, rating: 5 },
        }),
        severity: 'none' as const,
        clean: true,
      },
    ];

    const { assessments } = rankGems(entries, config, now);
    expect(assessments[0]?.adId).toBe('bargain');
  });
});
