#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { Profile } from '../config/profile.js';
import { OLXBRScraper } from '../scrapers/olx/olx-br.scraper.js';
import { Store, StoredAd, StoredDetail } from '../store/db.js';
import { BrowserSession } from '../collect/session.js';
import { RateGovernor, CollectionHalted } from '../collect/governor.js';
import { HtmlFetcher, RequestMeter } from '../collect/fetcher.js';
import { BlockMemory, describeWait } from '../collect/cooldown.js';
import {
  checkPath,
  parseRobots,
  rpmCeilingFor,
  RobotsRules,
  UNREACHABLE_ROBOTS,
} from '../collect/robots.js';
import { planShards } from '../collect/shard.js';
import { describeEstimate, estimateCost } from '../collect/estimate.js';
import {
  collect,
  enrich,
  flushProbedPages,
  makeGate,
  makeProbe,
  newBudget,
  ProbedPage,
  RunnerContext,
  type Budget,
} from '../collect/runner.js';
import { Candidate, triage, Verdict } from '../triage/stages.js';
import { requiredSellerFields } from '../triage/seller.js';
import { rankGemsByCohort } from '../triage/gems.js';
import { buildTaxonomy, TaxonomyFacts } from '../triage/taxonomy.js';
import { clusterByPhoto, duplicateAdIds, relistCountFor } from '../triage/identity.js';
import { SellerInfo } from '../core/types.js';
import { CliValues, buildProfile, parseCommandLine, profileTemplate } from './options.js';

const HELP = `
garimpo — bulk collection and triage of olx.com.br classified ads

Usage: garimpo <command> [options]

Commands
  hunt        plan, collect, triage, enrich, re-triage and rank in one pass
  plan        probe the search and work out how to slice it (no collection)
  collect     sweep the planned slices for search cards
  triage      apply the profile's stages to what has been collected
  enrich      read the ad pages of everything that passed card triage
  gems        rank survivors against the going rate for the product
  report      print a run's funnel, prices and top finds
  candidates  browse the ranked candidate base (no requests, no site contact)
  insights    what the corpus taught: product taxonomy and photo-identity clusters
  runs        list stored runs
  template    print a fully populated profile JSON to edit

Profile
  --profile <path>          JSON profile; every flag below overrides it
  --name, --query
  --queries 'red magic 10 pro,nubia redmagic 10'
                            extra phrasings swept into the same corpus
  --demote 'capa,s23,air'   words that lower an ad's match score (never remove it)
  --min-match 25            only consider candidates scoring at least this
  --sample 250              how many candidates to actually read
  --sample-by match|price|spread|random   which ones to pick
  --states sp,rj            UFs to sweep (default: all 27)
  --categories celulares    OLX category slug paths
  --min-price, --max-price

Matching and triage
  --require 's\\s*22,ultra'  every pattern must appear in the title
  --reject 'capa,s23'        any match excludes the ad
  --tolerate none|minor|major        worst damage still allowed
  --condition 'Novo,Usado - Bom'     allowed values of OLX's "Condição"
  --max-age-days, --min-photos
  --seller-min-rating, --seller-min-sales, --seller-max-cancel-rate
  --seller-min-age-months, --seller-require-verified
  --seller-unknown pass|fail         what to do when the seller card is empty

Gems
  --gems / --no-gems
  --min-discount 0.3        minimum discount against the clean median
  --min-z 1.5               distance below the median, in MAD
  --alert-score 0.7         score at which a find is called a gem
  --min-reference 12        comparables required before judging anything

Budget and pacing
  --gentle                  slowest safe preset: ~2 rpm, one page at a time,
                            a five-minute sit-down every 60 requests
  --max-cards, --max-details, --max-requests, --max-shards, --max-minutes
  --rpm 6                   starting request rate; it adapts from there
  --max-rpm 15, --cooldown 300, --concurrency 1
  --pause-every 120 --pause-for 180   long idle gaps between bursts
  --window 02:00-07:00      only work during these hours (may wrap midnight)
  --refresh-after-days 7    re-read an ad page only if this stale
  --force                   start even though a previous run was blocked

Output
  --run <id>                act on a specific run (default: the latest)
  --top 20, --json, --quiet
  --data-dir .garimpo, --channel chrome, --headed, --no-block-assets
`;

