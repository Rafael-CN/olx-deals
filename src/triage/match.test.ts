import { describe, it, expect } from 'vitest';
import { DEFAULT_DEMOTIONS, scoreBestMatch, scoreMatch } from './match.js';

/**
 * Titles taken from a real nationwide search for "redmagic 10 pro", which
 * reported 191 results. A hard title filter kept two of them; the rest are what
 * this scoring exists to rank rather than discard.
 */
const REAL_TITLES = [
  'Redmagic 10 pró (celular gamer)',
  'REDMAGIC 10 PRO',
  'Redmagic 10 pro - 512GB / 16GB RAM',
  'Redmagic 10 PRO aceito troca',
  'Redmagic 10 pro Smartphone gamer',
  'RedMagic 10 pro',
  'RedMagic 10 Air - Cor Exclusiva com Memória de 16gb de RAM',
  'Núbia RedMagic 10 pro - 12/256GB',
];

const query = 'redmagic 10 pro';

describe('scoreMatch', () => {
  it('scores an exact title at the top', () => {
    expect(scoreMatch('REDMAGIC 10 PRO', query).score).toBe(100);
    expect(scoreMatch('RedMagic 10 pro', query).score).toBe(100);
  });

  it('matches through an accent, which a literal filter would miss', () => {
    // "pró" is where a plain `pro` requirement silently drops a real listing.
    const scored = scoreMatch('Redmagic 10 pró (celular gamer)', query);
    expect(scored.missingTokens).toEqual([]);
    expect(scored.score).toBeGreaterThanOrEqual(95);
  });

  it('keeps a well-matching title high despite extra words', () => {
    for (const title of [
      'Redmagic 10 pro - 512GB / 16GB RAM',
      'Redmagic 10 PRO aceito troca',
      'Núbia RedMagic 10 pro - 12/256GB',
    ]) {
      expect(scoreMatch(title, query).score).toBeGreaterThanOrEqual(95);
    }
  });

  it('ranks a neighbouring model below the real one instead of dropping it', () => {
    const air = scoreMatch('RedMagic 10 Air - Cor Exclusiva 16gb RAM', query);
    const pro = scoreMatch('RedMagic 10 pro', query);

    expect(air.score).toBeLessThan(pro.score);
    expect(air.score).toBeGreaterThan(0);
    expect(air.missingTokens).toEqual(['pro']);
  });

  it('weighs a long distinctive token above a short common one', () => {
    // Missing "redmagic" should cost far more than missing "10".
    const noBrand = scoreMatch('Celular 10 pro', query);
    const noNumber = scoreMatch('Redmagic pro', query);
    expect(noBrand.score).toBeLessThan(noNumber.score);
  });

  it('rewards the query appearing as one phrase', () => {
    const phrase = scoreMatch('Vendo redmagic 10 pro barato', query);
    const scattered = scoreMatch('Pro gamer: redmagic, 10 de bateria', query);
    expect(phrase.exactPhrase).toBe(true);
    expect(phrase.score).toBeGreaterThan(scattered.score);
  });

  it('demotes an accessory heavily without removing it from the corpus', () => {
    const accessory = scoreMatch('Capa para Redmagic 10 Pro', query, DEFAULT_DEMOTIONS);
    expect(accessory.demotedBy).toContain('capa');
    expect(accessory.score).toBeLessThan(40);
    expect(accessory.score).toBeGreaterThan(0);
  });

  it('scores an unrelated title at zero', () => {
    expect(scoreMatch('Cafeteira 3 Corações', query).score).toBe(0);
  });

  it('handles an empty query without pretending it matched', () => {
    expect(scoreMatch('RedMagic 10 Pro', '').score).toBe(0);
  });

  it('ranks the real search results the way a person would', () => {
    const ranked = REAL_TITLES.map(title => ({
      title,
      score: scoreMatch(title, query).score,
    })).sort((a, b) => b.score - a.score);

    // Every genuine "10 pro" outranks the "10 Air".
    const airIndex = ranked.findIndex(entry => entry.title.includes('Air'));
    expect(airIndex).toBe(ranked.length - 1);
    // And nothing that a person would call a match was scored away.
    expect(ranked.filter(entry => entry.score >= 90)).toHaveLength(REAL_TITLES.length - 1);
  });
});

describe('scoreBestMatch', () => {
  it('takes the query the ad answers best', () => {
    const queries = ['redmagic 10 pro', 'nubia redmagic 10'];
    const scored = scoreBestMatch('Núbia RedMagic 10 pro - 12/256GB', queries);

    expect(scored.score).toBeGreaterThanOrEqual(
      scoreMatch('Núbia RedMagic 10 pro - 12/256GB', 'redmagic 10 pro').score
    );
  });

  it('does not let a loose query drag down an ad a tighter one matched', () => {
    const scored = scoreBestMatch('REDMAGIC 10 PRO', ['celular gamer', 'redmagic 10 pro']);
    expect(scored.score).toBe(100);
  });

  it('survives an empty query list', () => {
    expect(scoreBestMatch('RedMagic 10 Pro', []).score).toBe(0);
  });
});
