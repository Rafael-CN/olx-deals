import { describe, it, expect } from 'vitest';
import { isDisallowed, parseRobots, rpmCeilingFor } from './robots.js';

describe('parseRobots', () => {
  it('reads the crawl delay and disallow rules from the wildcard group', () => {
    const rules = parseRobots(`
User-agent: *
Crawl-delay: 10
Disallow: /conta/
Disallow: /chat
Allow: /
    `);

    expect(rules.crawlDelay).toBe(10);
    expect(rules.disallowed).toEqual(['/conta/', '/chat']);
    expect(rules.available).toBe(true);
  });

  it('ignores rules aimed at other crawlers', () => {
    const rules = parseRobots(`
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /conta/
    `);

    expect(rules.disallowed).toEqual(['/conta/']);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots(`
# nothing to see
User-agent: *
Disallow: /private/   # internal
    `);

    expect(rules.disallowed).toEqual(['/private/']);
  });

  it('says so when there is nothing to read', () => {
    expect(parseRobots('').available).toBe(false);
    expect(parseRobots('<html>404</html>').available).toBe(false);
  });
});

describe('isDisallowed', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /conta/\nDisallow: /api/*');

  it('matches by prefix, the way robots.txt does', () => {
    expect(isDisallowed(rules, '/conta/anuncios')).toBe(true);
    expect(isDisallowed(rules, '/api/filters/v1')).toBe(true);
    expect(isDisallowed(rules, '/estado-rs')).toBe(false);
    expect(isDisallowed(rules, '/brasil')).toBe(false);
  });

  it('treats a bare slash as everything', () => {
    expect(isDisallowed(parseRobots('User-agent: *\nDisallow: /'), '/brasil')).toBe(true);
  });
});

describe('rpmCeilingFor', () => {
  it('turns a crawl delay into a rate ceiling', () => {
    expect(rpmCeilingFor(parseRobots('User-agent: *\nCrawl-delay: 10'))).toBe(6);
    expect(rpmCeilingFor(parseRobots('User-agent: *\nCrawl-delay: 1'))).toBe(60);
  });

  it('imposes nothing when the site asked for nothing', () => {
    expect(rpmCeilingFor(parseRobots('User-agent: *\nDisallow: /x'))).toBeUndefined();
  });
});
