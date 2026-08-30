import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_DEFECT_LEXICON,
  Profile,
  ProfileSchema,
  Stage,
  gemHuntPreset,
  parseProfile,
} from '../config/profile.js';

/**
 * Turns a command line into a validated Profile.
 *
 * A profile file is the primary interface and the flags are overrides on top of
 * it, rather than the other way round. That ordering matters for how this gets
 * used: a sweep worth running is worth keeping, and forty flags in shell history
 * is not a record of anything. The skill writes a file, passes it, and the file
 * is what gets stored with the run.
 */

export const CLI_OPTIONS = {
  profile: { type: 'string' },
  name: { type: 'string' },
  query: { type: 'string' },
  states: { type: 'string', multiple: true },
  categories: { type: 'string', multiple: true },
  'min-price': { type: 'string' },
  'max-price': { type: 'string' },
  require: { type: 'string', multiple: true },
  queries: { type: 'string', multiple: true },
  demote: { type: 'string', multiple: true },
  'min-match': { type: 'string' },
  sample: { type: 'string' },
  'sample-by': { type: 'string' },
  reject: { type: 'string', multiple: true },
  tolerate: { type: 'string' },
  'max-cards': { type: 'string' },
  'max-details': { type: 'string' },
  'max-requests': { type: 'string' },
  'max-shards': { type: 'string' },
  'max-minutes': { type: 'string' },
  rpm: { type: 'string' },
  'max-rpm': { type: 'string' },
  concurrency: { type: 'string' },
  cooldown: { type: 'string' },
  gems: { type: 'boolean' },
  'no-gems': { type: 'boolean' },
  'min-discount': { type: 'string' },
  'min-z': { type: 'string' },
  'alert-score': { type: 'string' },
  'min-reference': { type: 'string' },
  'seller-min-rating': { type: 'string' },
  'seller-min-sales': { type: 'string' },
  'seller-max-cancel-rate': { type: 'string' },
  'seller-min-age-months': { type: 'string' },
  'seller-require-verified': { type: 'boolean' },
  'seller-unknown': { type: 'string' },
  'max-age-days': { type: 'string' },
  'min-photos': { type: 'string' },
  condition: { type: 'string', multiple: true },
  'data-dir': { type: 'string' },
  run: { type: 'string' },
  top: { type: 'string' },
  channel: { type: 'string' },
  headed: { type: 'boolean' },
  'no-block-assets': { type: 'boolean' },
  gentle: { type: 'boolean' },
  window: { type: 'string' },
  force: { type: 'boolean' },
  'pause-every': { type: 'string' },
  'pause-for': { type: 'string' },
  'refresh-after-days': { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export type CliValues = Partial<Record<keyof typeof CLI_OPTIONS, string | boolean | string[]>>;

export interface ParsedCommand {
  readonly command: string;
  readonly values: CliValues;
}

export const parseCommandLine = (argv: readonly string[]): ParsedCommand => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  return { command: positionals[0] ?? 'help', values: values as CliValues };
};

const num = (values: CliValues, key: keyof typeof CLI_OPTIONS): number | undefined => {
  const raw = values[key];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number, got "${raw}"`);
  return parsed;
};

const list = (values: CliValues, key: keyof typeof CLI_OPTIONS): string[] | undefined => {
  const raw = values[key];
  if (raw === undefined) return undefined;
  const entries = Array.isArray(raw) ? raw : [String(raw)];
  // Accept both repeated flags and one comma-separated value, because both are
  // natural to type and the skill generates the latter.
  return entries
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
};

/** Replaces a stage of the same type, or appends it when absent. */
const upsertStage = (stages: Stage[], stage: Stage): Stage[] => {
  const index = stages.findIndex(existing => existing.type === stage.type);
  if (index < 0) return [...stages, stage];
  const copy = [...stages];
  copy[index] = stage;
  return copy;
};

const findStage = <T extends Stage['type']>(
  stages: readonly Stage[],
  type: T
): Extract<Stage, { type: T }> | undefined =>
  stages.find(stage => stage.type === type) as Extract<Stage, { type: T }> | undefined;

export const buildProfile = (values: CliValues): Profile => {
  const base: Profile = values.profile
    ? parseProfile(JSON.parse(readFileSync(String(values.profile), 'utf8')))
    : gemHuntPreset({
        name: String(values.name ?? values.query ?? 'garimpo'),
        query: String(values.query ?? ''),
        require: list(values, 'require') ?? [],
        reject: list(values, 'reject') ?? [],
        categories: list(values, 'categories') ?? [],
      });

  let stages = [...base.stages];

  const tolerate = values.tolerate ? String(values.tolerate) : undefined;
  if (tolerate) {
    if (!['none', 'minor', 'major'].includes(tolerate)) {
      throw new Error(`--tolerate must be none, minor or major, got "${tolerate}"`);
    }
    const existing = findStage(stages, 'defects');
    stages = upsertStage(stages, {
      ...(existing ?? { type: 'defects', id: 'defects', includeTitle: true }),
      type: 'defects',
      tolerate: tolerate as 'none' | 'minor' | 'major',
    });
  }

  const requireTerms = list(values, 'require');
  const rejectTerms = list(values, 'reject');
  if (requireTerms || rejectTerms) {
    const existing = findStage(stages, 'title-match');
    stages = upsertStage(stages, {
      type: 'title-match',
      id: existing?.id ?? 'title-match',
      require: requireTerms ?? existing?.require ?? [],
      reject: rejectTerms ?? existing?.reject ?? [],
    });
  }

  const sellerGateOverrides = {
    minRating: num(values, 'seller-min-rating'),
    minSalesCompleted: num(values, 'seller-min-sales'),
    maxCancelRate: num(values, 'seller-max-cancel-rate'),
    minAccountAgeMonths: num(values, 'seller-min-age-months'),
    requireVerified: values['seller-require-verified'] === true ? true : undefined,
    onUnknown: values['seller-unknown'] as 'pass' | 'fail' | undefined,
  };
  if (Object.values(sellerGateOverrides).some(value => value !== undefined)) {
    const existing = findStage(stages, 'seller');
    const gate = { ...(existing?.gate ?? { requireVerified: false, requireChannels: [] }) };
    for (const [key, value] of Object.entries(sellerGateOverrides)) {
      if (value !== undefined) (gate as Record<string, unknown>)[key] = value;
    }
    stages = upsertStage(stages, {
      type: 'seller',
      id: existing?.id ?? 'seller',
      gate: gate as never,
    });
  }

  const maxAgeDays = num(values, 'max-age-days');
  if (maxAgeDays !== undefined) {
    stages = upsertStage(stages, {
      type: 'recency',
      id: 'recency',
      maxAgeDays,
      onUnknown: 'pass',
    });
  }

  const minPhotos = num(values, 'min-photos');
  if (minPhotos !== undefined) {
    stages = upsertStage(stages, { type: 'has-image', id: 'has-image', min: minPhotos });
  }

  const conditions = list(values, 'condition');
  if (conditions) {
    stages = upsertStage(stages, {
      type: 'condition',
      id: 'condition',
      allow: conditions,
      onUnknown: 'pass',
    });
  }

  const priceStage = findStage(stages, 'price-range');
  const minPrice = num(values, 'min-price') ?? base.minPrice;
  const maxPrice = num(values, 'max-price') ?? base.maxPrice;
  if (minPrice !== undefined || maxPrice !== undefined) {
    stages = upsertStage(stages, {
      type: 'price-range',
      id: priceStage?.id ?? 'price-range',
      ...(minPrice === undefined ? {} : { min: minPrice }),
      ...(maxPrice === undefined ? {} : { max: maxPrice }),
      allowMissing: priceStage?.allowMissing ?? false,
    });
  }

  const wantsGems =
    values['no-gems'] === true ? false : values.gems === true ? true : base.gems.enabled;

  /**
   * For when finishing today matters less than never being blocked. Roughly one
   * request every half-minute, one page at a time, five minutes of silence every
   * hour of work, and ten minutes off at the first sign of a refusal.
   */
  const gentle =
    values.gentle === true
      ? {
          startRequestsPerMinute: 2,
          minRequestsPerMinute: 0.5,
          maxRequestsPerMinute: 4,
          concurrency: 1,
          jitterMs: 8000,
          cooldownSeconds: 600,
          haltAfterConsecutiveBlocks: 2,
          pauseEveryRequests: 60,
          pauseForSeconds: 300,
        }
      : {};

  const sampleBy = values['sample-by'] ? String(values['sample-by']) : undefined;
  if (sampleBy && !['match', 'price', 'bands', 'spread', 'random'].includes(sampleBy)) {
    throw new Error(`--sample-by must be match, price, bands, spread or random, got "${sampleBy}"`);
  }

  return ProfileSchema.parse({
    ...base,
    name: values.name ? String(values.name) : base.name,
    query: values.query ? String(values.query) : base.query,
    queries: list(values, 'queries') ?? base.queries,
    demote: list(values, 'demote') ?? list(values, 'reject') ?? base.demote,
    ...(num(values, 'min-match') === undefined ? {} : { minMatchScore: num(values, 'min-match') }),
    ...(sampleBy ? { sampleBy } : {}),
    states: list(values, 'states') ?? base.states,
    categories: list(values, 'categories') ?? base.categories,
    ...(minPrice === undefined ? {} : { minPrice }),
    ...(maxPrice === undefined ? {} : { maxPrice }),
    stages,
    pacing: {
      ...base.pacing,
      ...gentle,
      ...(num(values, 'rpm') === undefined ? {} : { startRequestsPerMinute: num(values, 'rpm') }),
      ...(num(values, 'max-rpm') === undefined
        ? {}
        : { maxRequestsPerMinute: num(values, 'max-rpm') }),
      ...(num(values, 'concurrency') === undefined
        ? {}
        : { concurrency: num(values, 'concurrency') }),
      ...(num(values, 'cooldown') === undefined
        ? {}
        : { cooldownSeconds: num(values, 'cooldown') }),
    },
    limits: {
      ...base.limits,
      ...(num(values, 'max-cards') === undefined ? {} : { maxCards: num(values, 'max-cards') }),
      // --sample is the same knob as --max-details, named for what it means to a
      // person: how many of the ranked candidates to actually go and read.
      // --max-details wins when both are given.
      ...(num(values, 'sample') === undefined ? {} : { maxDetails: num(values, 'sample') }),
      ...(num(values, 'max-details') === undefined
        ? {}
        : { maxDetails: num(values, 'max-details') }),
      ...(num(values, 'max-requests') === undefined
        ? {}
        : { maxRequests: num(values, 'max-requests') }),
      ...(num(values, 'max-shards') === undefined ? {} : { maxShards: num(values, 'max-shards') }),
      ...(num(values, 'max-minutes') === undefined
        ? {}
        : { maxRunMinutes: num(values, 'max-minutes') }),
    },
    gems: {
      ...base.gems,
      enabled: wantsGems,
      ...(num(values, 'min-discount') === undefined
        ? {}
        : { minDiscountPct: num(values, 'min-discount') }),
      ...(num(values, 'min-z') === undefined ? {} : { minRobustZ: num(values, 'min-z') }),
      ...(num(values, 'alert-score') === undefined
        ? {}
        : { alertScore: num(values, 'alert-score') }),
      ...(num(values, 'min-reference') === undefined
        ? {}
        : { minReferenceSize: num(values, 'min-reference') }),
    },
    dataDir: values['data-dir'] ? String(values['data-dir']) : base.dataDir,
  });
};

/** A fully populated profile, for the skill or a person to edit. */
export const profileTemplate = (): unknown => ({
  ...gemHuntPreset({
    name: 'exemplo-s22-ultra',
    query: 's22 ultra',
    require: ['s\\s*22', 'ultra'],
    reject: ['capa', 'capinha', 'pel[ií]cula', 'carregador', 'cabo', 'fone', 's21', 's23', 'plus'],
    categories: ['celulares'],
  }),
  states: [],
  minPrice: 800,
  maxPrice: 4000,
  stages: [
    {
      type: 'title-match',
      id: 'title-match',
      require: ['s\\s*22', 'ultra'],
      reject: ['capa', 's23'],
    },
    { type: 'for-sale', id: 'for-sale' },
    { type: 'has-image', id: 'has-image', min: 2 },
    { type: 'price-range', id: 'price-range', min: 800, max: 4000, allowMissing: false },
    { type: 'recency', id: 'recency', maxAgeDays: 60, onUnknown: 'pass' },
    {
      type: 'condition',
      id: 'condition',
      allow: ['Novo', 'Usado - Excelente', 'Usado - Bom'],
      onUnknown: 'pass',
    },
    { type: 'defects', id: 'defects', tolerate: 'minor', includeTitle: true },
    {
      type: 'attribute',
      id: 'battery',
      key: 'Saúde da bateria',
      allow: [],
      deny: [],
      pattern: 'Perfeita|Boa',
      onUnknown: 'pass',
    },
    {
      type: 'seller',
      id: 'seller',
      gate: {
        minAccountAgeMonths: 3,
        maxCancelRate: 0.34,
        requireVerified: true,
        requireChannels: [],
        onUnknown: 'pass',
      },
    },
  ],
  gems: {
    enabled: true,
    reference: 'clean',
    minReferenceSize: 12,
    minDiscountPct: 0.3,
    minRobustZ: 1.5,
    implausibleBelowPct: 0.25,
    absoluteFloor: 1,
    weights: { discount: 0.5, quality: 0.25, seller: 0.15, recency: 0.1 },
    alertScore: 0.7,
  },
  defectLexiconReference: DEFAULT_DEFECT_LEXICON,
});
