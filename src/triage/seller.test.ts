import { describe, it, expect } from 'vitest';
import { assessSeller, cancelRate, requiredSellerFields, scoreSeller } from './seller.js';
import { SellerGateSchema } from '../config/profile.js';
import { SellerInfo } from '../core/types.js';

const gate = (overrides: Record<string, unknown> = {}) => SellerGateSchema.parse(overrides);
const now = new Date('2026-08-26T12:00:00Z');

/**
 * What an HTML-only read of an ad page yields: the sales record and the badges,
 * but no join date, name or rating — those need the page to hydrate.
 */
const fromHtml: SellerInfo = {
  verified: true,
  salesCompleted: 4,
  salesCancelled: 1,
  verifiedChannels: ['E-mail', 'Telefone'],
};

const hydrated: SellerInfo = {
  ...fromHtml,
  name: 'Marcio Pereira',
  memberSince: new Date('2015-04-01T00:00:00Z'),
  rating: 5,
  reviewCount: 0,
  online: false,
};

describe('requiredSellerFields', () => {
  it('asks for nothing when the gate bounds nothing', () => {
    expect(requiredSellerFields(gate())).toEqual([]);
  });

  it('needs only fields the HTML already carries for a cancellation gate', () => {
    const fields = requiredSellerFields(gate({ maxCancelRate: 0.3, requireVerified: true }));
    expect(fields.sort()).toEqual(['salesCancelled', 'salesCompleted', 'verified']);
    // None of those need hydration, so such a gate costs one request per ad.
    expect(fields).not.toContain('memberSince');
    expect(fields).not.toContain('rating');
  });

  it('needs the join date for an account-age gate, which only hydration provides', () => {
    expect(requiredSellerFields(gate({ minAccountAgeMonths: 3 }))).toContain('memberSince');
  });

  it('needs the rating for a rating gate', () => {
    expect(requiredSellerFields(gate({ minRating: 4 }))).toContain('rating');
  });

  it('needs the channel list only when channels are demanded', () => {
    expect(requiredSellerFields(gate({ requireChannels: ['Telefone'] }))).toContain(
      'verifiedChannels'
    );
    expect(requiredSellerFields(gate())).not.toContain('verifiedChannels');
  });
});

describe('assessSeller', () => {
  it('passes a cancellation gate on HTML-only data', () => {
    expect(assessSeller(fromHtml, gate({ maxCancelRate: 0.3 }), now).passed).toBe(true);
    expect(assessSeller(fromHtml, gate({ maxCancelRate: 0.1 }), now).passed).toBe(false);
  });

  it('would silently reject everyone on HTML-only data if account age is gated', () => {
    // This is exactly why the enricher upgrades an ad rather than judging it on a
    // partial read: the join date is absent, not zero.
    expect(assessSeller(fromHtml, gate({ minAccountAgeMonths: 3 }), now).passed).toBe(false);
    expect(assessSeller(hydrated, gate({ minAccountAgeMonths: 3 }), now).passed).toBe(true);
  });

  it('lets the caller decide what an empty seller card means', () => {
    expect(assessSeller(undefined, gate({ onUnknown: 'pass' }), now).passed).toBe(true);
    expect(assessSeller(undefined, gate({ onUnknown: 'fail' }), now).passed).toBe(false);
  });

  it('explains the rejection in the seller own numbers', () => {
    const assessment = assessSeller(
      { salesCompleted: 1, salesCancelled: 4 },
      gate({ maxCancelRate: 0.5 }),
      now
    );
    expect(assessment.passed).toBe(false);
    expect(assessment.reason).toMatch(/cancels 80% of sales/);
  });

  it('holds a verification requirement against an unverified seller', () => {
    expect(
      assessSeller({ verified: false, salesCompleted: 9 }, gate({ requireVerified: true }), now)
        .passed
    ).toBe(false);
  });

  it('checks for the specific channels asked for', () => {
    expect(assessSeller(fromHtml, gate({ requireChannels: ['Facebook'] }), now).reason).toMatch(
      /unverified channels: Facebook/
    );
    expect(assessSeller(fromHtml, gate({ requireChannels: ['Telefone'] }), now).passed).toBe(true);
  });
});

describe('cancelRate', () => {
  it('is the share of sales that fell through', () => {
    expect(cancelRate({ salesCompleted: 3, salesCancelled: 1 })).toBe(0.25);
  });

  it('is unknown rather than zero when there is no history at all', () => {
    expect(cancelRate({ salesCompleted: 0, salesCancelled: 0 })).toBeUndefined();
    expect(cancelRate({ salesCompleted: 5 })).toBeUndefined();
    expect(cancelRate(undefined)).toBeUndefined();
  });
});

describe('scoreSeller', () => {
  it('weighs a clean record above a cancelling one', () => {
    const clean = scoreSeller({ salesCompleted: 10, salesCancelled: 0, verified: true }, now);
    const flaky = scoreSeller({ salesCompleted: 5, salesCancelled: 5, verified: true }, now);
    expect(clean).toBeGreaterThan(flaky);
  });

  it('degrades gracefully on the partial data an HTML-only read gives', () => {
    const partial = scoreSeller(fromHtml, now);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(1);
  });

  it('does not treat an absent seller as a bad one', () => {
    expect(scoreSeller(undefined, now)).toBeGreaterThan(0);
  });
});
