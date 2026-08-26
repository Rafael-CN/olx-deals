import { DEFAULT_DEFECT_LEXICON, Stage } from '../config/profile.js';
import { atMost, findDefects, severityOfCondition, worseOf, Severity } from './defects.js';
import { assessSeller, scoreSeller } from './seller.js';
import { SellerInfo } from '../core/types.js';

/**
 * Everything a stage may look at. Detail fields are optional because the same
 * pipeline runs twice: once over search cards, before any ad page has been
 * fetched, and once over the ads that survived that pass.
 */
export interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly price?: number | undefined;
  readonly location?: string | undefined;
  readonly imageCount?: number | undefined;
  readonly publishedAt?: Date | undefined;
  readonly description?: string | undefined;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  readonly seller?: SellerInfo | undefined;
  /** True once the ad's own page has been read. */
  readonly enriched: boolean;
}

export interface StageResult {
  readonly id: string;
  readonly passed: boolean;
  readonly reason?: string | undefined;
  /** The stage could not judge without the ad page, so it deferred. */
  readonly skipped?: boolean;
}

export interface Verdict {
  readonly adId: string;
  readonly passed: boolean;
  readonly failedStage?: string | undefined;
  readonly reason?: string | undefined;
  readonly stages: StageResult[];
  /** Worst damage found, for later scoring. */
  readonly severity: Severity;
  readonly sellerScore: number;
}

/** Which stages can be judged from a search card alone. */
export const stageScope = (stage: Stage): 'card' | 'detail' => {
  switch (stage.type) {
    case 'price-range':
    case 'title-match':
    case 'recency':
    case 'has-image':
      return 'card';
    case 'for-sale':
      // Titles alone catch most wanted-ads; the description catches the rest.
      return 'card';
    default:
      return 'detail';
  }
};

const compile = (patterns: readonly string[]): RegExp[] =>
  patterns.map(pattern => {
    try {
      return new RegExp(pattern, 'iu');
    } catch {
      // A user-supplied pattern that is not valid regex is treated as a literal
      // rather than crashing a run that took an hour to collect.
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    }
  });

const pass = (id: string): StageResult => ({ id, passed: true });
const reject = (id: string, reason: string): StageResult => ({ id, passed: false, reason });
const defer = (id: string): StageResult => ({ id, passed: true, skipped: true });

/**
 * Runs one stage. A stage that needs the ad page but is handed a bare card
 * defers instead of guessing — that is what keeps an expensive filter from
 * either fetching early or silently passing everything.
 */
