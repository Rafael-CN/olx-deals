import { normalise } from './defects.js';

export interface MatchBreakdown {
  /** 0-100. How well this title answers the query that found it. */
  readonly score: number;
  readonly coverage: number;
  readonly matchedTokens: string[];
  readonly missingTokens: string[];
  readonly exactPhrase: boolean;
  readonly inOrder: boolean;
  readonly demotedBy: string[];
}

/**
 * Scores how closely a listing title matches the query, instead of deciding
 * whether it does.
 *
 * The reason is the whole point of a bargain hunt. OLX's search is fuzzy, so
 * "redmagic 10 pro" returns the phone, its siblings, and a pile of accessories —
 * and a hard title filter that keeps only clean matches throws away exactly the
 * ads worth finding. A badly titled listing is *under-found by everyone*, which
 * is why it can sit under the going rate. Ranking keeps it in the corpus and lets
 * a threshold be moved afterwards without spending a single request.
 *
 * Coverage is weighted by token length, which is what makes it behave sensibly:
 * matching "redmagic" is worth four times matching "10", because "10" is shared
 * with half the catalogue.
 */
export const scoreMatch = (
  title: string,
  query: string,
  demote: readonly string[] = []
): MatchBreakdown => {
  const haystack = normalise(title);
  const tokens = tokenise(query);

  if (tokens.length === 0) {
    return {
      score: 0,
      coverage: 0,
      matchedTokens: [],
      missingTokens: [],
      exactPhrase: false,
      inOrder: false,
      demotedBy: [],
    };
  }

  const titleTokens = tokenise(title);
  const present = new Set(titleTokens);
  // Where in the title each query token was found, for the in-order bonus.
  const foundAt = new Map<string, number>();

  const record = (token: string, position: number) => {
    if (!foundAt.has(token)) foundAt.set(token, position);
  };

  for (const [position, token] of titleTokens.entries()) {
    if (present.has(token)) record(token, position);
  }
  for (const token of tokens) {
    const position = titleTokens.indexOf(token);
    if (position >= 0) record(token, position);
  }

  // "RedMagic10Pro" written as one word. A title token counts only if it splits
  // *entirely* into query tokens, which is what keeps this exact: "promocao"
  // begins with "pro" and splits into "pro" + "mocao", so it is not a match.
  for (const [position, titleToken] of titleTokens.entries()) {
    if (present.has(titleToken) && tokens.includes(titleToken)) continue;
    for (const token of segmentInto(titleToken, tokens)) record(token, position);
  }

  // The same thing from the other side: "redmagic" written as "Red Magic". A
  // query token counts when consecutive title tokens spell it out completely.
  for (let start = 0; start < titleTokens.length; start += 1) {
    let joined = '';
    for (let end = start; end < Math.min(start + MAX_JOIN, titleTokens.length); end += 1) {
      joined += titleTokens[end];
      if (end > start && tokens.includes(joined)) record(joined, start);
    }
  }

  const matched: string[] = [];
  const missing: string[] = [];
  const positions: number[] = [];
  let weightMatched = 0;
  let weightTotal = 0;

  for (const token of tokens) {
    weightTotal += token.length;
    const position = foundAt.get(token);
    if (position === undefined) {
      missing.push(token);
      continue;
    }
    matched.push(token);
    positions.push(position);
    weightMatched += token.length;
  }

  const coverage = weightTotal === 0 ? 0 : weightMatched / weightTotal;

  // The query as one contiguous phrase is the strongest signal there is: it is
  // the difference between "Redmagic 10 Pro 512GB" and "Redmagic 10 Air, aceito
  // troca por Pro".
  const phrase = tokens.join(' ');
  const exactPhrase = haystack.replace(/\s+/g, ' ').includes(phrase);
  const inOrder = positions.every(
    (value, index) => index === 0 || value >= (positions[index - 1] ?? 0)
  );

  // Coverage is scaled to 0.88 so the phrase bonus has room to matter. Without
  // that headroom every title containing all the words scored 100 and
  // "Redmagic 10 Pro 512GB" was indistinguishable from "Pro gamer: redmagic, 10
  // de bateria" — which is exactly the distinction a search is asking for.
  let value = coverage * 0.88;
  if (exactPhrase) value += 0.12;
  else if (inOrder && matched.length > 1) value += 0.05;

  // Demotion, not exclusion. A competing model name or an accessory word makes an
  // ad far less likely to be what was asked for, but it stays in the corpus at a
  // low score so a later pass can still look at it.
  const demotedBy = demote
    .map(pattern => ({ pattern, hit: matchesPattern(haystack, pattern) }))
    .filter(entry => entry.hit)
    .map(entry => entry.pattern);
  if (demotedBy.length > 0) value *= 0.3;

  return {
    score: Math.max(0, Math.min(100, Math.round(value * 100))),
    coverage,
    matchedTokens: matched,
    missingTokens: missing,
    exactPhrase,
    inOrder,
    demotedBy,
  };
};

