import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, BrowserContext, Page } from 'playwright';
import { launchChromium } from '../../collect/launch.js';
import { OLXBRScraper } from './olx-br.scraper.js';
import { SearchFilters } from '../../core/types.js';

/**
 * Exercises the HTTP-only path: HTML in, listings out, without a navigation.
 *
 * This is the path that makes a large sweep affordable — one request per page
 * instead of the dozens a browser navigation fires — so it needs to be pinned
 * down independently of the live site. The fixtures reproduce the markup observed
 * on real olx.com.br pages, including the parts that are awkward: a struck-through
 * old price next to the asking price, a location split by an icon, and the
 * analytics blob that only exists as script text when JavaScript is off.
 */

const searchHtml = (cards: string, header = '1 - 50 de 102.078 resultados') => `
<html><body>
  <div class="TotalOfAds-module-scss-module__g77XzG__titleContainer">
    <h1>"s22 ultra" no Rio Grande do Sul</h1>
    <p class="typo-body-small">${header}</p>
  </div>
  <div id="ad-list">${cards}</div>
  <nav class="ListingPagination-module-scss-module__7MwcNa__wrapper">
    <a href="https://www.olx.com.br/estado-rs?q=s22+ultra&o=2">Mais anúncios</a>
  </nav>
</body></html>`;

const card = (opts: {
  id: string;
  title: string;
  price: string;
  oldPrice?: string;
  location: string;
  date: string;
  image?: string;
}) => `
  <section class="olx-adcard olx-adcard__horizontal" data-mode="horizontal">
    <div class="olx-adcard__content">
      <div class="olx-adcard__topbody">
        <a data-testid="adcard-link" class="olx-adcard__link" title="${opts.title}"
           href="https://rs.olx.com.br/regioes-de-porto-alegre/celulares/slug-${opts.id}">
          <h2 class="typo-body-large olx-adcard__title font-semibold">${opts.title}</h2>
        </a>
      </div>
      <div class="olx-adcard__mediumbody">
        ${opts.oldPrice ? `<p class="typo-caption olx-adcard__old-price">${opts.oldPrice}</p>` : ''}
        <h3 class="typo-body-large olx-adcard__price font-semibold">${opts.price}</h3>
        <div data-testid="adcard-price-info"><span class="typo-caption">em até 10x sem juros</span></div>
      </div>
      <div class="olx-adcard__bottombody">
        <div class="olx-adcard__location-date">
          <p class="typo-caption olx-adcard__location"><svg></svg>${opts.location}</p>
          <p class="typo-caption olx-adcard__date">${opts.date}</p>
        </div>
      </div>
    </div>
    <div class="olx-adcard__media">
      <picture><img src="${opts.image ?? `https://img.olx.com.br/thumbs700x500/${opts.id}.webp`}"></picture>
    </div>
  </section>`;

const detailHtml = `
<html><body>
  <script id="seo-product-script" type="application/ld+json">
    ${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      identifier: 1528464732,
      name: 'iPhone 11 128gb BARATO PARA SAIR RÁPIDO!',
      url: 'https://sp.olx.com.br/sao-paulo-e-regiao/celulares/iphone-11-128gb-1528464732',
      description: 'Celular iPhone 11 | 128gb <br><br>Funcionando tudo, só o Face ID está off.',
      image: [
        { '@type': 'ImageObject', contentUrl: 'https://img.olx.com.br/images/a.jpg' },
        { '@type': 'ImageObject', contentUrl: 'https://img.olx.com.br/images/b.jpg' },
      ],
      offers: { '@type': 'Offer', priceCurrency: 'BRL', price: '1000' },
    })}
  </script>
  <script id="datalayer">
    window.dataLayer = [{"page":{"pageType":"ad_detail","detail":{"adDate":1787358385,"list_id":1528464732,"price":"1000"}}}];
  </script>
  <div class="ad__sc-wuor06-0">
    <div class="ad__sc-2h9gkk-1"><span class="typo-overline mb-0-5">Categoria</span><a class="olx-link">Celulares E Smartphones</a></div>
    <div class="ad__sc-2h9gkk-1"><span class="typo-overline mb-0-5">Marca</span><span class="ad__sc-hj0yqs-0">Apple</span></div>
    <div class="ad__sc-2h9gkk-1"><span class="typo-overline mb-0-5">Condição</span><span class="ad__sc-hj0yqs-0">Usado - Bom</span></div>
    <div class="ad__sc-2h9gkk-1"><span class="typo-overline mb-0-5">Saúde da bateria</span><span class="ad__sc-hj0yqs-0">Perfeita (95% Até 100%)</span></div>
  </div>
  <div class="ad__sc-1l883pa-1">
    <div class="flex gap-1 flex-col">
      <div class="flex gap-1 items-center"><span class="typo-title-medium">Localização</span></div>
      <div class="ad__sc-o5hdud-0">
        <div class="flex flex-col"><span class="typo-body-medium">Vila Zefira</span></div>
        <div class="flex flex-col"><span class="typo-body-small">São Paulo, SP, 08411085</span></div>
      </div>
    </div>
  </div>