export const runStage = (stage: Stage, candidate: Candidate, now: Date): StageResult => {
  const id = 'id' in stage && stage.id ? stage.id : stage.type;

  if (stageScope(stage) === 'detail' && !candidate.enriched) return defer(id);

  switch (stage.type) {
    case 'price-range': {
      if (candidate.price === undefined) {
        return stage.allowMissing ? pass(id) : reject(id, 'no price stated');
      }
      if (stage.min !== undefined && candidate.price < stage.min) {
        return reject(id, `below R$ ${stage.min}`);
      }
      if (stage.max !== undefined && candidate.price > stage.max) {
        return reject(id, `above R$ ${stage.max}`);
      }
      return pass(id);
    }

    case 'title-match': {
      const missing = compile(stage.require).filter(pattern => !pattern.test(candidate.title));
      if (missing.length > 0) {
        return reject(id, `title lacks ${missing.map(p => p.source).join(', ')}`);
      }
      const hit = compile(stage.reject).find(pattern => pattern.test(candidate.title));
      if (hit) return reject(id, `title matches excluded ${hit.source}`);
      return pass(id);
    }

    case 'for-sale': {
      const lexicon = stage.lexicon ?? DEFAULT_DEFECT_LEXICON;
      const haystack = [candidate.title, candidate.enriched ? candidate.description : '']
        .filter(Boolean)
        .join('\n');
      const finding = findDefects(haystack, lexicon);
      if (finding.notForSale.length > 0) {
        const first = finding.notForSale[0];
        return reject(id, `not an offer to sell: "${first?.term}" in "${first?.context}"`);
      }
      return pass(id);
    }

    case 'recency': {
      if (!candidate.publishedAt) {
        return stage.onUnknown === 'pass' ? pass(id) : reject(id, 'no date on the card');
      }
      const ageDays = (now.getTime() - candidate.publishedAt.getTime()) / 86_400_000;
      return ageDays <= stage.maxAgeDays
        ? pass(id)
        : reject(id, `${Math.round(ageDays)} days old, limit ${stage.maxAgeDays}`);
    }

    case 'has-image': {
      const count = candidate.imageCount ?? 0;
      return count >= stage.min ? pass(id) : reject(id, `${count} photos, needs ${stage.min}`);
    }

    case 'condition': {
      const condition = candidate.attributes?.['Condição'];
      if (!condition) {
        return stage.onUnknown === 'pass' ? pass(id) : reject(id, 'condition not stated');
      }
      if (stage.allow.length === 0) return pass(id);
      const allowed = stage.allow.some(value => value.toLowerCase() === condition.toLowerCase());
      return allowed ? pass(id) : reject(id, `condition "${condition}" not allowed`);
    }

    case 'defects': {
      const lexicon = stage.lexicon ?? DEFAULT_DEFECT_LEXICON;
      const haystack = [stage.includeTitle ? candidate.title : '', candidate.description]
        .filter(Boolean)
        .join('\n');
      const finding = findDefects(haystack, lexicon);
      // The structured field and the free text are both evidence; the worse one
      // wins, because a seller who ticked "Bom" and then described a cracked
      // screen has described a cracked screen.
      const severity = worseOf(
        finding.severity,
        severityOfCondition(candidate.attributes?.['Condição'])
      );
      if (atMost(severity, stage.tolerate)) return pass(id);
      const worst = finding.hits.find(hit => hit.severity === finding.severity);
      return reject(
        id,
        worst
          ? `${severity}: "${worst.term}" in "${worst.context}"`
          : `${severity} condition per OLX's own field`
      );
    }

    case 'seller': {
      const assessment = assessSeller(candidate.seller, stage.gate, now);
      return assessment.passed ? pass(id) : reject(id, assessment.reason ?? 'seller gate');
    }

    case 'attribute': {
      const value = candidate.attributes?.[stage.key];
      if (!value) {
        return stage.onUnknown === 'pass' ? pass(id) : reject(id, `${stage.key} not stated`);
      }
      if (stage.pattern) {
        const [pattern] = compile([stage.pattern]);
        return pattern?.test(value)
          ? pass(id)
          : reject(id, `${stage.key} "${value}" does not match ${stage.pattern}`);
      }
      if (stage.deny.some(entry => entry.toLowerCase() === value.toLowerCase())) {
        return reject(id, `${stage.key} "${value}" is excluded`);
      }
      if (
        stage.allow.length > 0 &&
        !stage.allow.some(e => e.toLowerCase() === value.toLowerCase())
      ) {
        return reject(id, `${stage.key} "${value}" not in the allowed set`);
      }
      return pass(id);
    }
  }
};

/**
 * Runs the pipeline and stops at the first rejection, so the reported reason is
 * the one that actually decided it rather than the last of a list.
 */
export const triage = (
  candidate: Candidate,
  stages: readonly Stage[],
  now: Date = new Date()
): Verdict => {
  const results: StageResult[] = [];

  for (const stage of stages) {
    const result = runStage(stage, candidate, now);
    results.push(result);
    if (!result.passed) {
      return {
        adId: candidate.id,
        passed: false,
        failedStage: result.id,
        reason: result.reason,
        stages: results,
        severity: 'none',
        sellerScore: 0,
      };
    }
  }

  const defects = candidate.enriched
    ? findDefects([candidate.title, candidate.description].filter(Boolean).join('\n'))
    : undefined;

  return {
    adId: candidate.id,
    passed: true,
    stages: results,
    severity: candidate.enriched
      ? worseOf(
          defects?.severity ?? 'none',
          severityOfCondition(candidate.attributes?.['Condição'])
        )
      : 'none',
    sellerScore: candidate.enriched ? scoreSeller(candidate.seller, now) : 0,
  };
};
