import { Browser, Page } from 'playwright';
import { NonRetryableError } from '../base/scraper.interface.js';
import { BaseOlxScraper, DetailReadOptions } from './base-olx.scraper.js';
import { Listing, ListingId, SearchFilters, SellerInfo } from '../../core/types.js';
import { formatBrl, parseCardDate, parseSellerFromLines, stripHtml } from './br-parsers.js';

/**
 * OLX Brazil. Despite the shared brand this is not the European OLX
 * application: the pages are a separate Next.js frontend with build-hashed
 * styled-components class names, so nothing on a listing page can be addressed
 * by a durable CSS selector.
 *
 * What it does ship is structured data — a schema.org Product block and a GTM
 * dataLayer entry — and those are what this scraper reads. Everything that
 * lives only in the markup (seller, location) is found by anchoring on its
 * visible Portuguese label rather than on a class name.
 */
export class OLXBRScraper extends BaseOlxScraper {
  /**
   * olx.com.br stops paginating at 5.000 results. Asking for `o=101` does not
   * error — it silently serves page 100 again, so a caller paging blindly would
   * read the same 50 ads forever and believe they were new ones.
   */
  private static readonly MAX_PAGE = 100;

  constructor(browser: Browser) {
    super('olx.com.br', browser);
  }

  protected override buildSearchUrl(filters: SearchFilters): string {
    const page = filters.page ?? 1;
    if (page > OLXBRScraper.MAX_PAGE) {
      throw new NonRetryableError(
        `olx.com.br paginates only up to page ${OLXBRScraper.MAX_PAGE} (5.000 results) and ` +
          `serves page ${OLXBRScraper.MAX_PAGE} again for anything beyond it. Narrow the search ` +
          `with a category, location or price range instead of paging past ${OLXBRScraper.MAX_PAGE}.`
      );
    }
    return super.buildSearchUrl(filters);
  }