const EOL = String.fromCharCode(10);

/** Says out loud when a run is sitting out its closed hours, rather than hanging. */
const withWindowLogging = (governor: RateGovernor, values: CliValues): RateGovernor => {
  governor.onWindowClosed = waitMs => {
    if (values.quiet !== true) {
      log(`outside the working window — sleeping ${describeWait(waitMs)} until it opens`);
    }
  };
  return governor;
};
const log = (message: string) => process.stderr.write(`${message}\n`);

const runId = (profile: Profile, now: Date): string =>
  `${profile.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${now.toISOString().replace(/[:.]/g, '').slice(0, 15)}`;

const openContext = async (
  profile: Profile,
  values: CliValues,
  store: Store,
  budget: Budget
): Promise<RunnerContext> => {
  const session = await BrowserSession.open({
    dataDir: profile.dataDir,
    pages: profile.pacing.concurrency,
    headless: values.headed !== true,
    channel: values.channel ? String(values.channel) : undefined,
    blockAssets: values['no-block-assets'] !== true,
    onBrowserChosen: using => {
      if (values.quiet !== true) log(`browser: ${using}`);
    },
  });

  const meter = new RequestMeter();
  meter.watchContext(session.httpContext);
  const governor = withWindowLogging(new RateGovernor(profile.pacing), values);
  const fetcher = await HtmlFetcher.create(
    session.httpContext,
    session.parserContext,
    makeGate(governor, budget)
  );

  return {
    scraper: new OLXBRScraper(session.playwrightBrowser),
    session,
    governor,
    fetcher,
    meter,
    blockMemory: new BlockMemory(profile.dataDir),
    // Only the fields the gates actually read; everything else stays on the cheap
    // path. See requiredSellerFields.
    neededSellerFields: profile.stages.flatMap(stage =>
      stage.type === 'seller' ? requiredSellerFields(stage.gate) : []
    ),
    store,
    profile,
    log: values.quiet === true ? () => {} : log,
  };
};

/** Rows from the store, in the shape the triage stages expect. */
const toCandidate = (row: StoredAd & Partial<StoredDetail>, enriched: boolean): Candidate => ({
  id: row.id,
  title: row.title,
  url: row.url,
  price: row.price ?? undefined,
  location: row.location ?? undefined,
  imageCount: enriched ? (row.image_count ?? 0) : row.image_url ? 1 : 0,
  publishedAt: row.published_at ? new Date(row.published_at) : undefined,
  description: row.description ?? undefined,
  attributes: row.attributes_json
    ? (JSON.parse(row.attributes_json) as Record<string, string>)
    : undefined,
  seller: parseSeller(row.seller_json),
  enriched,
});

const parseSeller = (json: string | null | undefined): SellerInfo | undefined => {
  if (!json) return undefined;
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    ...raw,
    memberSince: raw['memberSince'] ? new Date(String(raw['memberSince'])) : undefined,
  } as SellerInfo;
};

const runTriage = (
  store: Store,
  id: string,
  profile: Profile,
  phase: 'card' | 'detail'
): Verdict[] => {
  const now = new Date();
  const rows: Array<StoredAd & Partial<StoredDetail>> =
    phase === 'card' ? store.runAds(id) : store.detailsFor(id);

  const verdicts = rows.map(row =>
    triage(toCandidate(row, phase === 'detail'), profile.stages, now)
  );
  store.saveVerdicts(id, phase, verdicts);
  return verdicts;
};

