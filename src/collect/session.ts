import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Browser, BrowserContext, Page, chromium } from 'playwright';

/**
 * The user agent the scrapers have always sent. It is pinned here because it is
 * load-bearing rather than cosmetic: probing olx.com.br with Playwright's
 * default agent draws a Cloudflare 403 where this one is served normally.
 */
export const OLX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export interface SessionOptions {
  readonly dataDir: string;
  readonly pages: number;
  readonly headless?: boolean;
  /** Use the installed Google Chrome instead of Playwright's bundled build. */
  readonly channel?: string | undefined;
  /**
   * Drop image, font and media requests. Cuts total requests by roughly an order
   * of magnitude and costs nothing — every field read here comes from text or
   * from JSON in the markup, and `img` elements keep their src either way.
   *
   * Left switchable because it cuts both ways: fewer requests means less rate
   * pressure, but a browser that never loads a picture also looks less like a
   * browser. Turn it off if blocks persist.
   */
  readonly blockAssets?: boolean | undefined;
}

/**
 * One browser, one context, a small pool of pages — held open for the whole run.
 *
 * This exists because the obvious thing does not work at scale. Opening a page
 * per request throws away the cookies OLX's edge issues, including the clearance
 * one, so every request arrives cold and a few thousand cold requests is a
 * reliable way to get blocked. Keeping one context alive, and persisting its
 * state to disk between runs, means a resumed sweep starts already trusted.
 */
export class BrowserSession {
  private readonly available: Page[] = [];
  private readonly waiting: Array<(page: Page) => void> = [];

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly statePath: string,
    pages: Page[]
  ) {
    this.available.push(...pages);
  }

  static async open(options: SessionOptions): Promise<BrowserSession> {
    const statePath = join(options.dataDir, 'browser-state.json');
    mkdirSync(dirname(statePath), { recursive: true });

    const browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(options.channel ? { channel: options.channel } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: OLX_USER_AGENT,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1366, height: 900 },
      ...(readState(statePath) ?? {}),
    });
    context.setDefaultTimeout(45_000);

    if (options.blockAssets ?? true) {
      await context.route('**/*', route => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'media') return route.abort();
        return route.continue();
      });
    }

    const pages = await Promise.all(
      Array.from({ length: Math.max(1, options.pages) }, () => context.newPage())
    );

    return new BrowserSession(browser, context, statePath, pages);
  }

  /**
   * The underlying browser, for code that legitimately needs it — the scrapers
   * take one in their constructor even though a bulk run drives them through
   * pages this session owns.
   */
  get playwrightBrowser(): Browser {
    return this.browser;
  }

  /** Checks out a page, runs the work, and returns the page to the pool. */
  async withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.take();
    try {
      return await work(page);
    } finally {
      this.give(page);
    }
  }

  /**
   * Persists cookies and storage so the next run inherits whatever trust this
   * one earned. Called periodically, not only at the end, because a run that
   * ends in a block should still leave its clearance behind.
   */
  async saveState(): Promise<void> {
    try {
      const state = await this.context.storageState();
      writeFileSync(this.statePath, JSON.stringify(state), 'utf8');
    } catch {
      // A session that cannot cache its state still works; it just starts cold.
    }
  }

  async close(): Promise<void> {
    await this.saveState();
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  private take(): Promise<Page> {
    const free = this.available.pop();
    if (free) return Promise.resolve(free);
    return new Promise(resolve => this.waiting.push(resolve));
  }

  private give(page: Page): void {
    const next = this.waiting.shift();
    if (next) next(page);
    else this.available.push(page);
  }
}

const readState = (path: string): { storageState: string } | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    // Parsed rather than passed through so a truncated file fails here, where it
    // can be ignored, instead of inside newContext.
    JSON.parse(readFileSync(path, 'utf8'));
    return { storageState: path };
  } catch {
    return undefined;
  }
};
