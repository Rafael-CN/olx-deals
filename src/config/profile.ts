import { z } from 'zod';

/**
 * Every knob of a collection run, in one validated object.
 *
 * A run is described by data rather than by flags scattered across the CLI so
 * that it can be saved, diffed, replayed and resumed — a thousand-ad sweep that
 * cannot be reproduced is not a measurement. The CLI builds one of these from
 * flags or a JSON file; the skill builds one from what it asks the user.
 */

/** The 27 federative units, which are the coarsest shard axis olx.com.br offers. */
export const BRAZIL_STATES = [
  'ac',
  'al',
  'am',
  'ap',
  'ba',
  'ce',
  'df',
  'es',
  'go',
  'ma',
  'mg',
  'ms',
  'mt',
  'pa',
  'pb',
  'pe',
  'pi',
  'pr',
  'rj',
  'rn',
  'ro',
  'rr',
  'rs',
  'sc',
  'se',
  'sp',
  'to',
] as const;

export type BrazilState = (typeof BRAZIL_STATES)[number];

/**
 * Pacing. The defaults are deliberately timid: olx.com.br sits behind Cloudflare
 * and answers a burst with a 403 that lasts minutes, so throughput is bounded by
 * the block you avoid rather than the requests you fire.
 *
 * The governor never probes for the limit. It rises additively while clean and
 * falls multiplicatively on a block, which finds a workable rate without anyone
 * having to know what the real one is — and without hammering the site to learn.
 */
export const PacingSchema = z
  .object({
    startRequestsPerMinute: z.number().min(0.2).max(600).default(6),
    minRequestsPerMinute: z.number().min(0.2).max(600).default(1),
    maxRequestsPerMinute: z.number().min(1).max(600).default(15),
    /** Additive increase: +1 rpm after this many consecutive clean requests. */
    increaseAfterCleanRequests: z.number().min(1).default(40),
    /** Multiplicative decrease applied to the current rate on a block. */
    backoffFactor: z.number().min(0.1).max(0.95).default(0.4),
    /** First pause after a block; it doubles with each consecutive refusal. */
    cooldownSeconds: z.number().min(5).max(7200).default(300),
    /** Ceiling on that doubling. */
    maxCooldownSeconds: z.number().min(5).max(86400).default(3600),
    /** Consecutive blocks that end the run rather than slowing it further. */
    haltAfterConsecutiveBlocks: z.number().min(1).default(3),
    /** Random pause added to every request, so the cadence is not machine-flat. */
    jitterMs: z.number().min(0).max(120000).default(2500),
    /**
     * Requests between long idle gaps. Windowed rate limits forgive a pause far
     * more readily than a continuous trickle at the same average rate.
     */
    pauseEveryRequests: z.number().min(0).default(120),
    pauseForSeconds: z.number().min(0).default(180),
    /**
     * Pages fetched in parallel. One by default: concurrency buys latency, and
     * latency is not the constraint here — the block is.
     */
    concurrency: z.number().min(1).max(8).default(1),
  })
  .default({});

export type Pacing = z.infer<typeof PacingSchema>;

/**
 * How far a sweep is allowed to go. `maxRequests` is the honest budget knob: it
 * bounds wall-clock and exposure regardless of how the shard tree turns out.
 */
export const LimitsSchema = z
  .object({
    /** olx.com.br serves at most 100 pages, i.e. 5.000 ads, per distinct query. */
    adsPerShardCap: z.number().min(50).max(5000).default(5000),
    maxCards: z.number().min(1).default(5000),
    maxDetails: z.number().min(0).default(400),
    maxRequests: z.number().min(1).default(1500),
    maxShards: z.number().min(1).default(400),
    /** Give up splitting a shard this deep; it is emitted as truncated instead. */
    maxSplitDepth: z.number().min(1).max(12).default(6),
    maxRunMinutes: z.number().min(1).default(180),
    /**
     * Skip ads whose page was read within this many days. A repeat hunt over a
     * known product should cost almost nothing.
     */
    refreshDetailAfterDays: z.number().min(0).default(7),
  })
  .default({});

export type Limits = z.infer<typeof LimitsSchema>;

const StringListSchema = z.array(z.string().min(1)).default([]);

/**
 * Words that mark an ad as damaged, split by how disqualifying they are.
 *
 * Kept as data because it is the part most worth tuning per product: "linha
 * verde" is decisive for a phone screen and meaningless for a bicycle.
 */
export const DefectLexiconSchema = z
  .object({
    /** Ad is not the working product at all. */
    broken: StringListSchema,
    /** Real damage that a buyer would want to know about. */
    major: StringListSchema,
    /** Cosmetic or minor wear. */
    minor: StringListSchema,
    /** Not a defect: the ad is not selling the product (wanted ads, parts, rentals). */
    notForSale: StringListSchema,
    /**
     * Words that flip a nearby defect mention into a denial — "sem linha verde",
     * "não tem trinco". Without these, honest ads that list what is *not* wrong
     * are the first thing a defect filter throws away.
     */
    negators: StringListSchema,
    /** How many characters before a defect phrase a negator still cancels it. */
    negationWindow: z.number().min(1).max(120).default(28),
  })
  .default({});

