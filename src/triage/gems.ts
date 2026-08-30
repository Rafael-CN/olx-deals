import { GemConfig } from '../config/profile.js';
import { Candidate } from './stages.js';
import { Severity } from './defects.js';
import { scoreSeller } from './seller.js';
import { CohortLevel, TaxonomyFacts, chooseCohort, describeCohort } from './taxonomy.js';

export interface PriceReference {
  readonly median: number;
  /** Median absolute deviation — the spread measure that ignores outliers. */
  readonly mad: number;
  readonly p25: number;
  readonly p75: number;
  readonly min: number;
  readonly max: number;
  readonly size: number;
}

export type GemVerdict = 'gem' | 'watch' | 'suspect' | 'rejected';

export interface GemAssessment {
  readonly adId: string;
  readonly price: number;
  readonly verdict: GemVerdict;
  readonly score: number;
  readonly discountPct: number;
  readonly robustZ: number;
  readonly reasons: string[];
  /** Which stratum the price was judged against, when cohorts were used. */
  readonly cohortLevel?: CohortLevel | undefined;
  readonly cohortLabel?: string | undefined;
  /** Priced comparables in that stratum — the ones a median could use. */
  readonly cohortSize?: number | undefined;
  /** The median discountPct and robustZ were computed against. */
  readonly referenceMedian?: number | undefined;
}

export const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
};

/**
 * Describes what the product goes for, using median and MAD rather than mean and
 * standard deviation.
 *
 * That is not stylistic. A used-goods listing set is skewed and salted with
 * placeholder prices — R$ 1 "chama no zap" ads sit in the same result page as
 * R$ 6.999 ones. A mean is dragged around by both tails, and a standard
 * deviation computed over them is wide enough to call nothing unusual. The
 * median barely moves, and MAD measures the spread of the ads that actually
 * cluster.
 */
