import { describe, it, expect } from 'vitest';
import { checkPath, isDisallowed, parseRobots, rpmCeilingFor } from './robots.js';

describe('parseRobots', () => {
  it('reads the crawl delay and both kinds of rule from the wildcard group', () => {
    const rules = parseRobots(`
User-agent: *
Crawl-delay: 10
Disallow: /conta/
Disallow: /chat
Allow: /
    `);

    expect(rules.crawlDelay).toBe(10);
    expect(rules.rules).toEqual([
      { allow: false, pattern: '/conta/' },
      { allow: false, pattern: '/chat' },
      { allow: true, pattern: '/' },
    ]);
    expect(rules.available).toBe(true);
  });

  it('ignores rules aimed at other crawlers', () => {
    const rules = parseRobots(`
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /conta/
    `);

    expect(rules.rules).toEqual([{ allow: false, pattern: '/conta/' }]);
  });

  it('does not let one group leak its rules into the next', () => {
    // A User-agent line after a rule opens a new group. Reading it as a
    // continuation of the previous one hands us permissions written for
    // somebody else — which is exactly how olx.com.br's Allow lines, written
    // for facebookexternalhit, would otherwise apply to us.
    const rules = parseRobots(`
User-agent: facebookexternalhit
Allow: /

User-agent: *
Disallow: /conta/
    `);

    expect(rules.rules).toEqual([{ allow: false, pattern: '/conta/' }]);
    expect(isDisallowed(rules, '/conta/anuncios')).toBe(true);
  });

  it('shares one group between consecutive user-agent lines', () => {
    const rules = parseRobots(`
User-agent: Googlebot
User-agent: *
Disallow: /conta/
    `);

    expect(rules.rules).toEqual([{ allow: false, pattern: '/conta/' }]);
  });

  it('prefers a group that names the agent over the wildcard fallback', () => {
    const text = `
User-agent: *
Disallow: /

User-agent: olx-deals
Disallow: /conta/
    `;

    expect(parseRobots(text, 'olx-deals').rules).toEqual([{ allow: false, pattern: '/conta/' }]);
    expect(parseRobots(text).rules).toEqual([{ allow: false, pattern: '/' }]);
  });

  it('ignores comments, blank lines and an empty Disallow', () => {
    const rules = parseRobots(`
# nothing to see
User-agent: *
Disallow: /private/   # internal
Disallow:
    `);

    expect(rules.rules).toEqual([{ allow: false, pattern: '/private/' }]);
  });

  it('says so when there is nothing to read', () => {
    expect(parseRobots('').available).toBe(false);
    expect(parseRobots('<html>404</html>').available).toBe(false);
  });
});

describe('checkPath', () => {
  it('expands a wildcard in the middle of a pattern', () => {
    // The rule that the old prefix matcher could not see. It is written against
    // the query string, so a pathname-only comparison always came back allowed.
    const rules = parseRobots('User-agent: *\nDisallow: /*?*q=*');

    expect(checkPath(rules, '/celulares/estado-rs?q=redmagic')).toEqual({
      allowed: false,
      rule: 'Disallow: /*?*q=*',
    });
    expect(checkPath(rules, '/celulares/estado-rs').allowed).toBe(true);
  });

  it('anchors a pattern ending in a dollar sign', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.json$');

    expect(isDisallowed(rules, '/a/b.json')).toBe(true);
    expect(isDisallowed(rules, '/a/b.json?x=1')).toBe(false);
  });

  it('matches by prefix when there is no wildcard', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /conta/');

    expect(isDisallowed(rules, '/conta/anuncios')).toBe(true);
    expect(isDisallowed(rules, '/estado-rs')).toBe(false);
  });

  it('lets the longest pattern decide, and allow break a tie', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /conta/\nAllow: /conta/publico');
    expect(checkPath(rules, '/conta/publico/x').allowed).toBe(true);
    expect(checkPath(rules, '/conta/privado').allowed).toBe(false);

    const tied = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x');
    expect(tied.rules).toHaveLength(2);
    expect(checkPath(tied, '/x').allowed).toBe(true);
  });

  it('names the rule that decided, so a warning can quote it', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*?*o=*');
    expect(checkPath(rules, '/brasil?q=iphone&o=2').rule).toBe('Disallow: /*?*o=*');
  });

  it('allows what no rule covers', () => {
    expect(checkPath(parseRobots('User-agent: *\nDisallow: /conta/'), '/brasil')).toEqual({
      allowed: true,
    });
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