export type DefectLexicon = z.infer<typeof DefectLexiconSchema>;

export const DEFAULT_DEFECT_LEXICON: DefectLexicon = DefectLexiconSchema.parse({
  broken: [
    'não liga',
    'nao liga',
    'não funciona',
    'nao funciona',
    'não carrega',
    'nao carrega',
    'retirada de peç',
    'retirada de pec',
    'para peças',
    'para pecas',
    'so para peças',
    'sucata',
    'placa queimada',
    'queimou',
    'tela quebrada',
    'display quebrado',
    'vidro quebrado',
    'sem reparo',
    'irrecuperável',
    'bloqueado icloud',
    'bloqueado no icloud',
    'conta google',
    'id bloqueado',
    'icloud bloqueado',
    'no gelo',
    'travado na conta',
  ],
  major: [
    'linha verde',
    'linha na tela',
    'linha vertical',
    'mancha na tela',
    'manchas na tela',
    'pixel queimado',
    'tela manchada',
    'sombra na tela',
    'trincado',
    'trincada',
    'trinco',
    'rachado',
    'rachadura',
    'quebrado',
    'quebrada',
    'oxidado',
    'oxidação',
    'caiu na água',
    'caiu na agua',
    'molhou',
    'tomou água',
    'bateria viciada',
    'face id não',
    'face id nao',
    'face id off',
    'touch id não',
    'biometria não',
    'câmera embaçada',
    'camera embaçada',
    'não tira foto',
    'botão não',
    'botao nao',
    'defeito',
    'com problema',
    'apresenta falha',
  ],
  minor: [
    'riscado',
    'riscada',
    'riscos',
    'risquinho',
    'marcas de uso',
    'sinais de uso',
    'amassado',
    'amassadinho',
    'detalhe na',
    'detalhes de uso',
    'pequeno detalhe',
    'bordas',
    'desgaste',
  ],
  notForSale: [
    'procuro',
    'compro ',
    'compra-se',
    'tenho interesse em comprar',
    'alugo',
    'aluguel',
    'apenas a capa',
    'somente a capa',
    'só a capa',
    'so a capa',
    'apenas capa',
    'somente a caixa',
    'só a caixa',
    'apenas a caixa',
    'consórcio',
    'consorcio',
    'dou entrada',
    'apenas o sinal',
    'película',
    'pelicula',
    'capinha',
  ],
  negators: [
    'sem',
    'não tem',
    'nao tem',
    'nenhum',
    'nenhuma',
    'zero',
    'livre de',
    'nada de',
    'não possui',
    'nao possui',
  ],
});

/** Seller quality gate. Every bound is optional: unset means "do not care". */
export const SellerGateSchema = z.object({
  minRating: z.number().min(0).max(5).optional(),
  minReviewCount: z.number().min(0).optional(),
  minSalesCompleted: z.number().min(0).optional(),
  /** cancelled / (cancelled + completed). Unset ignores cancellations entirely. */
  maxCancelRate: z.number().min(0).max(1).optional(),
  minAccountAgeMonths: z.number().min(0).optional(),
  maxDispatchDays: z.number().min(0).optional(),
  requireVerified: z.boolean().default(false),
  /** e.g. ["Telefone"] to insist OLX confirmed a phone number. */
  requireChannels: StringListSchema,
  /**
   * What to do when the seller card yielded nothing. Blocking on missing data
   * is safer for a purchase and throws away ads whose page simply did not
   * hydrate in time, so it is a choice rather than a default.
   */
  onUnknown: z.enum(['pass', 'fail']).default('pass'),
});

export type SellerGate = z.infer<typeof SellerGateSchema>;

/**
 * One triage step. `scope` says whether it can run on a search card or needs the
 * ad's own page, which is what lets the pipeline put every cheap filter before
 * the expensive fetch instead of trusting the author to order them correctly.
 */