/** How many consecutive title tokens may be joined to spell one query token. */
const MAX_JOIN = 4;

/**
 * The query tokens a single title token spells out, when it spells out nothing
 * else.
 *
 * Every match this module makes lands on a token boundary. Substring matching
 * was deliberate once — the comment justified it with "pro" needing to match
 * "pró" and "512gb" needing to match "512GB/16GB" — but accent folding already
 * handles the first and tokenising the title already handles the second, while
 * the substring bought two failures nobody wanted: "iPhone 13 128GB promocao"
 * scored the same as a real iPhone 13 Pro, and so did "Nubia Redmagic 10S Pro"
 * against "redmagic 10 pro". A digit that blurs is worse than a word that does.
 */
const segmentInto = (titleToken: string, queryTokens: readonly string[]): string[] => {
  const usable = queryTokens.filter(token => token.length >= 2);
  if (usable.length === 0) return [];

  const reached: Array<string[] | undefined> = Array(titleToken.length + 1).fill(undefined);
  reached[0] = [];

  for (let at = 0; at < titleToken.length; at += 1) {
    const sofar = reached[at];
    if (sofar === undefined) continue;
    for (const token of usable) {
      const next = at + token.length;
      if (next > titleToken.length) continue;
      if (!titleToken.startsWith(token, at)) continue;
      if (reached[next] === undefined) reached[next] = [...sofar, token];
    }
  }

  const path = reached[titleToken.length];
  // One token is not a split; that case is plain equality and already handled.
  return path !== undefined && path.length > 1 ? path : [];
};

const tokenise = (query: string): string[] =>
  normalise(query)
    .split(/[^\p{L}\p{N}]+/u)
    .map(token => token.trim())
    .filter(Boolean);

const matchesPattern = (haystack: string, pattern: string): boolean => {
  const folded = normalise(pattern);
  try {
    return new RegExp(folded, 'iu').test(haystack);
  } catch {
    return haystack.includes(folded);
  }
};

/**
 * Words that mark a listing as a neighbouring model or an accessory rather than
 * the thing asked for. Used as a demotion, never as a filter.
 *
 * Kept generic on purpose: a product-specific list belongs in the profile, and
 * the skill is told to build one from the query.
 */
export const DEFAULT_DEMOTIONS: readonly string[] = [
  'capa',
  'capinha',
  'case ',
  'pelicula',
  'película',
  'carregador',
  'cabo ',
  'fone',
  'suporte',
  'bateria avulsa',
  'tela avulsa',
  'display avulso',
  'somente a caixa',
  'apenas a caixa',
  'sucata',
  'para retirada de pec',
];

/**
 * The best score any of a run's queries gives this title.
 *
 * A gem hunt sweeps several phrasings of the same want — "redmagic 10 pro",
 * "red magic 10 pro", "nubia redmagic 10" — and an ad found by the loosest one
 * should still be judged by the one it answers best.
 */
export const scoreBestMatch = (
  title: string,
  queries: readonly string[],
  demote: readonly string[] = []
): MatchBreakdown => {
  const scored = queries
    .filter(query => query.trim().length > 0)
    .map(query => scoreMatch(title, query, demote));

  return scored.reduce<MatchBreakdown>(
    (best, current) => (current.score > best.score ? current : best),
    scored[0] ?? scoreMatch(title, '', demote)
  );
};
