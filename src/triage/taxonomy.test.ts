import { describe, it, expect } from 'vitest';
import {
  TaxonomyFacts,
  buildTaxonomy,
  chooseCohort,
  cohortKey,
  describeCohort,
} from './taxonomy.js';

const ad = (
  adId: string,
  model: string | undefined,
  overrides: {
    brand?: string;
    storage?: string;
    condition?: string;
    matchScore?: number;
    price?: number;
  } = {}
): TaxonomyFacts => ({
  adId,
  matchScore: overrides.matchScore ?? 100,
  price: overrides.price ?? 3500,
  attributes: {
    ...(overrides.brand ? { Marca: overrides.brand } : { Marca: 'Nubia' }),
    ...(model ? { Modelo: model } : {}),
    ...(overrides.storage ? { 'Memória interna': overrides.storage } : {}),
    ...(overrides.condition ? { Condição: overrides.condition } : {}),
  },
});

describe('buildTaxonomy', () => {
  it('picks the target by how well its ads answered the query, not by count', () => {
    // The wrong model is deliberately the more common one, which is what a broad
    // query actually produces.
    const corpus = [
      ad('a', 'RedMagic 10 Pro', { matchScore: 100 }),
      ad('b', 'RedMagic 10 Pro', { matchScore: 98 }),
      ad('c', 'RedMagic 10 Air', { matchScore: 60 }),
      ad('d', 'RedMagic 10 Air', { matchScore: 58 }),
      ad('e', 'RedMagic 10 Air', { matchScore: 62 }),
    ];

    const taxonomy = buildTaxonomy(corpus);
    expect(taxonomy.target?.model).toBe('RedMagic 10 Pro');
    expect(taxonomy.siblings.map(s => s.model)).toContain('RedMagic 10 Air');
  });

  it('offers the sibling models as demotions the user never had to write', () => {
    const taxonomy = buildTaxonomy([
      ad('a', 'RedMagic 10 Pro', { matchScore: 100 }),
      ad('b', 'RedMagic 10 Pro', { matchScore: 100 }),
      ad('c', 'RedMagic 10S Pro', { matchScore: 95 }),
      ad('d', 'RedMagic 10S Pro', { matchScore: 95 }),
    ]);

    // "10S Pro" scores 100 on title alone because it contains the whole query;
    // only the structured field tells them apart.
    expect(taxonomy.suggestedDemotions).toContain('RedMagic 10S Pro');
    expect(taxonomy.suggestedDemotions).not.toContain('RedMagic 10 Pro');
  });

  it('ignores a model seen exactly once when choosing the target', () => {
    const taxonomy = buildTaxonomy([
      ad('typo', 'Redmagik 10 Pro', { matchScore: 100 }),
      ad('a', 'RedMagic 10 Pro', { matchScore: 90 }),
      ad('b', 'RedMagic 10 Pro', { matchScore: 90 }),
    ]);

    expect(taxonomy.target?.model).toBe('RedMagic 10 Pro');
    expect(taxonomy.suggestedDemotions).not.toContain('Redmagik 10 Pro');
  });

  it('reports how much of the corpus it could classify at all', () => {
    const taxonomy = buildTaxonomy([
      ad('a', 'RedMagic 10 Pro'),
      ad('b', undefined),
      ad('c', undefined),
      ad('d', 'RedMagic 10 Pro'),
    ]);

    expect(taxonomy.coverage).toBe(0.5);
  });

  it('says nothing rather than guessing from an unenriched corpus', () => {
    const taxonomy = buildTaxonomy([ad('a', undefined), ad('b', undefined)]);
    expect(taxonomy.target).toBeUndefined();
    expect(taxonomy.models).toHaveLength(0);
    expect(taxonomy.coverage).toBe(0);
  });

  it('takes the median price per model, not the mean', () => {
    const taxonomy = buildTaxonomy([
      ad('a', 'RedMagic 10 Pro', { price: 3000 }),
      ad('b', 'RedMagic 10 Pro', { price: 3500 }),
      ad('c', 'RedMagic 10 Pro', { price: 99999 }),
    ]);

    expect(taxonomy.target?.medianPrice).toBe(3500);
  });
});