export const StageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('price-range'),
    id: z.string().default('price-range'),
    min: z.number().min(0).optional(),
    max: z.number().min(0).optional(),
    /** Ads OLX shows without a price. */
    allowMissing: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('title-match'),
    id: z.string().default('title-match'),
    /** All of these must appear (each entry is a regex, case-insensitive). */
    require: StringListSchema,
    /** Any of these excludes the ad. */
    reject: StringListSchema,
  }),
  z.object({
    type: z.literal('for-sale'),
    id: z.string().default('for-sale'),
    /** Drops wanted-ads, rentals and accessory listings. */
    lexicon: DefectLexiconSchema.optional(),
  }),
  z.object({
    type: z.literal('recency'),
    id: z.string().default('recency'),
    maxAgeDays: z.number().min(1),
    onUnknown: z.enum(['pass', 'fail']).default('pass'),
  }),
  z.object({
    type: z.literal('has-image'),
    id: z.string().default('has-image'),
    min: z.number().min(1).default(1),
  }),
  z.object({
    type: z.literal('condition'),
    id: z.string().default('condition'),
    /** Values of the ad's "Condição" attribute to keep. */
    allow: StringListSchema,
    onUnknown: z.enum(['pass', 'fail']).default('pass'),
  }),
  z.object({
    type: z.literal('defects'),
    id: z.string().default('defects'),
    /** The worst severity still allowed through. */
    tolerate: z.enum(['none', 'minor', 'major']).default('minor'),
    lexicon: DefectLexiconSchema.optional(),
    /** Search the title too, not just the description. */
    includeTitle: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('seller'),
    id: z.string().default('seller'),
    gate: SellerGateSchema,
  }),
  z.object({
    type: z.literal('attribute'),
    id: z.string(),
    /** Exact attribute label as OLX renders it, e.g. "Saúde da bateria". */
    key: z.string().min(1),
    allow: StringListSchema,
    deny: StringListSchema,
    /** Regex alternative to allow/deny. */
    pattern: z.string().optional(),
    onUnknown: z.enum(['pass', 'fail']).default('pass'),
  }),
]);

export type Stage = z.infer<typeof StageSchema>;

/**
 * The gem hunt. The premise is that an ad is interesting when it is far below
 * what the *same product in comparable shape* sells for, so the reference set is
 * built from ads that passed the quality gates — otherwise every broken unit
 * drags the median down and real bargains stop standing out.
 */
export const GemConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Which ads set the going rate. 'clean' uses only ads that survived triage,
   * which is the honest baseline for "what a good one costs".
   */
  reference: z.enum(['clean', 'all']).default('clean'),
  /** Refuse to call anything a gem from a handful of comparables. */
  minReferenceSize: z.number().min(3).default(12),
  /** Minimum discount against the reference median. */
  minDiscountPct: z.number().min(0).max(0.95).default(0.3),
  /**
   * Distance below the median in robust units — (median - price) / MAD. Median
   * and MAD rather than mean and standard deviation because marketplace prices
   * are skewed and salted with R$ 1 placeholder listings.
   */
  minRobustZ: z.number().min(0).default(1.5),
  /**
   * Below this fraction of the median an ad is treated as suspect, not a bargain.
   * At a tenth of the going rate the listing is a scam, a typo, a down payment or
   * an accessory — not the product. Gems live in a band, not at the bottom.
   */
  implausibleBelowPct: z.number().min(0).max(1).default(0.25),
  /** Ads cheaper than this are never gems regardless of the ratio. */
  absoluteFloor: z.number().min(0).default(1),
  weights: z
    .object({
      discount: z.number().default(0.5),
      quality: z.number().default(0.25),
      seller: z.number().default(0.15),
      recency: z.number().default(0.1),
    })
    .default({}),
  /** Score at or above which a find is worth acting on now. */
  alertScore: z.number().min(0).max(1).default(0.7),
});

export type GemConfig = z.infer<typeof GemConfigSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(1),
  /** Free text passed to OLX's `q`. */
  query: z.string().min(1),
  /**
   * Category slug paths, e.g. "celulares" or
   * "autos-e-pecas/carros-vans-e-utilitarios". Empty searches every category.
   */
  categories: StringListSchema,
  /** UFs to sweep. Empty means all 27. */
  states: z.array(z.string().min(2)).default([]),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  /**
   * Always 'relevance' for a sweep, and not merely as a default: on olx.com.br
   * applying a sort changes *which* ads come back, and relevance is the widest
   * set. Ordering is done locally afterwards.
   */
  sortBy: z.enum(['relevance', 'date', 'price-asc', 'price-desc']).default('relevance'),
  pacing: PacingSchema,
  limits: LimitsSchema,
  stages: z.array(StageSchema).default([]),
  gems: GemConfigSchema.default({}),
  /** Where the SQLite file and the browser state live. */
  dataDir: z.string().default('.garimpo'),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const parseProfile = (input: unknown): Profile => ProfileSchema.parse(input);

/**
 * A sane starting point for hunting one specific used product: keep only ads
 * that are actually selling it, in usable shape, from a seller with a record.
 */
export const gemHuntPreset = (overrides: {
  name: string;
  query: string;
  require?: string[];
  reject?: string[];
  categories?: string[];
}): Profile =>
  parseProfile({
    name: overrides.name,
    query: overrides.query,
    categories: overrides.categories ?? [],
    stages: [
      { type: 'title-match', require: overrides.require ?? [], reject: overrides.reject ?? [] },
      { type: 'for-sale' },
      { type: 'has-image', min: 1 },
      { type: 'price-range', allowMissing: false },
      { type: 'defects', tolerate: 'minor' },
      {
        type: 'seller',
        gate: { maxCancelRate: 0.5, minAccountAgeMonths: 1, onUnknown: 'pass' },
      },
    ],
    gems: { enabled: true },
  });