const runGems = (store: Store, id: string, profile: Profile) => {
  const rows = store.detailsFor(id);
  const now = new Date();
  const scores = store.matchScores(id);

  // Identity before statistics: one unit relisted five times is five rows moving
  // the very median it will then be judged against.
  const clusters = clusterByPhoto(store.identityMembers(id));
  const duplicates = duplicateAdIds(clusters);
  const relists = relistCountFor(clusters);

  const entries = rows.map(row => {
    const candidate = toCandidate(row, true);
    const verdict = triage(candidate, profile.stages, now);
    const facts: TaxonomyFacts = {
      adId: row.id,
      ...(candidate.attributes ? { attributes: candidate.attributes } : {}),
      matchScore: scores.get(row.id) ?? 0,
      ...(candidate.price === undefined ? {} : { price: candidate.price }),
    };
    return { candidate, severity: verdict.severity, clean: verdict.passed, facts };
  });

  const taxonomy = buildTaxonomy(entries.map(entry => entry.facts));
  const { assessments, overall } = rankGemsByCohort(entries, profile.gems, duplicates, now);

  store.saveGems(
    id,
    assessments.map(assessment => ({
      adId: assessment.adId,
      score: assessment.score,
      discountPct: assessment.discountPct,
      robustZ: assessment.robustZ,
      median: overall.median,
      referenceSize: assessment.cohortSize ?? overall.size,
      verdict: assessment.verdict,
      reasons: [
        ...assessment.reasons,
        ...(relists.get(assessment.adId)
          ? [`republished ${relists.get(assessment.adId)}x — this ad has not been selling`]
          : []),
      ],
    }))
  );

  return {
    reference: overall,
    assessments,
    taxonomy,
    clusters,
    duplicates,
    cleanCount: entries.filter(entry => entry.clean).length,
  };
};

/** Reports what the run learned about the product, not only how many gems it found. */
const logGemOutcome = (outcome: ReturnType<typeof runGems>): void => {
  const { reference, assessments, taxonomy, clusters, duplicates, cleanCount } = outcome;

  if (taxonomy.target) {
    const demote =
      taxonomy.suggestedDemotions.length > 0
        ? `, suggest --demote ${JSON.stringify(taxonomy.suggestedDemotions.join(','))}`
        : '';
    log(
      `taxonomy: corpus is mostly ${taxonomy.target.label} ` +
        `(${taxonomy.target.count} ads, median ${money(Math.round(taxonomy.target.medianPrice))}); ` +
        `${taxonomy.siblings.length} other model(s) present${demote}`
    );
  } else if (assessments.length > 0) {
    log('no Modelo attribute on the enriched ads — cohorts fall back to the whole corpus');
  }

  if (clusters.length > 0) {
    const kinds = clusters.reduce<Record<string, number>>((acc, cluster) => {
      acc[cluster.kind] = (acc[cluster.kind] ?? 0) + 1;
      return acc;
    }, {});
    log(
      `photo identity: ${clusters.length} cluster(s) — ` +
        Object.entries(kinds)
          .map(([kind, n]) => `${n} ${kind}`)
          .join(', ') +
        `; ${duplicates.size} duplicate row(s) held out of the price reference`
    );
  }

  log(
    `reference: median ${money(Math.round(reference.median))} over ${reference.size} clean ads ` +
      `(of ${cleanCount} passing) — ${assessments.filter(a => a.verdict === 'gem').length} gem(s), ` +
      `${assessments.filter(a => a.verdict === 'watch').length} to watch, ` +
      `${assessments.filter(a => a.verdict === 'suspect').length} suspect`
  );
};

const money = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `R$ ${value.toLocaleString('pt-BR')}`;