describe('cohortKey', () => {
  const full = ad('a', 'RedMagic 10 Pro', { storage: '512GB', condition: 'Usado - Excelente' });

  it('narrows from model to model plus storage plus condition', () => {
    expect(cohortKey(full, 'model')).toBe('redmagic 10 pro');
    expect(cohortKey(full, 'model+storage')).toBe('redmagic 10 pro|512gb');
    expect(cohortKey(full, 'model+storage+condition')).toBe(
      'redmagic 10 pro|512gb|usado - excelente'
    );
  });

  it('gives no key at a level whose attribute is missing', () => {
    const partial = ad('b', 'RedMagic 10 Pro');
    expect(cohortKey(partial, 'model')).toBe('redmagic 10 pro');
    expect(cohortKey(partial, 'model+storage')).toBeUndefined();
  });

  it('folds case and accents so OLX own spelling variations still group', () => {
    const a = ad('a', 'RedMagic 10 Pro', { condition: 'Usado - Bom', storage: '256GB' });
    const b = ad('b', 'redmagic 10 pro', { condition: 'usado - bom', storage: '256gb' });
    expect(cohortKey(a, 'model+storage+condition')).toBe(cohortKey(b, 'model+storage+condition'));
  });
});

describe('chooseCohort', () => {
  const subject = ad('subject', 'RedMagic 10 Pro', {
    storage: '512GB',
    condition: 'Usado - Excelente',
  });

  it('uses the narrowest cohort when it has enough comparables', () => {
    const corpus = Array.from({ length: 6 }, (_, i) =>
      ad(`x${i}`, 'RedMagic 10 Pro', { storage: '512GB', condition: 'Usado - Excelente' })
    );

    const choice = chooseCohort(subject, corpus, 5);
    expect(choice.level).toBe('model+storage+condition');
    expect(choice.members).toHaveLength(6);
  });

  it('widens one step at a time rather than giving up', () => {
    // Only three exact matches, but plenty of the same model at other storages.
    const corpus = [
      ...Array.from({ length: 3 }, (_, i) =>
        ad(`exact${i}`, 'RedMagic 10 Pro', { storage: '512GB', condition: 'Usado - Excelente' })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ad(`other${i}`, 'RedMagic 10 Pro', { storage: '256GB', condition: 'Usado - Bom' })
      ),
    ];

    const choice = chooseCohort(subject, corpus, 5);
    expect(choice.level).toBe('model');
    expect(choice.members).toHaveLength(11);
  });

  it('falls back to the whole corpus only when nothing narrower qualifies', () => {
    const corpus = [ad('a', 'Outro Modelo'), ad('b', 'Mais Outro'), ad('c', 'Terceiro')];
    const choice = chooseCohort(subject, corpus, 5);

    expect(choice.level).toBe('all');
    expect(choice.members).toHaveLength(3);
  });

  it('keeps a sibling model out of the cohort, which is the whole point', () => {
    const corpus = [
      ...Array.from({ length: 5 }, (_, i) => ad(`pro${i}`, 'RedMagic 10 Pro', { price: 3800 })),
      ...Array.from({ length: 20 }, (_, i) => ad(`air${i}`, 'RedMagic 10 Air', { price: 2200 })),
    ];

    const choice = chooseCohort(subject, corpus, 5);
    expect(choice.level).toBe('model');
    expect(choice.members.every(m => m.attributes?.['Modelo'] === 'RedMagic 10 Pro')).toBe(true);
    // Without this, the Airs would drag the median down and every real Pro
    // bargain would look like an ordinary price.
    expect(choice.members).toHaveLength(5);
  });
});

describe('describeCohort', () => {
  it('says what an ad was actually compared against', () => {
    const subject = ad('s', 'RedMagic 10 Pro', { storage: '512GB', condition: 'Usado - Bom' });

    expect(
      describeCohort({ level: 'model+storage+condition', key: 'k', members: [] }, subject)
    ).toBe('RedMagic 10 Pro, 512GB, Usado - Bom');
    expect(describeCohort({ level: 'model', key: 'k', members: [] }, subject)).toMatch(
      /any storage or condition/
    );
    expect(describeCohort({ level: 'all', key: 'all', members: [] }, subject)).toMatch(
      /too few comparables/
    );
  });
});
