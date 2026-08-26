import { DomainConfig, OlxDomain, SearchSelectors } from '../../core/types.js';

/**
 * olx.com.br addresses a search entirely through the path plus a `q` parameter:
 * /<category>/<state>/<region>?q=... — in that order. A category placed after a
 * location is silently ignored (/estado-sp/celulares returns every São Paulo
 * ad), which is why the two are not interchangeable here.
 *
 * With neither, the site expects the literal /brasil.
 */
const BRAZIL_ALL_ADS_PATH = '/brasil';

/** Folds Portuguese diacritics down to the ASCII that OLX's slugs use. */
const PORTUGUESE_BR_FOLDING: ReadonlyArray<readonly [RegExp, string]> = [
  [/[áàâãä]/g, 'a'],
  [/[éèê]/g, 'e'],
  [/[íì]/g, 'i'],
  [/[óòôõ]/g, 'o'],
  [/[úùü]/g, 'u'],
  [/ç/g, 'c'],
  [/ñ/g, 'n'],
];

const slugifyLocation = (
  value: string,
  folding: ReadonlyArray<readonly [RegExp, string]>
): string =>
  folding.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value.toLowerCase().replace(/\s+/g, '-')
  );

/**
 * States are addressed as `estado-sp`. A bare UF is accepted as a convenience,
 * so callers can pass "SP" or "sp"; anything else — a region slug such as
 * "sao-paulo-e-regiao", or a full "estado-sp/sao-paulo-e-regiao" — is slugified
 * segment by segment and passed through.
 */
const slugifyBrazilLocation = (location: string): string =>
  location
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment =>
      /^[a-zA-Z]{2}$/.test(segment)
        ? `estado-${segment.toLowerCase()}`
        : slugifyLocation(segment, PORTUGUESE_BR_FOLDING)
    )
    .join('/');

const buildBrazilSearchPath = (location?: string, _query?: string, category?: string): string => {
  const segments = [
    category ? slugifyLocation(category, PORTUGUESE_BR_FOLDING) : '',
    location ? slugifyBrazilLocation(location) : '',
  ].filter(Boolean);

  return segments.length > 0 ? `/${segments.join('/')}` : BRAZIL_ALL_ADS_PATH;
};

/**
 * Card markup on olx.com.br. The `olx-adcard__*` classes come from the OLX
 * Brazil design system rather than from a build hash, so they survive deploys;
 * the ad card carries no data-testid other than on its link.
 */
const BRAZIL_SEARCH_SELECTORS: SearchSelectors = {
  listingCard: 'section.olx-adcard',
  title: '.olx-adcard__title',
  // Scoped to h3 so a struck-through `.olx-adcard__old-price` is never read as
  // the asking price.
  price: 'h3.olx-adcard__price',
  location: '.olx-adcard__location',
  image: '.olx-adcard__media img',
  link: 'a[data-testid="adcard-link"]',
  publishDate: '.olx-adcard__date',
  // Unused: OLXBRScraper derives paging from the result-range text, because the
  // pagination anchors carry no class of their own to match on.
  nextPage: 'a[href*="&o="]',
  // The wrapper's class is build-hashed after the prefix, hence the substring
  // match: "TotalOfAds-module-scss-module__<hash>__titleContainer".
  totalCount: '[class*="TotalOfAds"] p',
};

export const OLX_DOMAIN_CONFIGS: Record<OlxDomain, DomainConfig> = {
  'olx.com.br': {
    domain: 'olx.com.br',
    baseUrl: 'https://www.olx.com.br',
    currency: 'BRL',
    language: 'pt-BR',
    selectors: { search: BRAZIL_SEARCH_SELECTORS },
    // Its ad slots and trackers poll continuously, so the page never goes
    // network-idle and every navigation would time out waiting for it.
    waitUntil: 'domcontentloaded',
    urlPatterns: {
      searchPath: buildBrazilSearchPath,
      priceParams: { min: 'ps', max: 'pe' },
      // Each order has its own parameter here: `sf=1` is "Mais Recentes",
      // `sp=1` is "Menor Preço" and `sp=5` is "Maior Preço". Passing an
      // unrecognised value (sp=2, sf=2) silently falls back to relevance, so
      // these three are the only ones the site actually honours.
      sortParams: {
        date: { param: 'sf', value: '1' },
        'price-asc': { param: 'sp', value: '1' },
        'price-desc': { param: 'sp', value: '5' },
      },
      // No categoryParam: the category is the first path segment.
      queryParam: 'q',
      pageParam: 'o',
    },
  },
};

export const getDomainConfig = (domain: OlxDomain): DomainConfig => {
  const config = OLX_DOMAIN_CONFIGS[domain];
  if (!config) {
    throw new Error(`Unsupported OLX domain: ${domain}`);
  }
  return config;
};

export const getSupportedDomains = (): OlxDomain[] => {
  return Object.keys(OLX_DOMAIN_CONFIGS) as OlxDomain[];
};

export const isDomainSupported = (domain: string): domain is OlxDomain => {
  return domain in OLX_DOMAIN_CONFIGS;
};
