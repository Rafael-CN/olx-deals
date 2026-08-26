import { writeFileSync } from 'node:fs';
import { BrowserSession } from './dist/collect/session.js';
import { HtmlFetcher } from './dist/collect/fetcher.js';

// Respect the cooldown the tool itself asked for before touching the site.
await new Promise(r => setTimeout(r, 12 * 60 * 1000));

const url = 'https://rs.olx.com.br/regioes-de-porto-alegre-torres-e-santa-cruz-do-sul/celulares/samsung-galaxy-s22-ultra-1528710904';
const session = await BrowserSession.open({ dataDir: '.garimpo-probe', pages: 1, channel: 'chrome' });
const fetcher = await HtmlFetcher.create(session.httpContext, session.parserContext);

try {
  const out = await fetcher.get(url);
  console.log('status', out.status, 'bytes', out.html.length);
  writeFileSync('ad.html', out.html, 'utf8');

  const probes = {
    'Na OLX desde': /Na OLX desde/,
    'userSince / memberSince': /userSince|memberSince|member_since/i,
    'createdAt on a user object': /"user[^"]*"\s*:\s*\{[^}]*created/i,
    'seller name "Marcio"': /Marcio/i,
    'accountCreat / registerDate': /accountCreat|registrationDate|register_date|dataCadastro/i,
    'a 4-digit year near "desde"': /desde[^<]{0,40}\d{4}/i,
    'RSC stream marker': /self\.__next_f/,
  };
  for (const [label, re] of Object.entries(probes)) {
    console.log(String(re.test(out.html)).padEnd(5), label);
  }
} catch (e) {
  console.log('FAILED:', e.message.slice(0, 160));
}
await fetcher.close();
await session.close();
