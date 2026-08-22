import { DomainConfig, DomainSelectors, OlxDomain, SearchSelectors } from '../../core/types.js';

/**
 * The European OLX sites are one application served under different locales, so
 * the markup — and therefore every selector — is identical across them. Keeping
 * one copy means a selector change is one edit, not five.
 *
 * olx.com.br is not that application. It is a separate Brazilian frontend with
 * its own markup, its own URL grammar and its own sort parameters, so it brings
 * its own selectors below rather than sharing these.
 */
const COMMON_SELECTORS: DomainSelectors = {
  search: {
    listingCard: '[data-cy="l-card"]',
    title: '[data-testid="ad-card-title"] h4, [data-testid="ad-card-title"] h6',
    price: '[data-testid="ad-price"]',
    location: '[data-testid="location-date"]',
    image: 'img',
    link: 'a[href]',
    publishDate: '[data-testid="location-date"] span:last-child',
    nextPage: '[data-testid="pagination-forward"]',
    totalCount: '[data-testid="total-count"]',
  },
  detail: {
    title: '[data-testid="offer_title"]',
    price: '[data-testid="ad-price-container"]',
    description: '[data-testid="ad_description"]',
    images: '.swiper-slide img',
    location: '[data-testid="map-aside-section"]',
    publishDate: '[data-testid="ad-posted-at"]',
    seller: {
      name: '[data-testid="user-profile-user-name"]',
      phone: '[data-testid="phones-container"]',
      verified: '[data-testid="trader-title"]',
      memberSince: '[data-testid="member-since"]',
    },
    category: '.breadcrumb-item:last-child',
    attributes: '[data-cy="ad-params"] li',
  },
};

/** Ordered replacements folding a language's diacritics down to ASCII. */
type DiacriticFolding = ReadonlyArray<readonly [RegExp, string]>;

const POLISH_FOLDING: DiacriticFolding = [
  [/ą/g, 'a'],
  [/ć/g, 'c'],
  [/ę/g, 'e'],
  [/ł/g, 'l'],
  [/ń/g, 'n'],
  [/ó/g, 'o'],
  [/ś/g, 's'],
  [/ź/g, 'z'],
  [/ż/g, 'z'],
];

const ROMANIAN_FOLDING: DiacriticFolding = [
  [/ă/g, 'a'],
  [/â/g, 'a'],
  [/î/g, 'i'],
  [/ș/g, 's'],
  [/ț/g, 't'],
];

const PORTUGUESE_BR_FOLDING: DiacriticFolding = [
  [/[áàâãä]/g, 'a'],
  [/[éèê]/g, 'e'],
  [/[íì]/g, 'i'],
  [/[óòôõ]/g, 'o'],
  [/[úùü]/g, 'u'],
  [/ç/g, 'c'],
  [/ñ/g, 'n'],
];

const fold = (value: string, folding: DiacriticFolding): string =>
  folding.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);

/**
 * Folding runs before punctuation is dropped, otherwise the strip would delete
 * the accented characters outright and the folding would never apply.
 *
 * Letters outside the ASCII range that no folding table covers — Cyrillic on
 * olx.ua and olx.bg — are percent-encoded rather than removed. Deleting them
 * produced an empty "q-" slug, and OLX answers that with its unfiltered
 * all-ads page, so every Cyrillic search silently returned arbitrary listings.
 */
const slugifyQuery = (query: string, folding: DiacriticFolding): string => {
  const slug = fold(query.toLowerCase(), folding)
    // Keep letters and digits of any script; drop punctuation only.
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return /^[a-z0-9-]*$/.test(slug) ? slug : encodeURIComponent(slug);
};

const slugifyLocation = (location: string, folding: DiacriticFolding): string =>
  fold(location.toLowerCase().replace(/\s+/g, '-'), folding);

/**
 * OLX addresses searches either as /<location>/q-<query>/ or, with no location,
 * as <listingPath>q-<query>/ — where listingPath is the domain's "all ads" path.
 */
const buildSearchPath =
  (listingPath: string, folding: DiacriticFolding = []) =>
  (location?: string, query?: string): string => {
    if (location) {
      const base = `/${slugifyLocation(location, folding)}`;
      return query ? `${base}/q-${slugifyQuery(query, folding)}/` : `${base}/`;
    }
    return query ? `${listingPath}q-${slugifyQuery(query, folding)}/` : listingPath;
  };

/** Identical on every European domain observed so far. */
const COMMON_URL_PARAMS = {
  priceParams: {
    min: 'search[filter_float_price:from]',
    max: 'search[filter_float_price:to]',
  },
  sortParams: {
    date: { param: 'search[order]', value: 'created_at:desc' },
    'price-asc': { param: 'search[order]', value: 'filter_float_price:asc' },
    'price-desc': { param: 'search[order]', value: 'filter_float_price:desc' },
  },
  categoryParam: 'c',
  pageParam: 'page',
} as const;

/**
 * olx.com.br addresses a search entirely through the path plus a `q` parameter:
 * /<category>/<state>/<region>?q=... — in that order. A category placed after a
 * location is silently ignored (/estado-sp/celulares returns every São Paulo
 * ad), which is why the two are not interchangeable here.
 *
 * With neither, the site expects the literal /brasil.
 */
const BRAZIL_ALL_ADS_PATH = '/brasil';

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
  'olx.pt': {
    domain: 'olx.pt',
    baseUrl: 'https://www.olx.pt',
    currency: 'EUR',
    language: 'pt',
    selectors: COMMON_SELECTORS,
    urlPatterns: { searchPath: buildSearchPath('/ads/'), ...COMMON_URL_PARAMS },
  },

  'olx.pl': {
    domain: 'olx.pl',
    baseUrl: 'https://www.olx.pl',
    currency: 'PLN',
    language: 'pl',
    selectors: COMMON_SELECTORS,
    urlPatterns: { searchPath: buildSearchPath('/oferty/', POLISH_FOLDING), ...COMMON_URL_PARAMS },
  },

  'olx.bg': {
    domain: 'olx.bg',
    baseUrl: 'https://www.olx.bg',
    currency: 'BGN',
    language: 'bg',
    selectors: COMMON_SELECTORS,
    urlPatterns: { searchPath: buildSearchPath('/ads/'), ...COMMON_URL_PARAMS },
  },

  'olx.ro': {
    domain: 'olx.ro',
    baseUrl: 'https://www.olx.ro',
    currency: 'RON',
    language: 'ro',
    selectors: COMMON_SELECTORS,
    urlPatterns: { searchPath: buildSearchPath('/ads/', ROMANIAN_FOLDING), ...COMMON_URL_PARAMS },
  },

  'olx.ua': {
    domain: 'olx.ua',
    baseUrl: 'https://www.olx.ua',
    currency: 'UAH',
    language: 'uk',
    selectors: COMMON_SELECTORS,
    urlPatterns: { searchPath: buildSearchPath('/ads/'), ...COMMON_URL_PARAMS },
  },

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