const report = (store: Store, id: string, top: number, asJson: boolean): void => {
  const funnel = store.funnel(id);
  const prices = store.priceStats(id);
  const shards = store.shardSummary(id);
  const gems = store.topGems(id, top);
  const cardRejects = store.rejectionReasons(id, 'card', 8);
  const detailRejects = store.rejectionReasons(id, 'detail', 8);
  const totalAds = store.countRunAds(id);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          run: id,
          totalAds,
          shards,
          prices,
          funnel,
          matchBands: store.matchHistogram(id),
          rejections: { card: cardRejects, detail: detailRejects },
          gems: gems.map(gem => ({ ...gem, reasons: JSON.parse(String(gem['reasons_json'])) })),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`\nRun ${id}`);
  out(`  ads collected: ${totalAds}`);
  out(
    `  price range: ${money(prices['min'] as number)} – ${money(prices['max'] as number)} ` +
      `(${prices['n']} priced)`
  );
  out(`  shards: ${shards.map(s => `${s.status}=${s.n}`).join(' ')}`);

  const histogram = store.matchHistogram(id);
  if (histogram.length > 0) {
    out(EOL + '  title match (nothing is discarded — low scores are ranked last, not dropped)');
    for (const band of histogram) {
      out(
        `    ${band.band.padEnd(7)} ${String(band.n).padStart(5)} ads, cheapest ${money(band.cheapest)}`
      );
    }
  }

  if (funnel.length > 0) {
    out('\n  triage funnel (ads dropped per stage)');
    for (const stage of funnel) {
      out(
        `    ${stage.stage.padEnd(16)} passed ${String(stage.passed).padStart(5)}  failed ${stage.failed}`
      );
    }
  }

  const showRejects = (label: string, rows: Array<Record<string, unknown>>) => {
    if (rows.length === 0) return;
    out(`\n  why ads were dropped (${label})`);
    for (const row of rows) {
      out(
        `    ${String(row['n']).padStart(5)}x  ${row['stage']}: ${String(row['reason'] ?? '').slice(0, 90)}`
      );
    }
  };
  showRejects('cards', cardRejects);
  showRejects('details', detailRejects);

  if (gems.length > 0) {
    out(`\n  top finds`);
    for (const gem of gems) {
      const reasons = JSON.parse(String(gem['reasons_json'])) as string[];
      out(
        `\n    [${String(gem['verdict']).toUpperCase()} ${Number(gem['score']).toFixed(2)}] ` +
          `${money(gem['price'] as number)} — ${String(gem['title']).slice(0, 62)}`
      );
      out(`      ${gem['location'] ?? ''}  ${gem['url']}`);
      for (const reason of reasons) out(`      · ${reason}`);
    }
  }
  out('');
};

