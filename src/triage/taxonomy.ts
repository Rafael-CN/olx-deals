import { normalise } from './defects.js';

/**
 * Learns the product taxonomy from the corpus instead of being told it.
 *
 * The gem verdict is a comparison, and a comparison is only as good as the group
 * it compares against. A single median over everything a query returned puts the
 * 10 Pro, the 10S Pro and the 10 Air in one pile — so "40% below the going rate"
 * can mean "this is a bargain" or "this is a cheaper model", and the number
 * cannot tell you which. No amount of title scoring fixes that; the cohort is
 * what is wrong.
 *
 * OLX already publishes the answer on every ad page: `Marca`, `Modelo`,
 * `Memória interna` and `Condição` are picked from its own lists, so they are
 * consistent in a way free text never is. This reads them and builds the strata.
 */

export interface TaxonomyFacts {
  readonly adId: string;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  readonly matchScore: number;
  readonly price?: number | undefined;
}

export interface ModelTally {
  readonly brand?: string | undefined;
  readonly model?: string | undefined;
  readonly label: string;
  readonly count: number;
  /** Mean title-match score of the ads carrying this model. */
  readonly meanMatch: number;
  readonly medianPrice: number;
}

export interface Taxonomy {
  readonly models: ModelTally[];
  /** The model the run is most plausibly about. */
  readonly target?: ModelTally | undefined;
  /** Models present in the corpus that are not the target. */
  readonly siblings: ModelTally[];
  /** Sibling model names, ready to be used as demotions. */
  readonly suggestedDemotions: string[];
  readonly coverage: number;
}

const ATTRIBUTE_KEYS = {
  brand: 'Marca',
  model: 'Modelo',
  storage: 'Memória interna',
  condition: 'Condição',
} as const;

const attr = (facts: TaxonomyFacts, key: keyof typeof ATTRIBUTE_KEYS): string | undefined => {
  const value = facts.attributes?.[ATTRIBUTE_KEYS[key]];
  return value?.trim() || undefined;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/**
 * Counts the models the corpus actually contains and picks the one the run is
 * about.
 *
 * The target is chosen by mean title-match rather than by frequency, and that
 * distinction matters: on a broad query the wrong model is often the *more*
 * common one, while the ads that answer the query best are the ones that name
 * the right model. Frequency breaks ties.
 */
export const buildTaxonomy = (corpus: readonly TaxonomyFacts[]): Taxonomy => {
  const groups = new Map<string, TaxonomyFacts[]>();

  for (const facts of corpus) {
    const model = attr(facts, 'model');
    if (!model) continue;
    const key = [attr(facts, 'brand'), model].filter(Boolean).join(' ');
    groups.set(key, [...(groups.get(key) ?? []), facts]);
  }

  const models: ModelTally[] = [...groups.entries()]
    .map(([label, members]) => ({
      brand: attr(members[0] as TaxonomyFacts, 'brand'),
      model: attr(members[0] as TaxonomyFacts, 'model'),
      label,
      count: members.length,
      meanMatch: members.reduce((sum, m) => sum + m.matchScore, 0) / members.length,
      medianPrice: median(
        members.map(m => m.price).filter((price): price is number => price !== undefined)
      ),
    }))
    .sort((a, b) => b.meanMatch - a.meanMatch || b.count - a.count);

  // One ad of a model proves nothing about a model; it is usually a typo in
  // OLX's own field or a mislabelled listing.
  const credible = models.filter(entry => entry.count >= 2);
  const target = credible[0] ?? models[0];
  const siblings = models.filter(entry => entry.label !== target?.label);

  return {
    models,
    target,
    siblings,
    suggestedDemotions: siblings
      .filter(entry => entry.count >= 2 && entry.model)
      .map(entry => entry.model as string),
    coverage:
      corpus.length === 0 ? 0 : groups.size === 0 ? 0 : countWithModel(corpus) / corpus.length,
  };
};

const countWithModel = (corpus: readonly TaxonomyFacts[]): number =>
  corpus.filter(facts => attr(facts, 'model')).length;

/** Strata, narrowest first. Each is a fallback for the one before it. */
export const COHORT_LEVELS = ['model+storage+condition', 'model+storage', 'model', 'all'] as const;

export type CohortLevel = (typeof COHORT_LEVELS)[number];

/**
 * The key an ad belongs to at a given level. Ads missing the attribute a level
 * needs get no key there, so they fall through to a broader one rather than
 * forming a phantom cohort of their own.
 */
export const cohortKey = (facts: TaxonomyFacts, level: CohortLevel): string | undefined => {
  const model = attr(facts, 'model');
  const storage = attr(facts, 'storage');
  const condition = attr(facts, 'condition');

  switch (level) {
    case 'model+storage+condition':
      return model && storage && condition
        ? normalise(`${model}|${storage}|${condition}`)
        : undefined;
    case 'model+storage':
      return model && storage ? normalise(`${model}|${storage}`) : undefined;
    case 'model':
      return model ? normalise(model) : undefined;
    case 'all':
      return 'all';
  }
};

export interface CohortChoice {
  readonly level: CohortLevel;
  readonly key: string;
  readonly members: TaxonomyFacts[];
}

/**
 * The narrowest cohort for an ad that still has enough comparables to mean
 * something, widening until it does.
 *
 * This is the whole reason stratification is safe to attempt. Comparing a
 * 512 GB "Usado - Excelente" against other 512 GB "Usado - Excelente" units is
 * the honest comparison, but there are rarely twelve of those — so the search
 * steps outward, and reports which step it settled on, rather than either
 * inventing a median from four ads or giving up.
 */
export const comparable = (facts: TaxonomyFacts): boolean =>
  facts.price !== undefined && Number.isFinite(facts.price) && facts.price > 0;

export const chooseCohort = (
  subject: TaxonomyFacts,
  corpus: readonly TaxonomyFacts[],
  minSize: number
): CohortChoice => {
  for (const level of COHORT_LEVELS) {
    const key = cohortKey(subject, level);
    if (!key) continue;

    const members = corpus.filter(facts => cohortKey(facts, level) === key);
    // Counted by priced members only. An ad OLX lists without a price sits in
    // the cohort but contributes nothing to a median, so counting it here
    // accepted a stratum at twelve that buildReference then rejected at nine —
    // the selector approving a cohort the reference refused to judge.
    if (members.filter(comparable).length >= minSize) return { level, key, members };
  }

  return { level: 'all', key: 'all', members: [...corpus] };
};

/** Human-readable name for a cohort, for explaining a verdict. */
export const describeCohort = (choice: CohortChoice, subject: TaxonomyFacts): string => {
  const model = attr(subject, 'model') ?? 'this product';
  switch (choice.level) {
    case 'model+storage+condition':
      return `${model}, ${attr(subject, 'storage')}, ${attr(subject, 'condition')}`;
    case 'model+storage':
      return `${model}, ${attr(subject, 'storage')} (any condition)`;
    case 'model':
      return `${model} (any storage or condition)`;
    case 'all':
      return 'everything the search returned — too few comparables to narrow further';
  }
};
