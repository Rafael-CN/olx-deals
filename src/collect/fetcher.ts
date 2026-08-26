import { BrowserContext, Page } from 'playwright';

export interface FetchOutcome {
  readonly status: number;
  readonly html: string;
  readonly url: string;
  /** Seconds the server asked us to wait, when it said so. */
  readonly retryAfterSeconds?: number | undefined;
  /** True when the bytes came from the browser's own HTTP cache. */
  readonly fromCache?: boolean | undefined;
}

/**
 * Fetches pages as HTML and parses them in a DOM that never touches the network.
 *
 * Two ideas, and the second one corrects the first.
 *
 * A browser navigation to an OLX page is not one request. The document arrives,
 * then Next.js chunks, then analytics, then ad slots, then the page's own API
 * calls — dozens of hits for every ad read. Everything this project needs is in
 * the server-rendered HTML, so fetching the document alone is one request, and a
 * throwaway page with JavaScript disabled gives the existing selectors a real DOM
 * for free.
 *
 * But *how* the document is fetched matters as much as how many. Fetching it from
 * Node — Playwright's `context.request` — sends Node's TLS handshake, Node's
 * HTTP/2 settings and hand-written headers, which is a different client from the
 * Chrome that earned the session's cookies. Fewer requests, each one less
 * consistent. So the fetch happens *inside* a page already on the target origin,
 * through the page's own `fetch()`: Chrome's TLS, Chrome's header set, Chrome's
 * cookie jar, Chrome's HTTP cache. One client, used consistently.
 *
 * The anchor for each origin is its own /robots.txt — a few hundred bytes, and a
 * document this project should be reading anyway.
 */
export class HtmlFetcher {
  private readonly anchors = new Map<string, Page>();
  private requests = 0;
  private cached = 0;
  private bytes = 0;
  private anchorLoads = 0;

  private constructor(
    private readonly context: BrowserContext,
    private readonly parser: Page,
    private readonly waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit',
    /**
     * Called before every network operation, anchor navigations included.
     *
     * This exists because anchoring used to bypass pacing entirely: reading ad
     * pages across the country means one navigation per state subdomain, and
     * thirteen of those fired back to back with nothing in between is what a
     * scanner looks like. Everything that touches the site goes through here.
     */
    private readonly gate: () => Promise<void>
  ) {}

  /**
   * `parserContext` must have JavaScript disabled and all routes aborted; it only
   * ever renders HTML that has already been fetched.
   */
  static async create(
    context: BrowserContext,
    parserContext: BrowserContext,
    gate: () => Promise<void> = async () => {},
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' = 'domcontentloaded'
  ): Promise<HtmlFetcher> {
    const parser = await parserContext.newPage();
    return new HtmlFetcher(context, parser, waitUntil, gate);
  }

  /**
   * One request for the document, issued by Chrome from the target origin.
   *
   * `fetch` participates in the browser's HTTP cache, so a page that has not
   * changed since a previous run can come back as a 304 or not leave the machine
   * at all — which is the cheapest possible request for both sides.
   */
  async get(url: string): Promise<FetchOutcome> {
    // Anchoring may hit the site itself, so it gates inside anchorFor; this gate
    // covers the document fetch that follows.
    const page = await this.anchorFor(new URL(url).origin);
    await this.gate();
    this.requests += 1;

    const outcome = await page.evaluate(async target => {
      try {
        const response = await fetch(target, { credentials: 'same-origin' });
        return {
          status: response.status,
          html: await response.text(),
          url: response.url,
          retryAfter: response.headers.get('retry-after'),
          // Chrome reports a cache hit as a zero-length transfer on the entry.
          fromCache: false,
        };
      } catch (error) {
        return {
          status: 0,
          html: '',
          url: target,
          retryAfter: null,
          fromCache: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }, url);

    if ('error' in outcome && outcome.error) {
      throw new Error(`fetch failed for ${url}: ${outcome.error}`);
    }

    this.bytes += outcome.html.length;
    if (outcome.fromCache) this.cached += 1;

    const parsed = outcome.retryAfter ? Number(outcome.retryAfter) : Number.NaN;
    return {
      status: outcome.status,
      html: outcome.html,
      url: outcome.url,
      ...(Number.isFinite(parsed) ? { retryAfterSeconds: parsed } : {}),
      ...(outcome.fromCache ? { fromCache: true } : {}),
    };
  }

  /**
   * A page parked on the origin, so `fetch` from it is same-origin and can read
   * the response. Created once per origin and kept — ad pages live on per-state
   * subdomains, so a nationwide sweep needs at most 27 of these.
   */
  private async anchorFor(origin: string): Promise<Page> {
    const existing = this.anchors.get(origin);
    if (existing && !existing.isClosed()) return existing;

    await this.gate();
    const page = await this.context.newPage();
    // robots.txt is the lightest document that establishes the origin, and it is
    // the one page a crawler has an actual reason to read first.
    const response = await page.goto(`${origin}/robots.txt`, { waitUntil: this.waitUntil });
    this.anchorLoads += 1;

    const status = response?.status();
    if (status !== undefined && (status === 403 || status === 429)) {
      await page.close().catch(() => {});
      throw new Error(
        `olx.com.br answered ${status} for ${origin}/robots.txt — blocked or rate-limited.`
      );
    }

    this.anchors.set(origin, page);
    return page;
  }

  /** The robots.txt already fetched while anchoring an origin. */
  async robotsFor(origin: string): Promise<string> {
    const page = await this.anchorFor(origin);
    return await page.evaluate(() => document.body?.innerText ?? '');
  }

  /**
   * Renders already-fetched HTML and runs an extractor over it. Costs nothing: the
   * parser context executes no JavaScript and its routes are all aborted, so
   * nothing on the page can reach out.
   */
  async parse<T>(outcome: FetchOutcome, extract: (page: Page) => Promise<T>): Promise<T> {
    await this.parser.setContent(outcome.html, { waitUntil: 'domcontentloaded' });
    return await extract(this.parser);
  }

  get stats(): {
    requests: number;
    kilobytes: number;
    cached: number;
    anchorLoads: number;
    origins: number;
  } {
    return {
      requests: this.requests,
      kilobytes: Math.round(this.bytes / 1024),
      cached: this.cached,
      anchorLoads: this.anchorLoads,
      origins: this.anchors.size,
    };
  }

  async close(): Promise<void> {
    await this.parser.close().catch(() => {});
    for (const page of this.anchors.values()) await page.close().catch(() => {});
    this.anchors.clear();
  }
}

/**
 * Counts every request the browser makes to OLX, so the cost of a page load is a
 * number rather than a guess.
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

  watchContext(context: BrowserContext): void {
    context.on('request', request => {
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
