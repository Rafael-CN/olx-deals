import { Limits, Pacing } from '../config/profile.js';
import { PlannedShard } from './shard.js';

const PAGE_SIZE = 50;

export interface CostEstimate {
  readonly cardRequests: number;
  readonly detailRequests: number;
  readonly totalRequests: number;
  readonly reachableAds: number;
  readonly minutesAtStartRate: number;
  readonly minutesAtCeiling: number;
  readonly limitedBy: string | undefined;
}

/**
 * What a plan will cost before any of it is spent.
 *
 * Worth having because the two questions a person actually asks — "how long will
 * this take" and "is this going to get me blocked" — are the same question, and
 * both are answered by the request count. Printing it after planning means a
 * nationwide sweep can be turned down before it starts rather than abandoned an
 * hour in.
 *
 * The card figure is exact: pages are ceil(ads / 50) per slice, capped at what OLX
 * will serve. The detail figure is a ceiling — triage usually rejects most cards
 * before they are ever fetched, so the real number is lower and unknowable in
 * advance.
 */
export const estimateCost = (
  shards: readonly PlannedShard[],
  limits: Limits,
  pacing: Pacing,
  probesAlreadySpent = 0
): CostEstimate => {
  const cap = Math.min(limits.adsPerShardCap, 5000);

  const reachableAds = shards.reduce((sum, shard) => sum + Math.min(shard.totalCount, cap), 0);
  const cappedAds = Math.min(reachableAds, limits.maxCards);

  const pagesPerShard = shards.map(shard =>
    Math.max(1, Math.ceil(Math.min(shard.totalCount, cap) / PAGE_SIZE))
  );
  // The planner already fetched page one of each slice, so those pages are paid for.
  const cardRequests = Math.max(
    0,
    pagesPerShard.reduce((sum, pages) => sum + pages, 0) - shards.length
  );

  const detailRequests = Math.min(limits.maxDetails, cappedAds);
  const totalRequests = Math.min(
    cardRequests + detailRequests + probesAlreadySpent,
    limits.maxRequests
  );

  const minutesAt = (rpm: number) => {
    const requestMinutes = totalRequests / Math.max(rpm, 0.1);
    // Long idle gaps are part of the wall clock, not an aside.
    const pauses =
      pacing.pauseEveryRequests > 0
        ? Math.floor(totalRequests / pacing.pauseEveryRequests) * (pacing.pauseForSeconds / 60)
        : 0;
    return Math.round(requestMinutes + pauses);
  };

  const limitedBy = [
    cardRequests + detailRequests > limits.maxRequests ? '--max-requests' : undefined,
    reachableAds > limits.maxCards ? '--max-cards' : undefined,
    cappedAds > limits.maxDetails ? '--max-details' : undefined,
  ].find(Boolean);

  return {
    cardRequests,
    detailRequests,
    totalRequests,
    reachableAds,
    minutesAtStartRate: minutesAt(pacing.startRequestsPerMinute),
    minutesAtCeiling: minutesAt(pacing.maxRequestsPerMinute),
    limitedBy,
  };
};

export const describeEstimate = (estimate: CostEstimate): string => {
  const range =
    estimate.minutesAtCeiling === estimate.minutesAtStartRate
      ? `${estimate.minutesAtStartRate} min`
      : `${estimate.minutesAtCeiling}–${estimate.minutesAtStartRate} min`;

  return (
    `about ${estimate.totalRequests} request(s) (${estimate.cardRequests} for cards, ` +
    `up to ${estimate.detailRequests} for ad pages) covering ${estimate.reachableAds} ad(s); ` +
    `roughly ${range} at the configured pace` +
    (estimate.limitedBy ? `, capped by ${estimate.limitedBy}` : '')
  );
};
