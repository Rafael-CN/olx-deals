import { z } from 'zod';

export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

export type Brand<T, K> = T & { readonly __brand: K };

export type ListingId = Brand<string, 'ListingId'>;
export type CategoryId = Brand<string, 'CategoryId'>;
export type LocationId = Brand<string, 'LocationId'>;
export type OlxDomain = 'olx.pt' | 'olx.pl' | 'olx.bg' | 'olx.ro' | 'olx.ua' | 'olx.com.br';

export type SortBy = 'relevance' | 'date' | 'price-asc' | 'price-desc';

export interface MCPTool<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodSchema<TArgs>;
  execute(args: TArgs, signal?: AbortSignal): Promise<Result<TResult>>;
}

export interface ScraperConfig {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly retries: number;
  readonly userAgent?: string | undefined;
  readonly headless?: boolean | undefined;
}

export interface DomainConfig {
  readonly domain: OlxDomain;
  readonly baseUrl: string;
  readonly currency: string;
  readonly language: string;
  readonly selectors: DomainSelectors;
  readonly urlPatterns: DomainUrlPatterns;
  /**
   * How long to wait for a page load. Defaults to 'networkidle', which the
   * European domains reach; olx.com.br never does — its ad and analytics
   * traffic keeps the connection busy indefinitely — so it settles for
   * 'domcontentloaded', which is enough because its listing cards are
   * server-rendered.
   */
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined;
}

export interface SearchSelectors {
  readonly listingCard: string;
  readonly title: string;
  readonly price: string;
  readonly location: string;
  readonly image: string;
  readonly link: string;
  readonly publishDate: string;
  readonly nextPage: string;
  readonly totalCount: string;
}

export interface DetailSelectors {
  readonly title: string;
  readonly price: string;
  readonly description: string;
  readonly images: string;
  readonly location: string;
  readonly publishDate: string;
  readonly seller: {
    readonly name: string;
    readonly phone: string;
    readonly verified: string;
    readonly memberSince: string;
  };
  readonly category: string;
  readonly attributes: string;
}

export interface DomainSelectors {
  readonly search: SearchSelectors;
  /**
   * Absent on domains whose detail page carries no stable selectors and is read
   * another way instead — olx.com.br ships hashed styled-components class names
   * and is parsed from its JSON-LD payload by OLXBRScraper.
   */
  readonly detail?: DetailSelectors | undefined;
}

/**
 * The European domains express every sort order through one parameter
 * (`search[order]`); olx.com.br uses a different parameter per order (`sf` for
 * date, `sp` for price), so the name travels with the value.
 */
export interface SortParam {
  readonly param: string;
  readonly value: string;
}

export interface DomainUrlPatterns {
  /**
   * The European domains address a category through the query string, so
   * `category` is ignored there; olx.com.br carries it as the first path
   * segment and builds it in here.
   */
  readonly searchPath: (location?: string, query?: string, category?: string) => string;
  readonly priceParams: {
    readonly min: string;
    readonly max: string;
  };
  readonly sortParams: Record<'date' | 'price-asc' | 'price-desc', SortParam>;
  /** Absent on domains that keep the category in the path instead. */
  readonly categoryParam?: string | undefined;
  /**
   * Set when the domain takes the search term as a query-string parameter
   * (olx.com.br's `q`) rather than as a path slug; `searchPath` ignores the
   * query on those domains.
   */
  readonly queryParam?: string | undefined;
  readonly pageParam: string;
}

export interface Listing {
  readonly id: ListingId;
  readonly title: string;
  readonly price?: string | undefined;
  readonly location?: string | undefined;
  readonly category?: string | undefined;
  readonly imageUrl?: string | undefined;
  readonly url: string;
  readonly publishedAt?: Date | undefined;
  readonly description?: string | undefined;
  readonly seller?: SellerInfo | undefined;
  /** Ad-specific fields ("Marca", "Condicao", ...), when the domain exposes them. */
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  readonly imageUrls?: readonly string[] | undefined;
}

export interface SellerInfo {
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly verified?: boolean | undefined;
  readonly memberSince?: Date | undefined;
}

export interface SearchFilters {
  readonly domain: OlxDomain;
  readonly query?: string | undefined;
  readonly category?: CategoryId | undefined;
  readonly location?: LocationId | undefined;
  readonly minPrice?: number | undefined;
  readonly maxPrice?: number | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
  readonly sortBy?: SortBy | undefined;
}

export interface Category {
  readonly id: CategoryId;
  readonly name: string;
  readonly slug: string;
  readonly parentId?: CategoryId;
  readonly subcategories?: Category[];
}

export interface Location {
  readonly id: LocationId;
  readonly name: string;
  readonly slug: string;
  readonly parentId?: LocationId;
  readonly type: 'district' | 'municipality' | 'parish';
}

export interface SearchResult {
  readonly listings: Listing[];
  readonly totalCount: number;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
}

export const createResult = <T>(data: T): Result<T> => ({
  success: true,
  data,
});

export const createError = <T>(error: Error | string): Result<T> => ({
  success: false,
  error: error instanceof Error ? error : new Error(error),
});

export const isSuccess = <T, E>(result: Result<T, E>): result is { success: true; data: T } =>
  result.success;

export const isError = <T, E>(result: Result<T, E>): result is { success: false; error: E } =>
  !result.success;
