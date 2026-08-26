import { DEFAULT_DEFECT_LEXICON, DefectLexicon } from '../config/profile.js';

export type Severity = 'none' | 'minor' | 'major' | 'broken';

export interface DefectHit {
  readonly term: string;
  readonly severity: Exclude<Severity, 'none'>;
  /** The words around the match, so a verdict can be read and argued with. */
  readonly context: string;
}

export interface DefectFinding {
  readonly severity: Severity;
  readonly hits: DefectHit[];
  /** Defect words that appeared but were being denied ("sem linha verde"). */
  readonly negated: DefectHit[];
  readonly notForSale: DefectHit[];
}

/**
 * Folds accents and case so one lexicon entry matches every way a seller might
 * type it. Brazilian classified ads are written quickly on phones: "não",
 * "nao" and "NÃO" all appear in the same listing.
 */
export const normalise = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SEVERITY_ORDER: Record<Severity, number> = { none: 0, minor: 1, major: 2, broken: 3 };

export const worseOf = (a: Severity, b: Severity): Severity =>
  SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;

export const atMost = (severity: Severity, tolerated: Severity): boolean =>
  SEVERITY_ORDER[severity] <= SEVERITY_ORDER[tolerated];

/** Clause boundaries, so a negator does not reach across a full stop. */
const CLAUSE_BREAK = /[.;!?\n•|]/;

/**
 * Reads a listing's own words for damage.
 *
 * The hard part is not finding defect words, it is not being fooled by honest
 * sellers. "Sem trincos, sem linha verde, nenhum detalhe" is the description of a
 * pristine phone, and a naive keyword filter throws exactly those ads away while
 * keeping the ones that never mention condition at all. So every hit is checked
 * for a negator in the words immediately before it, bounded by the clause.
 */
export const findDefects = (
  text: string,
  lexicon: DefectLexicon = DEFAULT_DEFECT_LEXICON
): DefectFinding => {
  const haystack = normalise(text);
  const negators = lexicon.negators.map(normalise).filter(Boolean);

  const isNegated = (matchIndex: number): boolean => {
    const from = Math.max(0, matchIndex - lexicon.negationWindow);
    const window = haystack.slice(from, matchIndex);
    // Only the last clause counts: in "quebrou a tela. sem garantia" the "sem"
    // must not reach back and cancel the defect stated in the previous sentence.
    const clause = window.split(CLAUSE_BREAK).pop() ?? window;
    return negators.some(negator => clause.includes(negator));
  };

  const contextAround = (index: number, length: number): string =>
    text
      .slice(Math.max(0, index - 30), Math.min(text.length, index + length + 30))
      .replace(/\s+/g, ' ')
      .trim();

  const scan = (terms: readonly string[], severity: Exclude<Severity, 'none'>) => {
    const hits: DefectHit[] = [];
    const negated: DefectHit[] = [];

    for (const raw of terms) {
      const term = normalise(raw);
      if (!term) continue;

      let from = 0;
      for (;;) {
        const index = haystack.indexOf(term, from);
        if (index < 0) break;
        from = index + term.length;
        const hit: DefectHit = { term: raw, severity, context: contextAround(index, term.length) };
        (isNegated(index) ? negated : hits).push(hit);
      }
    }
    return { hits, negated };
  };

  const broken = scan(lexicon.broken, 'broken');
  const major = scan(lexicon.major, 'major');
  const minor = scan(lexicon.minor, 'minor');
  // A wanted-ad or an accessory listing is not damaged, it is the wrong thing;
  // negation does not apply the same way, so these are reported separately.
  const notForSale = scan(lexicon.notForSale, 'broken');

  const hits = [...broken.hits, ...major.hits, ...minor.hits];
  const severity = hits.reduce<Severity>((worst, hit) => worseOf(worst, hit.severity), 'none');

  return {
    severity,
    hits,
    negated: [...broken.negated, ...major.negated, ...minor.negated],
    notForSale: notForSale.hits,
  };
};

/**
 * Maps OLX's own "Condição" attribute onto the same scale, so a structured field
 * and a free-text description can be compared. The attribute is the more
 * reliable of the two when present — the seller picked it from a list.
 */
export const severityOfCondition = (condition: string | undefined): Severity => {
  if (!condition) return 'none';
  const value = normalise(condition);
  if (/nao funciona|para peca|sucata|quebrad/.test(value)) return 'broken';
  if (/ruim|regular/.test(value)) return 'major';
  if (/\bbom\b/.test(value)) return 'minor';
  return 'none';
};
