import { BrowserContext, Page } from 'playwright';

export interface FetchOutcome {
  readonly status: number;
  readonly html: string;
  readonly url: string;
  /** Seconds the server asked us to wait, when it said so. */
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Fetches pages as HTML over HTTP and parses them in a DOM that never touches
 * the network.
 *
 * This exists because loading an OLX page in a browser is not one request. The
 * document arrives, then Next.js chunks, then analytics, then ad slots, then the
 * page's own API calls — dozens of hits, many of them to olx.com.br itself, for
 * every single ad read. Counting that as "one request" is how a run that looks
 * gentle gets rate-limited in a minute.
 *
 * Everything the collector needs is in the server-rendered HTML: the search page
 * ships all 50 cards, and the ad page ships its schema.org Product block. So the
 * document is fetched on its own — one request, no scripts — and handed to a
 * throwaway page with JavaScript disabled, which gives the existing selectors a
 * real DOM to work against for free.
 *
 * The one thing genuinely not in the HTML is the seller card, which hydrates on
 * the client. Paying for a full page load is therefore a decision the caller
 * makes per ad, not the default for all of them.
 */
export class HtmlFetcher {
  private requests = 0;
  private bytes = 0;

  private constructor(
    private readonly context: BrowserContext,
    private readonly parser: Page
  ) {}

  /**
   * `parserContext` must have JavaScript disabled and all routes aborted; it
   * only ever renders HTML that has already been fetched.
   */
  static async create(
    context: BrowserContext,
    parserContext: BrowserContext
  ): Promise<HtmlFetcher> {
    const parser = await parserContext.newPage();
    return new HtmlFetcher(context, parser);
  }

  /** One HTTP request, sharing the browser context's cookies and headers. */
  async get(url: string): Promise<FetchOutcome> {
    this.requests += 1;

    const response = await this.context.request.get(url, {
      // Redirects are followed, but a failure must come back as a status rather
      // than an exception so the governor can tell a block from a crash.
      failOnStatusCode: false,
      timeout: 45_000,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });

    const html = await response.text().catch(() => '');
    this.bytes += html.length;

    const retryAfter = response.headers()['retry-after'];
    const parsed = retryAfter ? Number(retryAfter) : Number.NaN;

    return {
      status: response.status(),
      html,
      url: response.url(),
      ...(Number.isFinite(parsed) ? { retryAfterSeconds: parsed } : {}),
    };
  }

  /**
   * Renders already-fetched HTML and runs an extractor over it. Costs nothing:
   * the parser context executes no JavaScript and its routes are all aborted, so
   * nothing on the page can reach out.
   */
  async parse<T>(outcome: FetchOutcome, extract: (page: Page) => Promise<T>): Promise<T> {
    // A base URL lets relative hrefs in the markup resolve the way they would
    // have on the real page.
    await this.parser.setContent(outcome.html, { waitUntil: 'domcontentloaded' });
    return await extract(this.parser);
  }

  get stats(): { requests: number; kilobytes: number } {
    return { requests: this.requests, kilobytes: Math.round(this.bytes / 1024) };
  }

  async close(): Promise<void> {
    await this.parser.close().catch(() => {});
  }
}

/**
 * Counts every request a real page load makes to OLX, so the cost of using a
 * browser instead of a plain fetch is a number rather than a guess.
 */
export class RequestMeter {
  private counts = new Map<string, number>();

  watch(page: Page): void {
    page.on('request', request => {
      const host = safeHost(request.url());
      if (!host.endsWith('olx.com.br')) return;
      this.counts.set(host, (this.counts.get(host) ?? 0) + 1);
    });
  }

  get total(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
  }

  get byHost(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort((a, b) => b[1] - a[1]));
  }
}

const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Cloudflare's block page, which arrives with a 403 and no useful body. */
export const looksBlocked = (outcome: FetchOutcome): boolean =>
  outcome.status === 403 ||
  outcome.status === 429 ||
  /Attention Required! \| Cloudflare|you have been blocked/i.test(outcome.html.slice(0, 4000));