</body></html>`;

describe('HTTP-only extraction', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let scraper: OLXBRScraper;

  beforeAll(async () => {
    browser = (await launchChromium({ headless: true })).browser;
    // Exactly how the collector parses: JavaScript off, every route aborted, so
    // nothing on the page can reach the network.
    context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', route => route.abort());
    page = await context.newPage();
    scraper = new OLXBRScraper(browser);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  const filters: SearchFilters = { domain: 'olx.com.br', query: 's22 ultra', page: 1, limit: 50 };

  it('reads cards out of server-rendered HTML with no navigation', async () => {
    await page.setContent(
      searchHtml(
        card({
          id: '1528464732',
          title: 'Samsung Galaxy S22 Ultra 256GB',
          price: 'R$ 950',
          location: 'Porto Alegre, Nonoai',
          date: 'Ontem, 21:43',
        }) +
          card({
            id: '1528472760',
            title: 'S22 Ultra 5G na Caixa',
            price: 'R$ 2.200',
            location: 'Caxias do Sul -  RS',
            date: 'Hoje, 12:58',
          })
      )
    );

    const result = await scraper.readSearchPage(page, filters);

    expect(result.listings).toHaveLength(2);
    expect(result.listings[0]).toMatchObject({
      id: '1528464732',
      title: 'Samsung Galaxy S22 Ultra 256GB',
      price: 'R$ 950',
      location: 'Porto Alegre, Nonoai',
    });
    expect(result.listings[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it('takes the asking price, not the struck-through one beside it', async () => {
    await page.setContent(
      searchHtml(
        card({
          id: '1512264930',
          title: 'iPhone 17 pro max',
          price: 'R$ 6.999',
          oldPrice: 'R$ 7.199',
          location: 'Americana -  SP',
          date: 'Ontem, 21:43',
        })
      )
    );

    const result = await scraper.readSearchPage(page, filters);
    expect(result.listings[0]?.price).toBe('R$ 6.999');
  });

  it('collapses the whitespace the layout leaves in a location', async () => {
    await page.setContent(
      searchHtml(
        card({
          id: '1',
          title: 'Galaxy S22 Ultra',
          price: 'R$ 1.800',
          location: 'Americana -  SP',
          date: 'Hoje, 10:00',
        })
      )
    );

    const result = await scraper.readSearchPage(page, filters);
    expect(result.listings[0]?.location).toBe('Americana - SP');
  });

  it('reads the total from the range, not the first number in it', async () => {
    await page.setContent(
      searchHtml(
        card({ id: '1', title: 'S22 Ultra', price: 'R$ 1', location: 'X', date: 'Hoje, 1:00' })
      )
    );
    const result = await scraper.readSearchPage(page, filters);

    expect(result.totalCount).toBe(102078);
    expect(result.hasNextPage).toBe(true);
    expect(result.totalPages).toBe(100);
  });

  it('reports an empty result set without mistaking it for a broken selector', async () => {
    await page.setContent(searchHtml('', '0 resultados'));
    const result = await scraper.readSearchPage(page, filters);

    expect(result.listings).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.hasNextPage).toBe(false);
  });

  it('reads an ad from its structured data with no navigation and no JavaScript', async () => {
    await page.setContent(detailHtml);

    const listing = await scraper.readListingPage(
      page,
      'https://sp.olx.com.br/sao-paulo-e-regiao/celulares/iphone-11-128gb-1528464732',
      { hydrated: false }
    );

    expect(listing.id).toBe('1528464732');
    expect(listing.title).toBe('iPhone 11 128gb BARATO PARA SAIR RÁPIDO!');
    expect(listing.price).toBe('R$ 1.000');
    expect(listing.description).toContain('Face ID está off');
    // <br> tags become real line breaks rather than being left in the text.
    expect(listing.description).not.toContain('<br>');
    expect(listing.imageUrls).toHaveLength(2);
    expect(listing.attributes).toMatchObject({
      Categoria: 'Celulares E Smartphones',
      Marca: 'Apple',
      Condição: 'Usado - Bom',
      'Saúde da bateria': 'Perfeita (95% Até 100%)',
    });
    expect(listing.location).toContain('Vila Zefira');
  });

  it('recovers the publish timestamp from the script text, since nothing ran it', async () => {
    await page.setContent(detailHtml);
    const listing = await scraper.readListingPage(page, 'https://x.olx.com.br/a-1528464732', {
      hydrated: false,
    });

    // window.dataLayer is never assigned with JavaScript off; the value is read
    // out of the script's own source instead.
    expect(listing.publishedAt?.toISOString()).toBe(new Date(1787358385 * 1000).toISOString());
  });

  it('leaves the seller unset rather than waiting for a card that will never hydrate', async () => {
    await page.setContent(detailHtml);
    const started = Date.now();
    const listing = await scraper.readListingPage(page, 'https://x.olx.com.br/a-1528464732', {
      hydrated: false,
    });

    expect(listing.seller).toBeUndefined();
    // Had it waited for hydration, this would have cost the 10s timeout.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses an ad page whose structured data is missing', async () => {
    await page.setContent('<html><body><h1>A página não foi encontrada...</h1></body></html>');

    await expect(
      scraper.readListingPage(page, 'https://x.olx.com.br/a-1528464732', { hydrated: false })
    ).rejects.toThrow(/No schema.org Product data/);
  });
});
