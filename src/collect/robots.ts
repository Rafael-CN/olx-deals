/**
 * Minimal robots.txt reading: the crawl delay and whether our paths are welcome.
 *
 * Not a full protocol implementation, and not pretending to be. It exists so a
 * run can honour a stated delay and can say out loud when the site has asked
 * crawlers to stay out of the paths it is about to read — which is information
 * the person running it should have, whatever they decide to do with it.
 */

export interface RobotsRules {
  /** Seconds the site asked crawlers to wait between requests. */
  readonly crawlDelay?: number | undefined;
  readonly disallowed: readonly string[];
  readonly available: boolean;
}

export const parseRobots = (text: string, agent = '*'): RobotsRules => {
  const lines = text.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim());

  let inScope = false;
  let sawAnyGroup = false;
  let crawlDelay: number | undefined;
  const disallowed: string[] = [];

  for (const line of lines) {
    const [rawField, ...rest] = line.split(':');
    if (!rawField || rest.length === 0) continue;
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      const matches = value === '*' || value.toLowerCase() === agent.toLowerCase();
      inScope = sawAnyGroup && inScope ? inScope || matches : matches;
      sawAnyGroup = true;
      continue;
    }

    if (!inScope) continue;

    if (field === 'crawl-delay') {
      const parsed = Number(value.replace(',', '.'));
      if (Number.isFinite(parsed) && parsed > 0) crawlDelay = parsed;
    }

    if (field === 'disallow' && value) disallowed.push(value);
  }

  return {
    ...(crawlDelay === undefined ? {} : { crawlDelay }),
    disallowed,
    available: lines.some(line => /^user-agent:/i.test(line)),
  };
};

/** Whether a path is covered by a Disallow rule, by robots.txt prefix matching. */
export const isDisallowed = (rules: RobotsRules, path: string): boolean =>
  rules.disallowed.some(rule => {
    if (rule === '/') return true;
    const prefix = rule.replace(/\*+$/, '');
    return path.startsWith(prefix);
  });

/**
 * A stated crawl delay is a ceiling on our rate, never a licence to speed up: if
 * the site asks for 10 seconds between requests, 6 rpm is the most it wants, and
 * a configured 2 rpm stays at 2.
 */
export const rpmCeilingFor = (rules: RobotsRules): number | undefined =>
  rules.crawlDelay === undefined ? undefined : Math.max(60 / rules.crawlDelay, 0.2);
