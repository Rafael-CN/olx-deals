/**
 * robots.txt, read the way the protocol says to read it.
 *
 * This exists so a run can honour a stated delay and can say out loud when the
 * site has asked crawlers to stay out of the paths it is about to read — which
 * is information the person running it should have, whatever they decide to do
 * with it.
 *
 * The previous version could not express the rules it was reading. It stripped
 * trailing asterisks and did a prefix comparison, so `/*?*q=*` became the prefix
 * `/*?*q=` and matched nothing; it never parsed `Allow`; and its caller compared
 * a pathname with the query string thrown away. Every sweep URL came back clean,
 * and "we checked and found nothing" is indistinguishable from "there was
 * nothing to find". That is the one answer a caller cannot act on.
 *
 * Implements RFC 9309 §2.2: groups keyed by user-agent, `*` and `$` wildcards,
 * longest match wins, and allow breaks a tie. Percent-encoding is compared as
 * written rather than normalised, which is the one shortcut left in here.
 */

export interface RobotsRule {
  readonly allow: boolean;
  /** The pattern as the file wrote it, so a warning can quote it back. */
  readonly pattern: string;
}

export interface RobotsRules {
  /** Seconds the site asked crawlers to wait between requests. */
  readonly crawlDelay?: number | undefined;
  readonly rules: readonly RobotsRule[];
  readonly available: boolean;
}

export interface RobotsVerdict {
  readonly allowed: boolean;
  /** The winning rule, written as it appears in the file, when one matched. */
  readonly rule?: string | undefined;
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number | undefined;
}

/**
 * Rules for one agent, chosen the way the protocol says: a group naming the
 * agent wins outright, and `*` is the fallback used only when none does.
 *
 * This is why olx.com.br's `Allow` lines change nothing here — they sit in a
 * group for facebookexternalhit, and a generic crawler never reads that group.
 */
const groupsFor = (groups: readonly Group[], agent: string): Group[] => {
  const named = groups.filter(group =>
    group.agents.some(candidate => candidate === agent.toLowerCase())
  );
  return named.length > 0 ? named : groups.filter(group => group.agents.includes('*'));
};

export const parseRobots = (text: string, agent = '*'): RobotsRules => {
  const lines = text.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim());

  const groups: Group[] = [];
  let current: Group | undefined;
  // Consecutive User-agent lines share one group; the first rule closes the
  // header, so a later User-agent starts a new group rather than joining this
  // one. Getting this wrong makes one group's rules leak into another's.
  let readingAgents = false;

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!value) continue;
      if (!readingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
        readingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    readingAgents = false;

    if (field === 'crawl-delay') {
      const parsed = Number(value.replace(',', '.'));
      if (Number.isFinite(parsed) && parsed > 0) current.crawlDelay = parsed;
      continue;
    }

    if (field === 'allow' && value) current.rules.push({ allow: true, pattern: value });
    // An empty Disallow means "nothing is disallowed" and carries no pattern.
    if (field === 'disallow' && value) current.rules.push({ allow: false, pattern: value });
  }

  const mine = groupsFor(groups, agent);
  const crawlDelay = mine.map(group => group.crawlDelay).find(delay => delay !== undefined);

  return {
    ...(crawlDelay === undefined ? {} : { crawlDelay }),
    rules: mine.flatMap(group => group.rules),
    available: groups.length > 0,
  };
};

/** RFC 9309 §2.2.2: `*` spans any run of characters, `$` anchors the end. */
const patternToRegExp = (pattern: string): RegExp => {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*') source += '.*';
    else if (character === '$' && index === pattern.length - 1) source += '$';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}`);
};

/**
 * Whether a target is welcome, and which rule decided it.
 *
 * The target is the path *and* its query string: on olx.com.br the rules are
 * written entirely against query parameters, so a comparison against the
 * pathname alone can only ever return "allowed".
 *
 * Longest pattern wins, and allow breaks a tie — the protocol's own preference
 * for the least restrictive reading of an ambiguous file.
 */
export const checkPath = (rules: RobotsRules, target: string): RobotsVerdict => {
  let winner: RobotsRule | undefined;
  for (const rule of rules.rules) {
    if (!patternToRegExp(rule.pattern).test(target)) continue;
    if (winner === undefined || rule.pattern.length > winner.pattern.length) {
      winner = rule;
      continue;
    }
    if (rule.pattern.length === winner.pattern.length && rule.allow) winner = rule;
  }

  if (winner === undefined) return { allowed: true };
  return {
    allowed: winner.allow,
    rule: `${winner.allow ? 'Allow' : 'Disallow'}: ${winner.pattern}`,
  };
};

/** Whether a target is covered by a Disallow the site meant for us. */
export const isDisallowed = (rules: RobotsRules, target: string): boolean =>
  !checkPath(rules, target).allowed;

/**
 * What a robots.txt that could not be read should mean.
 *
 * RFC 9309 §2.3.1.4 treats an unreachable robots.txt as a full disallow, on the
 * reasoning that a crawler which cannot hear the answer should not assume it was
 * yes. The run still decides what to do about it; this only makes sure the
 * decision is taken knowingly rather than by silence.
 */
export const UNREACHABLE_ROBOTS: RobotsRules = {
  rules: [{ allow: false, pattern: '/' }],
  available: false,
};

/**
 * A stated crawl delay is a ceiling on our rate, never a licence to speed up: if
 * the site asks for 10 seconds between requests, 6 rpm is the most it wants, and
 * a configured 2 rpm stays at 2.
 */
export const rpmCeilingFor = (rules: RobotsRules): number | undefined =>
  rules.crawlDelay === undefined ? undefined : Math.max(60 / rules.crawlDelay, 0.2);
