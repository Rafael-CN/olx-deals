import { SellerInfo } from '../core/types.js';
import { SellerGate } from '../config/profile.js';

/**
 * Which seller fields a gate has to be able to see.
 *
 * This matters to cost, not just correctness. The ad's HTML carries the sales
 * record and the verification badges, but not the join date, the name or the
 * rating — those only appear once the seller card hydrates, which means a full
 * page load. So a gate built on cancellation rate and verification is free, and
 * one built on account age or rating costs a browser page per ad.
 *
 * The enricher reads this to decide, per ad, whether the cheap read was enough.
 */
export const requiredSellerFields = (gate: SellerGate): Array<keyof SellerInfo> => {
  const needed = new Set<keyof SellerInfo>();

  if (gate.minRating !== undefined) needed.add('rating');
  if (gate.minReviewCount !== undefined) needed.add('reviewCount');
  if (gate.minSalesCompleted !== undefined) needed.add('salesCompleted');
  if (gate.maxCancelRate !== undefined) {
    needed.add('salesCompleted');
    needed.add('salesCancelled');
  }
  if (gate.minAccountAgeMonths !== undefined) needed.add('memberSince');
  if (gate.maxDispatchDays !== undefined) needed.add('dispatchDays');
  if (gate.requireVerified) needed.add('verified');
  if (gate.requireChannels.length > 0) needed.add('verifiedChannels');

  return [...needed];
};

/** Fields that never survive an HTML-only read, so wanting them implies a page load. */
export const SELLER_FIELDS_NEEDING_HYDRATION: ReadonlyArray<keyof SellerInfo> = [
  'name',
  'memberSince',
  'rating',
  'reviewCount',
  'online',
];

export interface SellerAssessment {
  readonly passed: boolean;
  readonly reason?: string | undefined;
  /** 0-1 confidence that this is someone worth buying from. */
  readonly score: number;
  /** True when the card yielded nothing to judge. */
  readonly unknown: boolean;
}

const monthsBetween = (from: Date, to: Date): number =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

/** cancelled / (cancelled + completed), or undefined when neither is known. */
export const cancelRate = (seller: SellerInfo | undefined): number | undefined => {
  const completed = seller?.salesCompleted;
  const cancelled = seller?.salesCancelled;
  if (completed === undefined || cancelled === undefined) return undefined;
  const total = completed + cancelled;
  return total === 0 ? undefined : cancelled / total;
};

/**
 * Judges a seller against the gate, and separately scores them.
 *
 * The two are not the same job. The gate is a yes/no a buyer set deliberately;
 * the score orders the survivors. A seller with no history at all is not
 * evidence of a bad seller, so `onUnknown` is the caller's call rather than a
 * silent default — for a cheap phone "pass" is reasonable, for a R$ 8.000 one it
 * is not.
 */
export const assessSeller = (
  seller: SellerInfo | undefined,
  gate: SellerGate,
  now: Date = new Date()
): SellerAssessment => {
  const known =
    seller !== undefined &&
    (seller.rating !== undefined ||
      seller.salesCompleted !== undefined ||
      seller.memberSince !== undefined ||
      seller.verified !== undefined);

  if (!known) {
    return {
      passed: gate.onUnknown === 'pass',
      reason: gate.onUnknown === 'pass' ? undefined : 'no seller information on the page',
      score: 0.35,
      unknown: true,
    };
  }

  const fail = (reason: string): SellerAssessment => ({
    passed: false,
    reason,
    score: 0,
    unknown: false,
  });

  const ageMonths = seller.memberSince ? monthsBetween(seller.memberSince, now) : undefined;
  const cancels = cancelRate(seller);

  if (gate.requireVerified && seller.verified !== true) {
    return fail('seller has no verified information');
  }
  if (gate.minRating !== undefined && (seller.rating ?? -1) < gate.minRating) {
    return fail(`rating ${seller.rating ?? 'unknown'} below ${gate.minRating}`);
  }
  if (gate.minReviewCount !== undefined && (seller.reviewCount ?? 0) < gate.minReviewCount) {
    return fail(`${seller.reviewCount ?? 0} reviews, needs ${gate.minReviewCount}`);
  }
  if (
    gate.minSalesCompleted !== undefined &&
    (seller.salesCompleted ?? 0) < gate.minSalesCompleted
  ) {
    return fail(`${seller.salesCompleted ?? 0} completed sales, needs ${gate.minSalesCompleted}`);
  }
  if (gate.maxCancelRate !== undefined && cancels !== undefined && cancels > gate.maxCancelRate) {
    return fail(
      `cancels ${(cancels * 100).toFixed(0)}% of sales ` +
        `(${seller.salesCancelled}/${(seller.salesCancelled ?? 0) + (seller.salesCompleted ?? 0)})`
    );
  }
  if (gate.minAccountAgeMonths !== undefined && (ageMonths ?? 0) < gate.minAccountAgeMonths) {
    return fail(`account is ${ageMonths ?? 0} months old, needs ${gate.minAccountAgeMonths}`);
  }
  if (gate.maxDispatchDays !== undefined && (seller.dispatchDays ?? 0) > gate.maxDispatchDays) {
    return fail(`dispatches in ${seller.dispatchDays} days, limit ${gate.maxDispatchDays}`);
  }
  if (gate.requireChannels.length > 0) {
    const have = new Set((seller.verifiedChannels ?? []).map(channel => channel.toLowerCase()));
    const missing = gate.requireChannels.filter(channel => !have.has(channel.toLowerCase()));
    if (missing.length > 0) return fail(`unverified channels: ${missing.join(', ')}`);
  }

  return { passed: true, score: scoreSeller(seller, now), unknown: false };
};

/**
 * A 0-1 reading of seller trust, built from what OLX actually shows.
 *
 * Weighted towards the cancellation record because it is the signal a buyer feels
 * directly: a five-star seller who cancels half their sales wastes your time in a
 * way their rating never mentions. Account age is capped at two years — beyond
 * that it stops discriminating.
 */
export const scoreSeller = (seller: SellerInfo | undefined, now: Date = new Date()): number => {
  if (!seller) return 0.35;

  const parts: Array<{ weight: number; value: number }> = [];

  if (seller.rating !== undefined) {
    parts.push({ weight: 0.3, value: Math.min(seller.rating / 5, 1) });
  }
  const cancels = cancelRate(seller);
  if (cancels !== undefined) {
    parts.push({ weight: 0.35, value: 1 - cancels });
  }
  if (seller.salesCompleted !== undefined) {
    // Diminishing returns: the step from 0 to 5 sales says far more than 50 to 55.
    parts.push({ weight: 0.15, value: Math.min(Math.log10(seller.salesCompleted + 1) / 1.5, 1) });
  }
  if (seller.memberSince) {
    parts.push({ weight: 0.1, value: Math.min(monthsBetween(seller.memberSince, now) / 24, 1) });
  }
  if (seller.verified !== undefined) {
    parts.push({ weight: 0.1, value: seller.verified ? 1 : 0 });
  }

  if (parts.length === 0) return 0.35;

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  return parts.reduce((sum, part) => sum + part.weight * part.value, 0) / totalWeight;
};