  /** Ad URLs end in the numeric id: /celulares/iphone-11-128gb-1528464732 */
  protected override extractListingId(url: string): ListingId {
    const match = url.match(/-(\d{6,})(?:[/?#]|$)/);
    if (match?.[1]) return match[1] as ListingId;
    return super.extractListingId(url);
  }

  /**
   * The pagination controls carry only design-system classes shared with every
   * other button on the page, so there is nothing there to match on. The result
   * header states the range outright — "1 - 50 de 102.078 resultados" — which
   * gives both the count and whether anything follows in one read.
   */
  protected override async extractPaginationInfo(
    page: Page,
    currentPage: number,
    cardCount: number
  ) {
    const header = await page
      .$eval(this.domainConfig.selectors.search.totalCount, el => el.textContent || '')
      .catch(() => '');

    const range = header.match(/([\d.]+)\s*-\s*([\d.]+)\s+de\s+([\d.]+)/);
    const digits = (value: string) => parseInt(value.replace(/\D/g, ''), 10) || 0;

    // A single hit renders "1 - 1 de 1 resultados"; a search with none renders
    // "0 resultados" and matches no range at all.
    const totalCount = range?.[3] ? digits(range[3]) : digits(header);
    const rangeEnd = range?.[2] ? digits(range[2]) : cardCount;

    const itemsPerPage = cardCount || 50;
    const totalPages = Math.min(
      Math.max(Math.ceil(totalCount / itemsPerPage), 1),
      OLXBRScraper.MAX_PAGE
    );

    return {
      totalCount,
      currentPage,
      totalPages,
      hasNextPage: rangeEnd < totalCount && currentPage < OLXBRScraper.MAX_PAGE,
    };
  }

  /**
   * There is no id-only ad URL on olx.com.br — /anuncio/<id> and friends all
   * fall through to the homepage — but searching for the bare id returns the
   * single ad carrying it, and that card's href is the canonical URL.
   */
  protected override async findListingUrl(listingId: ListingId, page: Page): Promise<string> {
    const { baseUrl, selectors, urlPatterns } = this.domainConfig;
    const searchUrl = new URL(urlPatterns.searchPath(), baseUrl);
    searchUrl.searchParams.set(urlPatterns.queryParam ?? 'q', listingId);

    try {
      await page.goto(searchUrl.toString(), { waitUntil: this.waitUntil, timeout: 15000 });

      const href = await page
        .$$eval(
          selectors.search.link,
          (anchors, needle) =>
            anchors.map(a => a.getAttribute('href') || '').find(h => h.endsWith(needle)) || '',
          `-${listingId}`
        )
        .catch(() => '');

      if (href) return new URL(href, baseUrl).toString();
    } catch {
      // An unreachable search page just means no URL was found.
    }

    return '';
  }

  protected override async extractListingDetail(
    page: Page,
    listingId: ListingId,
    url: string,
    options: DetailReadOptions = {}
  ): Promise<Listing> {
    // The seller card is client-rendered, so it is absent at domcontentloaded —
    // as long as this domain's navigation waits — and absent forever on a page
    // fetched as HTML. Waiting only makes sense in the first case; in the second
    // it would burn the timeout on every ad to learn nothing.
    if (options.hydrated) {
      // Best-effort even then: an ad whose seller block never appears still
      // yields everything the JSON-LD carries, so a timeout is not a failure.
      await page
        .waitForFunction(() => /Na OLX desde/.test(document.body.innerText), undefined, {
          timeout: 10000,
        })
        .catch(() => {});
    }

    const raw = await page.evaluate(() => {
      interface JsonLdProduct {
        '@type'?: string;
        name?: string;
        description?: string;
        url?: string;
        offers?: { price?: string };
        image?: Array<{ contentUrl?: string } | string>;
      }

      interface GtmEntry {
        page?: { detail?: { adDate?: number } };
      }

      /** The schema.org Product block: title, description, price and images. */
      const product = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      ).reduce<JsonLdProduct | undefined>((found, script) => {
        if (found) return found;
        try {
          const parsed = JSON.parse(script.textContent || '') as JsonLdProduct;
          return parsed['@type'] === 'Product' ? parsed : undefined;
        } catch {
          return undefined;
        }
      }, undefined);

      /**
       * GTM's entry carries the publish timestamp. It is read from the live
       * dataLayer when the page ran its scripts, and out of the script's own text
       * when it did not — which is the case for a page fetched as HTML, where
       * nothing ever assigns window.dataLayer.
       */
      const gtmEntries = (window as unknown as { dataLayer?: GtmEntry[] }).dataLayer ?? [];
      const liveDetail = gtmEntries.reduce<{ adDate?: number } | undefined>(
        (found, entry) => found ?? entry?.page?.detail,
        undefined
      );

      const adDateFromMarkup = (): number | undefined => {
        for (const script of Array.from(document.scripts)) {
          const match = script.textContent?.match(/"adDate"\s*:\s*(\d{9,})/);
          if (match?.[1]) return Number(match[1]);
        }
        return undefined;
      };

      const gtmDetail = liveDetail ?? { adDate: adDateFromMarkup() };

      /**
       * The seller's name, from the ad payload embedded in the markup.
       *
       * Worth reading separately because the seller card it normally comes from
       * hydrates on the client, so an HTML-only read would otherwise lose it. The
       * payload is JSON inside a script, sometimes doubly escaped, hence the
       * optional backslashes.
       *
       * The join date and the rating are genuinely not here — checked against the
       * markup and against the payload's own `user` object, which carries an id, a
       * name and settings and nothing dated.
       */
      const sellerNameFromMarkup = (): string | undefined => {
        for (const script of Array.from(document.scripts)) {
          // String.raw so the backslashes survive: this payload is JSON inside a
          // script and is sometimes escaped a second time, so the quote around the
          // value may or may not be preceded by one.
          const pattern = new RegExp(String.raw`sellerName\\?"\s*:\s*\\?"([^"\\]{2,80})`);
          const match = script.textContent?.match(pattern);
          if (match?.[1]) return match[1];
        }
        return undefined;
      };

      /**
       * The "Detalhes" block pairs a `typo-overline` label with its value in the
       * next sibling. Those typography classes come from the design system, not
       * from the build, so they outlive a deploy.
       */
      const attributes: Record<string, string> = {};
      document.querySelectorAll('span.typo-overline').forEach(label => {
        const key = label.textContent?.trim();
        const value = label.nextElementSibling?.textContent?.trim();
        if (key && value) attributes[key] = value;
      });

      const linesOf = (element: Element): string[] =>
        ((element as HTMLElement).innerText || '')
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);

      const leafWith = (matches: (text: string) => boolean): Element | undefined =>
        Array.from(document.querySelectorAll('span, p, h1, h2, h3, h4, div')).find(
          element => element.children.length === 0 && matches(element.textContent?.trim() || '')
        );

      /**
       * Reads the block introduced by a visible heading — the only stable handle
       * on sections whose own classes are build-hashed. Walks outward from the
       * heading until an ancestor holds something besides the heading itself.
       */
      const sectionUnder = (heading: string): string | undefined => {
        const found = leafWith(text => text === heading);
        let node: Element | null = found?.parentElement ?? null;
        for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
          const rest = linesOf(node).filter(line => line !== heading);
          if (rest.length > 0) return rest.join(', ');
        }
        return undefined;
      };

      const images = (product?.image ?? [])
        .map(entry => (typeof entry === 'string' ? entry : entry?.contentUrl))
        .filter((value): value is string => Boolean(value));

      return {
        title: product?.name || '',
        description: product?.description || '',
        canonicalUrl: product?.url || '',
        priceAmount: product?.offers?.price ?? '',
        images,
        attributes,
        location: sectionUnder('Localização'),
        // The seller card is parsed out of this in Node — see parseSellerFromLines.
        bodyLines: linesOf(document.body),
        publishedAtUnix: typeof gtmDetail?.adDate === 'number' ? gtmDetail.adDate : undefined,
        sellerNameFromMarkup: sellerNameFromMarkup(),
      };
    });

    if (!raw.title) {
      throw new NonRetryableError(
        `No schema.org Product data on ${url} — the ad may have been removed, or olx.com.br ` +
          `stopped embedding it.`
      );
    }

    return {
      id: listingId,
      title: raw.title,
      price: formatBrl(raw.priceAmount),
      location: raw.location,
      category: raw.attributes['Categoria'],
      description: stripHtml(raw.description),
      url: raw.canonicalUrl || url,
      imageUrl: raw.images[0],
      imageUrls: raw.images.length > 0 ? raw.images : undefined,
      attributes: Object.keys(raw.attributes).length > 0 ? raw.attributes : undefined,
      publishedAt:
        raw.publishedAtUnix !== undefined ? new Date(raw.publishedAtUnix * 1000) : undefined,
      seller: mergeSeller(parseSellerFromLines(raw.bodyLines), raw.sellerNameFromMarkup),
    };
  }

  /** Cards date themselves relatively: "Hoje, 21:26", "Ontem, 12:58", "21/08". */
  protected override parsePublishedAt(text: string): Date | undefined {
    return parseCardDate(text, new Date());
  }
}

/**
 * Folds in a name read from the markup, for the HTML-only path where the seller
 * card never rendered. Never overrides what the card itself said.
 */
export const mergeSeller = (
  fromCard: SellerInfo | undefined,
  nameFromMarkup: string | undefined
): SellerInfo | undefined => {
  if (!nameFromMarkup) return fromCard;
  if (!fromCard) return { name: nameFromMarkup };
  return fromCard.name ? fromCard : { ...fromCard, name: nameFromMarkup };
};
