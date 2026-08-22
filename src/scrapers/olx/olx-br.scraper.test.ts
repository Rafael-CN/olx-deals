import { describe, it, expect, beforeEach } from 'vitest';
import type { Browser, Page } from 'playwright';

import { OLXBRScraper } from './olx-br.scraper.js';
import { getDomainConfig } from './domain-config.js';
import {
  createPlaywrightMocks,
  resetPlaywrightMocks,
} from '../../../tests/mocks/playwright.mock.js';
import type { ListingId, SearchFilters } from '../../core/types.js';

/**
 * Exposes the protected URL and parsing hooks. Everything asserted here is
 * pure — no page is loaded — which keeps the URL grammar of olx.com.br pinned
 * down without reaching the network.
 */
class TestableOLXBRScraper extends OLXBRScraper {
  buildUrl(filters: SearchFilters): string {
    return this.buildSearchUrl(filters);
  }

  idFrom(url: string): ListingId {
    return this.extractListingId(url);
  }

  paginationFrom(header: string, currentPage: number, cardCount: number) {
    // extractPaginationInfo reads exactly one selector; a stub page is enough.
    const page = { $eval: async () => header } as unknown as Page;
    return this.extractPaginationInfo(page, currentPage, cardCount);
  }
}

const filters = (overrides: Partial<SearchFilters> = {}): SearchFilters => ({
  domain: 'olx.com.br',
  ...overrides,
});

describe('OLXBRScraper', () => {
  let scraper: TestableOLXBRScraper;
  let mockBrowser: Browser;

  beforeEach(() => {
    resetPlaywrightMocks();
    mockBrowser = createPlaywrightMocks().browser;
    scraper = new TestableOLXBRScraper(mockBrowser);
  });

  describe('domain configuration', () => {
    it('is registered as a Brazilian domain', () => {
      const config = getDomainConfig('olx.com.br');
      expect(config.baseUrl).toBe('https://www.olx.com.br');
      expect(config.currency).toBe('BRL');
      expect(config.language).toBe('pt-BR');
    });

    it('declares no detail selectors, because the scraper reads JSON-LD instead', () => {
      expect(getDomainConfig('olx.com.br').selectors.detail).toBeUndefined();
    });
  });

  describe('search URL', () => {
    it('falls back to /brasil when neither category nor location is given', () => {
      expect(scraper.buildUrl(filters({ query: 'iphone' }))).toBe(
        'https://www.olx.com.br/brasil?q=iphone'
      );
    });

    it('takes the query as a parameter rather than a path slug', () => {
      expect(scraper.buildUrl(filters({ query: 'placa de vídeo' }))).toBe(
        'https://www.olx.com.br/brasil?q=placa+de+v%C3%ADdeo'
      );
    });

    it('puts the category before the location, which is the only order the site honours', () => {
      expect(
        scraper.buildUrl(
          filters({
            query: 'iphone',
            category: 'celulares' as SearchFilters['category'],
            location: 'estado-sp/sao-paulo-e-regiao' as SearchFilters['location'],
          })
        )
      ).toBe('https://www.olx.com.br/celulares/estado-sp/sao-paulo-e-regiao?q=iphone');
    });

    it('expands a bare UF into a state segment', () => {
      expect(scraper.buildUrl(filters({ location: 'SP' as SearchFilters['location'] }))).toBe(
        'https://www.olx.com.br/estado-sp'
      );
    });

    it('slugifies an accented region name', () => {
      expect(
        scraper.buildUrl(filters({ location: 'São Paulo e Região' as SearchFilters['location'] }))
      ).toBe('https://www.olx.com.br/sao-paulo-e-regiao');
    });

    it('never emits the European category parameter', () => {
      const url = scraper.buildUrl(
        filters({ category: 'celulares' as SearchFilters['category'], query: 'iphone' })
      );
      expect(url).not.toContain('c=');
      expect(url).toBe('https://www.olx.com.br/celulares?q=iphone');
    });

    it('uses ps/pe for the price range', () => {
      const url = scraper.buildUrl(filters({ query: 'iphone', minPrice: 500, maxPrice: 2000 }));
      expect(url).toContain('ps=500');
      expect(url).toContain('pe=2000');
    });

    it('uses a different sort parameter per order, as the site does', () => {
      expect(scraper.buildUrl(filters({ query: 'x', sortBy: 'date' }))).toContain('sf=1');
      expect(scraper.buildUrl(filters({ query: 'x', sortBy: 'price-asc' }))).toContain('sp=1');
      expect(scraper.buildUrl(filters({ query: 'x', sortBy: 'price-desc' }))).toContain('sp=5');
    });

    it('leaves relevance unparameterised', () => {
      const url = scraper.buildUrl(filters({ query: 'x', sortBy: 'relevance' }));
      expect(url).not.toContain('sf=');
      expect(url).not.toContain('sp=');
    });

    it('pages with o, and omits it on the first page', () => {
      expect(scraper.buildUrl(filters({ query: 'x', page: 1 }))).not.toContain('o=');
      expect(scraper.buildUrl(filters({ query: 'x', page: 3 }))).toContain('o=3');
    });

    it('refuses to page past 100, where the site silently repeats page 100', () => {
      expect(() => scraper.buildUrl(filters({ query: 'x', page: 101 }))).toThrow(/page 100/);
    });
  });

  describe('listing id', () => {
    it('reads the trailing numeric id of an ad URL', () => {
      expect(
        scraper.idFrom(
          'https://sp.olx.com.br/sao-paulo-e-regiao/celulares/iphone-11-128gb-1528464732'
        )
      ).toBe('1528464732');
    });

    it('ignores a trailing query string or fragment', () => {
      expect(scraper.idFrom('https://sp.olx.com.br/celulares/iphone-11-1528464732?utm=x')).toBe(
        '1528464732'
      );
    });

    it('is not fooled by short numbers inside the slug', () => {
      expect(scraper.idFrom('https://sp.olx.com.br/celulares/iphone-11-128gb-1528464732')).toBe(
        '1528464732'
      );
    });

    it('falls back to a derived id when the href carries none', () => {
      const id = scraper.idFrom('https://www.olx.com.br/promoted-slot');
      expect(id).toMatch(/^u[a-z0-9]+$/);
    });
  });

  describe('pagination', () => {
    it('reads the total from the result range, not the first number in it', async () => {
      const pagination = await scraper.paginationFrom('1 - 50 de 102.078 resultados', 1, 50);
      expect(pagination.totalCount).toBe(102078);
      expect(pagination.hasNextPage).toBe(true);
    });

    it('reports no next page once the range reaches the total', async () => {
      const pagination = await scraper.paginationFrom('1 - 1 de 1 resultados', 1, 1);
      expect(pagination.totalCount).toBe(1);
      expect(pagination.totalPages).toBe(1);
      expect(pagination.hasNextPage).toBe(false);
    });

    it('handles a search with no hits, which renders no range at all', async () => {
      const pagination = await scraper.paginationFrom('0 resultados', 1, 0);
      expect(pagination.totalCount).toBe(0);
      expect(pagination.hasNextPage).toBe(false);
    });

    it('caps totalPages at the 100 pages the site will actually serve', async () => {
      const pagination = await scraper.paginationFrom('1 - 50 de 102.078 resultados', 1, 50);
      expect(pagination.totalPages).toBe(100);
    });

    it('stops offering a next page at the cap, even with results left', async () => {
      const pagination = await scraper.paginationFrom(
        '4.951 - 5.000 de 102.078 resultados',
        100,
        50
      );
      expect(pagination.hasNextPage).toBe(false);
    });
  });
});
