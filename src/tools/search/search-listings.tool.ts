import { BaseTool } from '../base/base-tool.js';
import {
  SearchListingsArgsSchema,
  SearchListingsArgs,
} from '../../validation/schemas/listing.schema.js';
import { SearchResult, SearchFilters } from '../../core/types.js';
import { OlxScraperFactory } from '../../scrapers/olx/scraper.factory.js';

export class SearchListingsTool extends BaseTool<SearchListingsArgs, SearchResult> {
  readonly name = 'searchListings';
  readonly description =
    'Search for listings on OLX domains (olx.pt, olx.pl, olx.bg, olx.ro, olx.ua, olx.com.br) ' +
    'with filters for query, category, location and price range. On olx.com.br, category and ' +
    'location are site slugs: category is a path such as "celulares" or ' +
    '"autos-e-pecas/carros-vans-e-utilitarios", and location is a state ("SP" or "estado-sp"), ' +
    'a region ("sao-paulo-e-regiao") or both ("estado-sp/sao-paulo-e-regiao"). Brazilian ' +
    'results stop at page 100 (5.000 ads), so narrow the filters rather than paging further.';
  readonly inputSchema = SearchListingsArgsSchema;

  constructor(private readonly scraperFactory: OlxScraperFactory) {
    super();
  }

  protected async executeImpl(
    args: SearchListingsArgs,
    signal?: AbortSignal
  ): Promise<SearchResult> {
    const scraper = this.scraperFactory.getScraper(args.domain);

    const filters: SearchFilters = {
      domain: args.domain,
      query: args.query,
      category: args.category as any, // Will be properly typed when we have CategoryId conversion
      location: args.location as any, // Will be properly typed when we have LocationId conversion
      minPrice: args.minPrice,
      maxPrice: args.maxPrice,
      page: args.page,
      limit: args.limit,
      sortBy: args.sortBy,
    };

    const result = await scraper.scrape(filters, signal);

    if (!result.success) {
      throw result.error;
    }

    return result.data;
  }
}