export const buildReference = (prices: readonly number[]): PriceReference => {
  const sorted = [...prices]
    .filter(price => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { median: 0, mad: 0, p25: 0, p75: 0, min: 0, max: 0, size: 0 };
  }

  const median = percentile(sorted, 0.5);
  const deviations = sorted.map(price => Math.abs(price - median)).sort((a, b) => a - b);

  return {
    median,
    mad: percentile(deviations, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    size: sorted.length,
  };
};

const SEVERITY_QUALITY: Record<Severity, number> = {
  none: 1,
  minor: 0.75,
  major: 0.25,
  broken: 0,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Decides whether an ad is a genuine bargain, and says why.
 *
 * The central judgement is that a bargain lives in a *band*. Being below the
 * going rate is the point, but being far enough below it stops meaning "cheap"
 * and starts meaning "not the thing being advertised": a scam, a typo, a deposit
 * on an instalment plan, or a case being sold under the phone's name. So an ad
 * that undercuts the median by more than `implausibleBelowPct` is returned as
 * `suspect` rather than as the best find of the run — surfaced, because
 * occasionally it is real, but never ranked at the top.
 *
 * `quality` and `seller` are multiplied in rather than added, so no discount is
 * large enough to redeem a broken unit sold by someone who cancels every order.
 */
export const assessGem = (
  candidate: Candidate,
  reference: PriceReference,
  config: GemConfig,
  severity: Severity,
  now: Date = new Date()
): GemAssessment => {
  const price = candidate.price ?? 0;
  const reasons: string[] = [];

  const base = {
    adId: candidate.id,
    price,
    discountPct: reference.median > 0 ? 1 - price / reference.median : 0,
    robustZ: reference.mad > 0 ? (reference.median - price) / reference.mad : 0,
  };

  if (reference.size < config.minReferenceSize) {
    return {
      ...base,
      verdict: 'rejected',
      score: 0,
      reasons: [
        `only ${reference.size} comparable ads — below the ${config.minReferenceSize} needed to ` +
          `know what this product costs, so no bargain can be claimed`,
      ],
    };
  }

  if (price <= 0) {
    return { ...base, verdict: 'rejected', score: 0, reasons: ['no price stated'] };
  }

  if (price < config.absoluteFloor) {
    return {
      ...base,
      verdict: 'suspect',
      score: 0,
      reasons: [`R$ ${price} is below the absolute floor of R$ ${config.absoluteFloor}`],
    };
  }

  if (price < reference.median * config.implausibleBelowPct) {
    return {
      ...base,
      verdict: 'suspect',
      score: 0,
      reasons: [
        `R$ ${price.toFixed(0)} is ${(base.discountPct * 100).toFixed(0)}% under the R$ ` +
          `${reference.median.toFixed(0)} median — too far under to be the same product in ` +
          `working order. Usually a scam, a typo, a deposit, or an accessory listed under the ` +
          `product's name.`,
      ],
    };
  }

  const quality = SEVERITY_QUALITY[severity];
  const seller = scoreSeller(candidate.seller, now);
  const ageDays = candidate.publishedAt
    ? (now.getTime() - candidate.publishedAt.getTime()) / 86_400_000
    : undefined;
  // A bargain that has sat unsold for two months is usually not a bargain.
  const recency = ageDays === undefined ? 0.5 : clamp01(1 - ageDays / 45);

  // Discount is scored against the threshold, so meeting it scores ~0.5 and
  // roughly doubling it saturates. Without this, a 90% discount and a 35% one
  // land in the same top bucket.
  const discountReach =
    config.minDiscountPct > 0 ? base.discountPct / (config.minDiscountPct * 2) : base.discountPct;

  const weights = config.weights;
  const totalWeight = weights.discount + weights.quality + weights.seller + weights.recency;
  const weighted =
    (weights.discount * clamp01(discountReach) +
      weights.quality * quality +
      weights.seller * seller +
      weights.recency * recency) /
    (totalWeight || 1);

  // Multiplied, not added: quality and seller are vetoes with a gradient, not
  // points to be traded away against a bigger discount.
  const score = clamp01(weighted * (0.4 + 0.6 * quality) * (0.5 + 0.5 * seller));

  const meetsDiscount = base.discountPct >= config.minDiscountPct;
  const meetsSpread = reference.mad === 0 || base.robustZ >= config.minRobustZ;

  reasons.push(
    `R$ ${price.toFixed(0)} against a median of R$ ${reference.median.toFixed(0)} ` +
      `(${(base.discountPct * 100).toFixed(0)}% below, ${base.robustZ.toFixed(1)} MAD) ` +
      `across ${reference.size} comparable ads`
  );
  if (severity !== 'none') reasons.push(`condition flagged as ${severity}`);
  if (candidate.seller?.salesCompleted !== undefined) {
    reasons.push(
      `seller: ${candidate.seller.salesCompleted} sales completed, ` +
        `${candidate.seller.salesCancelled ?? 0} cancelled`
    );
  }
  if (ageDays !== undefined) reasons.push(`posted ${Math.round(ageDays)} days ago`);

  if (!meetsDiscount) {
    reasons.push(`discount below the ${(config.minDiscountPct * 100).toFixed(0)}% threshold`);
  }
  if (!meetsSpread) {
    reasons.push(`within the normal spread for this product (needs ${config.minRobustZ} MAD)`);
  }

  const verdict: GemVerdict =
    meetsDiscount && meetsSpread && score >= config.alertScore
      ? 'gem'
      : meetsDiscount && meetsSpread
        ? 'watch'
        : 'rejected';

  return { ...base, verdict, score, reasons };
};

/**
 * Ranks a set of candidates against a reference built from the clean ones.
 *
 * The reference deliberately excludes damaged units even when `reference` is
 * 'all', unless asked otherwise: including them lowers the median, which raises
 * the bar every genuine bargain has to clear, which is precisely backwards.
 */
export interface CohortEntry {
  readonly candidate: Candidate;
  readonly severity: Severity;
  readonly clean: boolean;
  readonly facts: TaxonomyFacts;
}

/**
 * Ranks candidates against the narrowest comparable group each one has, rather
 * than against one median for the whole search.
 *
 * This is the correction to the naive version below. A single median mixes a
 * 10 Pro with a 10 Air and a 10S Pro, so "40% under" stops meaning "a bargain"
 * and starts meaning "a cheaper model" — with no way to tell which from the
 * number. Comparing each ad to its own model, storage and condition, and saying
 * out loud which stratum it settled for, makes the discount an actual claim.
 *
 * `duplicates` are relists collapsed by the photo-identity pass: the same unit
 * posted five times is one phone, and counting it five times moves the median it
 * is then judged against.
 */
export const rankGemsByCohort = (
  entries: readonly CohortEntry[],
  config: GemConfig,
  duplicates: ReadonlySet<string> = new Set(),
  now: Date = new Date()
): { assessments: GemAssessment[]; overall: PriceReference } => {
  const eligible = entries.filter(entry => !duplicates.has(entry.candidate.id));
  const pool = config.reference === 'clean' ? eligible.filter(entry => entry.clean) : eligible;
  const poolFacts = pool.map(entry => entry.facts);

  const overall = buildReference(
    pool
      .map(entry => entry.candidate.price)
      .filter((price): price is number => price !== undefined && price > 0)
  );

  const assessments = entries.map(entry => {
    const cohort = chooseCohort(entry.facts, poolFacts, config.minReferenceSize);
    const reference = buildReference(
      cohort.members
        .map(member => member.price)
        .filter((price): price is number => price !== undefined && price > 0)
    );

    const assessment = assessGem(entry.candidate, reference, config, entry.severity, now);
    const label = describeCohort(cohort, entry.facts);

    return {
      ...assessment,
      cohortLevel: cohort.level,
      cohortLabel: label,
      // The reference this ad was judged against, carried out so the store
      // records the number the verdict was computed from rather than a
      // corpus-wide median that no discount here refers to.
      referenceMedian: reference.median,
      cohortSize: reference.size,
      reasons: [`compared against ${label} (${reference.size} priced ads)`, ...assessment.reasons],
    };
  });

  return {
    assessments: assessments.sort((a, b) => b.score - a.score || a.price - b.price),
    overall,
  };
};

export const rankGems = (
  candidates: ReadonlyArray<{ candidate: Candidate; severity: Severity; clean: boolean }>,
  config: GemConfig,
  now: Date = new Date()
): { reference: PriceReference; assessments: GemAssessment[] } => {
  const pool = config.reference === 'clean' ? candidates.filter(entry => entry.clean) : candidates;
  const reference = buildReference(
    pool
      .map(entry => entry.candidate.price)
      .filter((price): price is number => price !== undefined && price > 0)
  );

  const assessments = candidates
    .map(entry => assessGem(entry.candidate, reference, config, entry.severity, now))
    .sort((a, b) => b.score - a.score || a.price - b.price);

  return { reference, assessments };
};