const main = async (): Promise<number> => {
  const { command, values } = parseCommandLine(process.argv.slice(2));

  if (values.help === true || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (command === 'template') {
    process.stdout.write(`${JSON.stringify(profileTemplate(), null, 2)}\n`);
    return 0;
  }

  // Commands that only read the store must not need a query: `report` and `runs`
  // are how you look at a finished sweep, and demanding a search term to do that
  // would be nonsense.
  const dataDir = values['data-dir'] ? String(values['data-dir']) : '.garimpo';
  const readOnly = command === 'runs' || command === 'report' || command === 'candidates';
  const profile = readOnly ? undefined : buildProfile(values);
  const store = new Store(profile?.dataDir ?? dataDir);

  try {
    if (command === 'runs') {
      const rows = store.listRuns(Number(values.top ?? 20));
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }

    if (command === 'insights') {
      const id = values.run ? String(values.run) : store.latestRunId();
      if (!id) {
        log('no runs stored yet');
        return 1;
      }

      const scores = store.matchScores(id);
      const facts: TaxonomyFacts[] = store.detailsFor(id).map(row => ({
        adId: row.id,
        ...(row.attributes_json
          ? { attributes: JSON.parse(row.attributes_json) as Record<string, string> }
          : {}),
        matchScore: scores.get(row.id) ?? 0,
        ...(row.price === null ? {} : { price: row.price }),
      }));

      const taxonomy = buildTaxonomy(facts);
      const clusters = clusterByPhoto(store.identityMembers(id));

      if (values.json === true) {
        process.stdout.write(`${JSON.stringify({ run: id, taxonomy, clusters }, null, 2)}
`);
        return 0;
      }

      const out = (line: string) =>
        process.stdout.write(`${line}
`);
      out(`
What ${id} learned`);
      out(`
  product taxonomy (from OLX own Marca/Modelo fields, ${facts.length} enriched ads)`);
      if (taxonomy.models.length === 0) {
        out('    nothing yet — no ad page has been read, so there is no Modelo to read');
      } else {
        for (const model of taxonomy.models) {
          const mark = model.label === taxonomy.target?.label ? '->' : '  ';
          out(
            `    ${mark} ${model.label.padEnd(34)} ${String(model.count).padStart(4)} ads  ` +
              `median ${money(Math.round(model.medianPrice)).padEnd(11)} match ${model.meanMatch.toFixed(0)}`
          );
        }
        if (taxonomy.suggestedDemotions.length > 0) {
          out(`
    suggested: --demote ${JSON.stringify(taxonomy.suggestedDemotions.join(','))}`);
        }
      }

      out(`
  photo identity (${clusters.length} cluster(s), computed from stored photo ids)`);
      for (const cluster of clusters.slice(0, Number(values.top ?? 15))) {
        out(`    [${cluster.kind}] ${cluster.adIds.length} ads — ${cluster.reason}`);
        out(`      ${cluster.adIds.join(', ')}`);
      }
      if (clusters.length === 0) out('    none — every listing has photos of its own');
      out('');
      return 0;
    }

    if (command === 'candidates') {
      const id = values.run ? String(values.run) : store.latestRunId();
      if (!id) {
        log('no runs stored yet');
        return 1;
      }

      const histogram = store.matchHistogram(id);
      const rows = store.candidates(id, {
        minMatchScore: values['min-match'] === undefined ? 0 : Number(values['min-match']),
        limit: Number(values.top ?? 50),
        ...(values['max-price'] === undefined ? {} : { maxPrice: Number(values['max-price']) }),
      });

      if (values.json === true) {
        process.stdout.write(
          `${JSON.stringify({ run: id, histogram, candidates: rows }, null, 2)}\n`
        );
        return 0;
      }

      const out = (line: string) => process.stdout.write(`${line}\n`);
      out(`\nCandidates in ${id}, best match first`);
      out('  match  price        location                  title');
      for (const row of rows) {
        out(
          `  ${String(row['match_score']).padStart(5)}  ` +
            `${money(row['price'] as number).padEnd(12)} ` +
            `${String(row['location'] ?? '')
              .slice(0, 24)
              .padEnd(25)} ` +
            `${String(row['title']).slice(0, 58)}`
        );
      }
      out('\n  match-score bands');
      for (const band of histogram) {
        out(
          `    ${band.band.padEnd(7)} ${String(band.n).padStart(5)} ads, cheapest ${money(band.cheapest)}`
        );
      }
      out('');
      return 0;
    }

    const existing = values.run ? String(values.run) : undefined;

    if (command === 'report') {
      const id = existing ?? store.latestRunId();
      if (!id) {
        log('no runs stored yet');
        return 1;
      }
      report(store, id, Number(values.top ?? 15), values.json === true);
      return 0;
    }

    if (command === 'triage' || command === 'gems') {
      const id = existing ?? store.latestRunId();
      if (!id) {
        log('no runs stored yet');
        return 1;
      }
      // The run's own profile is the authority when re-triaging: the stages that
      // produced a sweep are the ones its verdicts should be read against.
      const stored = store.getRun(id);
      const active = stored ? (JSON.parse(stored.profile_json) as Profile) : profile;
      if (!active) {
        log(`run ${id} has no stored profile; pass --profile or --query`);
        return 1;
      }

      if (command === 'triage') {
        const cards = runTriage(store, id, active, 'card');
        const details = runTriage(store, id, active, 'detail');
        log(
          `card triage: ${cards.filter(v => v.passed).length}/${cards.length} passed; ` +
            `detail triage: ${details.filter(v => v.passed).length}/${details.length} passed`
        );
      } else {
        logGemOutcome(runGems(store, id, active));
      }
      report(store, id, Number(values.top ?? 15), values.json === true);
      return 0;
    }

    if (!profile?.query) {
      log('a --query (or a --profile containing one) is required');
      return 1;
    }

    const memory = new BlockMemory(profile.dataDir);
    const waiting = memory.remainingMs(profile.pacing.cooldownSeconds);
    if (waiting > 0 && values.force !== true) {
      log(
        `olx.com.br blocked a previous run and the cooldown has ${describeWait(waiting)} left. ` +
          `Starting now would just earn another refusal — that is how a rate limit turns into a ` +
          `real ban. Wait it out, or pass --force if you know better.`
      );
      return 3;
    }

    const now = new Date();
    const id = existing ?? runId(profile, now);
    const budget = newBudget(profile.limits);
    const context = await openContext(profile, values, store, budget);

    try {
      store.startRun(id, profile, now.toISOString());
      const notes: string[] = [];

      // One request, at the start, to read what the site asks of crawlers. A
      // stated delay becomes a hard ceiling; a disallowed path is reported rather
      // than silently obeyed or silently ignored, because that is the operator's
      // call to make knowingly.
      try {
        // Free: the fetcher anchors each origin on its robots.txt anyway, so this
        // reads a document already fetched rather than asking for another.
        let rules: RobotsRules;
        try {
          rules = parseRobots(await context.fetcher.robotsFor('https://www.olx.com.br'));
        } catch (error) {
          // RFC 9309 reads an unreachable robots.txt as a full disallow: a
          // crawler that could not hear the answer should not assume it was yes.
          rules = UNREACHABLE_ROBOTS;
          context.log(`could not read robots.txt (${(error as Error).message})`);
        }

        const ceiling = rpmCeilingFor(rules);
        if (ceiling !== undefined) {
          context.governor.imposeCeiling(ceiling);
          context.log(
            `robots.txt asks for ${rules.crawlDelay}s between requests — capping at ${ceiling.toFixed(1)} rpm`
          );
          notes.push(`robots.txt Crawl-delay ${rules.crawlDelay}s honoured`);
        }

        // Path *and* query: olx.com.br writes its rules entirely against query
        // parameters, so comparing the pathname alone can only say "allowed".
        const searchUrl = new URL(
          context.scraper.searchUrlFor({ domain: 'olx.com.br', query: profile.query })
        );
        const target = `${searchUrl.pathname}${searchUrl.search}`;
        const verdict = checkPath(rules, target);
        if (!verdict.allowed) {
          const rule = verdict.rule ?? 'Disallow: /';
          const source = rules.available ? 'robots.txt' : 'an unreadable robots.txt';
          for (const line of [
            '',
            `  ${source} asks generic crawlers to stay out of this search.`,
            `    rule:   ${rule}`,
            `    target: ${target}`,
            '  Continuing, because this run was started knowing that.',
            '',
          ]) {
            context.log(line);
          }
          notes.push(`robots.txt asked us not to read ${target} (${rule}); swept anyway.`);
        }
      } catch (error) {
        context.log(`could not check robots.txt: ${(error as Error).message}`);
      }

      if (command === 'plan' || command === 'hunt') {
        // A resumed run already knows its slices; re-probing them would spend a
        // request each to learn what is already on disk.
        const known = store.pendingShards(id);
        if (known.length > 0 && existing) {
          context.log(`resuming: ${known.length} slice(s) still pending, no re-probing needed`);
        } else {
          context.log(`planning "${profile.query}" across ${profile.states.length || 27} state(s)`);
          const harvest = new Map<string, ProbedPage>();
          const plan = await planShards(
            profile,
            makeProbe(context, budget, harvest),
            profile.limits
          );
          store.saveShards(id, plan.shards);
          notes.push(...plan.notes);

          // The planner had to fetch page one of every slice to read its count;
          // keeping those pages is one request saved per slice.
          const flushed = flushProbedPages(context, id, harvest);

          context.log(
            `${plan.shards.length} slice(s) after ${plan.probes} probe(s); ` +
              `up to ${plan.reachableAds} ads reachable; kept ${flushed.pages} page(s) the ` +
              `probes already fetched (${flushed.newAds} ads)` +
              (plan.truncatedShards.length > 0
                ? `; ${plan.truncatedShards.length} slice(s) too big to page fully`
                : '')
          );
          for (const note of plan.notes) context.log(`  note: ${note}`);

          const estimate = estimateCost(plan.shards, profile.limits, profile.pacing, plan.probes);
          context.log(`estimated cost: ${describeEstimate(estimate)}`);

          if (command === 'plan') {
            store.finishRun(id, 'planned', new Date().toISOString(), notes);
            process.stdout.write(
              JSON.stringify(
                { run: id, estimate, shards: plan.shards, notes: plan.notes },
                null,
                2
              ) + EOL
            );
            return 0;
          }
        }
      }

      if (command === 'collect' || command === 'hunt') {
        const outcome = await collect(context, id, budget);
        context.log(
          `collected ${outcome.cardsSeen} card(s), ${outcome.newAds} new, ` +
            `${outcome.shardsDone} slice(s) done${outcome.halted ? ` — stopped: ${outcome.halted}` : ''}`
        );
        if (outcome.halted) notes.push(`collection stopped: ${outcome.halted}`);
      }

      if (command === 'enrich' || command === 'hunt') {
        const cards = runTriage(store, id, profile, 'card');
        context.log(`card triage: ${cards.filter(v => v.passed).length}/${cards.length} passed`);

        const outcome = await enrich(context, id, budget);
        context.log(
          `read ${outcome.fetched} ad page(s), ${outcome.upgraded} needed a full load, ` +
            `${outcome.failed} unreadable` +
            (outcome.halted ? ` — stopped: ${outcome.halted}` : '')
        );
        if (outcome.halted) notes.push(`enrichment stopped: ${outcome.halted}`);
      }

      if (command === 'hunt') {
        const details = runTriage(store, id, profile, 'detail');
        context.log(
          `detail triage: ${details.filter(v => v.passed).length}/${details.length} passed`
        );

        if (profile.gems.enabled) {
          logGemOutcome(runGems(store, id, profile));
        }
      }

      store.finishRun(id, 'done', new Date().toISOString(), notes);
      if (context.governor.stats.blocks === 0) context.blockMemory.recordClean();

      const stats = context.governor.stats;
      const http = context.fetcher.stats;
      const ads = store.countRunAds(id);
      context.log(
        `${http.requests} document fetch(es) (${http.kilobytes} KB) over ${http.origins} origin(s), ` +
          `${http.anchorLoads} anchor load(s); ${context.meter.total} request(s) reached ` +
          `olx.com.br in total for ${ads} ad(s) collected`
      );
      context.log(
        `blocks: ${stats.blocks}, errors: ${stats.errors}, ending rate ${stats.currentRpm} rpm, ` +
          `${Math.round((stats.waitedMs + stats.cooldownMs) / 1000)}s spent waiting`
      );

      if (command === 'hunt') report(store, id, Number(values.top ?? 15), values.json === true);
      return 0;
    } catch (error) {
      const halted = error instanceof CollectionHalted;
      store.finishRun(id, halted ? 'halted' : 'error', new Date().toISOString(), [
        (error as Error).message,
      ]);
      log(`${halted ? 'halted' : 'failed'}: ${(error as Error).message}`);
      log(`progress is saved — rerun the same command with --run ${id} to continue`);
      return halted ? 2 : 1;
    } finally {
      await context.fetcher.close();
      await context.session.close();
    }
  } finally {
    store.close();
  }
};

main().then(
  code => process.exit(code),
  error => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);

/** Written by `--profile -` callers that pipe a profile in; kept for the skill. */
export const writeProfile = (path: string, profile: Profile): void => {
  writeFileSync(path, JSON.stringify(profile, null, 2), 'utf8');
};
