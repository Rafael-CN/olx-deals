import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Listing } from '../core/types.js';
import { Profile } from '../config/profile.js';
import { PlannedShard } from '../collect/shard.js';
import { parseBrl } from '../scrapers/olx/br-parsers.js';

/**
 * The collected corpus, on disk.
 *
 * Two things drive this design. First, a sweep of thousands of ads cannot live in
 * a chat transcript, so the rows go to SQLite and the caller reads aggregates —
 * that is the whole reason a CLI exists instead of tool calls. Second, runs get
 * interrupted, by a block or by a closed laptop, so every write is idempotent and
 * every shard records its own state: the same command run again resumes rather
 * than restarts.
 *
 * Ads are keyed globally, not per run, so a product swept last week is already
 * known this week and only its price needs refreshing.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  query         TEXT NOT NULL,
  profile_json  TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  notes_json    TEXT
);

CREATE TABLE IF NOT EXISTS shards (
  run_id       TEXT NOT NULL,
  key          TEXT NOT NULL,
  state        TEXT,
  category     TEXT,
  min_price    INTEGER,
  max_price    INTEGER,
  total_count  INTEGER NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0,
  pages_done   INTEGER NOT NULL DEFAULT 0,
  cards_seen   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  PRIMARY KEY (run_id, key)
);

CREATE TABLE IF NOT EXISTS ads (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  price          REAL,
  location       TEXT,
  image_url      TEXT,
  published_at   TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_ads (
  run_id   TEXT NOT NULL,
  ad_id    TEXT NOT NULL,
  shard    TEXT NOT NULL,
  PRIMARY KEY (run_id, ad_id)
);

CREATE TABLE IF NOT EXISTS ad_details (
  ad_id            TEXT PRIMARY KEY,
  fetched_at       TEXT NOT NULL,
  price            REAL,
  description      TEXT,
  category         TEXT,
  attributes_json  TEXT,
  seller_json      TEXT,
  image_count      INTEGER,
  canonical_url    TEXT,
  published_at     TEXT
);

CREATE TABLE IF NOT EXISTS triage (
  run_id   TEXT NOT NULL,
  ad_id    TEXT NOT NULL,
  stage    TEXT NOT NULL,
  passed   INTEGER NOT NULL,
  reason   TEXT,
  PRIMARY KEY (run_id, ad_id, stage)
);

CREATE TABLE IF NOT EXISTS verdicts (
  run_id       TEXT NOT NULL,
  ad_id        TEXT NOT NULL,
  phase        TEXT NOT NULL,
  passed       INTEGER NOT NULL,
  failed_stage TEXT,
  reason       TEXT,
  PRIMARY KEY (run_id, ad_id, phase)
);

CREATE TABLE IF NOT EXISTS gems (
  run_id          TEXT NOT NULL,
  ad_id           TEXT NOT NULL,
  score           REAL NOT NULL,
  discount_pct    REAL NOT NULL,
  robust_z        REAL NOT NULL,
  median          REAL NOT NULL,
  reference_size  INTEGER NOT NULL,
  verdict         TEXT NOT NULL,
  reasons_json    TEXT NOT NULL,
  PRIMARY KEY (run_id, ad_id)
);

CREATE INDEX IF NOT EXISTS ads_price ON ads (price);
CREATE INDEX IF NOT EXISTS run_ads_run ON run_ads (run_id);
CREATE INDEX IF NOT EXISTS verdicts_run ON verdicts (run_id, phase, passed);
CREATE INDEX IF NOT EXISTS gems_run_score ON gems (run_id, score DESC);
`;

export interface StoredAd {
  id: string;
  url: string;
  title: string;
  price: number | null;
  location: string | null;
  image_url: string | null;
  published_at: string | null;
}

export interface StoredDetail {
  ad_id: string;
  price: number | null;
  description: string | null;
  category: string | null;
  attributes_json: string | null;
  seller_json: string | null;
  image_count: number | null;
  published_at: string | null;
}

export type ShardStatus = 'pending' | 'running' | 'done' | 'truncated' | 'error';

export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'garimpo.db'));
    // WAL keeps a long write-heavy sweep from locking out concurrent readers.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- runs -----------------------------------------------------------------

  startRun(id: string, profile: Profile, startedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, name, query, profile_json, started_at, status)
         VALUES (?, ?, ?, ?, ?, 'running')
         ON CONFLICT(id) DO UPDATE SET status = 'running'`
      )
      .run(id, profile.name, profile.query, JSON.stringify(profile), startedAt);
  }

  finishRun(id: string, status: string, finishedAt: string, notes: string[]): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, finished_at = ?, notes_json = ? WHERE id = ?`)
      .run(status, finishedAt, JSON.stringify(notes), id);
  }

  getRun(id: string): { id: string; profile_json: string; status: string } | undefined {
    return this.db.prepare(`SELECT id, profile_json, status FROM runs WHERE id = ?`).get(id) as
      | { id: string; profile_json: string; status: string }
      | undefined;
  }

  latestRunId(): string | undefined {
    const row = this.db.prepare(`SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`).get() as
      | { id: string }
      | undefined;
    return row?.id;
  }

  listRuns(limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.query, r.started_at, r.finished_at, r.status,
                (SELECT COUNT(*) FROM run_ads WHERE run_id = r.id) AS ads
         FROM runs r ORDER BY r.started_at DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  // --- shards ---------------------------------------------------------------

  /** Written once by `plan`; `collect` then walks whatever is still pending. */
  saveShards(runId: string, shards: readonly PlannedShard[]): void {
    const insert = this.db.prepare(
      `INSERT INTO shards (run_id, key, state, category, min_price, max_price, total_count, truncated, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, key) DO UPDATE SET total_count = excluded.total_count`
    );
    this.db.exec('BEGIN');
    try {
      for (const shard of shards) {
        insert.run(
          runId,
          shard.key,
          shard.state ?? null,
          shard.category ?? null,
          shard.minPrice ?? null,
          shard.maxPrice ?? null,
          shard.totalCount,
          shard.truncated ? 1 : 0,
          shard.truncated ? 'truncated' : 'pending'
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pendingShards(runId: string): Array<{
    key: string;
    state: string | null;
    category: string | null;
    min_price: number | null;
    max_price: number | null;
    total_count: number;
    pages_done: number;
    cards_seen: number;
    status: string;
  }> {
    return this.db
      .prepare(
        `SELECT key, state, category, min_price, max_price, total_count, pages_done, cards_seen, status
         FROM shards WHERE run_id = ? AND status IN ('pending', 'running', 'truncated')
         ORDER BY total_count DESC`
      )
      .all(runId) as never;
  }

  updateShard(
    runId: string,
    key: string,
    patch: { status?: ShardStatus; pagesDone?: number; cardsSeen?: number; error?: string }
  ): void {
    const current = this.db
      .prepare(`SELECT pages_done, cards_seen, status FROM shards WHERE run_id = ? AND key = ?`)
      .get(runId, key) as { pages_done: number; cards_seen: number; status: string } | undefined;

    this.db
      .prepare(
        `UPDATE shards SET status = ?, pages_done = ?, cards_seen = ?, error = ? WHERE run_id = ? AND key = ?`
      )
      .run(
        patch.status ?? current?.status ?? 'pending',
        patch.pagesDone ?? current?.pages_done ?? 0,
        patch.cardsSeen ?? current?.cards_seen ?? 0,
        patch.error ?? null,
        runId,
        key
      );
  }

  shardSummary(runId: string): Array<{ status: string; n: number; ads: number }> {
    return this.db
      .prepare(
        `SELECT status, COUNT(*) AS n, COALESCE(SUM(cards_seen), 0) AS ads
         FROM shards WHERE run_id = ? GROUP BY status`
      )
      .all(runId) as never;
  }

  // --- ads ------------------------------------------------------------------

  /**
   * Upserts a page of cards. The ad row is global so re-seeing an ad refreshes
   * its price and last-seen time instead of duplicating it; the run link records
   * that this sweep saw it.
   */
  saveCards(runId: string, shardKey: string, listings: readonly Listing[], seenAt: string): number {
    const upsertAd = this.db.prepare(
      `INSERT INTO ads (id, url, title, price, location, image_url, published_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         price = COALESCE(excluded.price, ads.price),
         location = COALESCE(excluded.location, ads.location),
         image_url = COALESCE(excluded.image_url, ads.image_url),
         published_at = COALESCE(excluded.published_at, ads.published_at),
         last_seen_at = excluded.last_seen_at`
    );
    const linkRun = this.db.prepare(
      `INSERT INTO run_ads (run_id, ad_id, shard) VALUES (?, ?, ?)
       ON CONFLICT(run_id, ad_id) DO NOTHING`
    );

    let fresh = 0;
    this.db.exec('BEGIN');
    try {
      for (const listing of listings) {
        upsertAd.run(
          listing.id,
          listing.url,
          listing.title,
          parseBrl(listing.price) ?? null,
          listing.location ?? null,
          listing.imageUrl ?? null,
          listing.publishedAt?.toISOString() ?? null,
          seenAt,
          seenAt
        );
        const result = linkRun.run(runId, listing.id, shardKey);
        if (result.changes > 0) fresh += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return fresh;
  }

  countRunAds(runId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM run_ads WHERE run_id = ?`)
      .get(runId) as { n: number };
    return row.n;
  }

  runAds(runId: string): StoredAd[] {
    return this.db
      .prepare(
        `SELECT a.id, a.url, a.title, a.price, a.location, a.image_url, a.published_at
         FROM ads a JOIN run_ads r ON r.ad_id = a.id WHERE r.run_id = ?`
      )
      .all(runId) as never;
  }

  // --- details --------------------------------------------------------------

  saveDetail(listing: Listing, fetchedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO ad_details (ad_id, fetched_at, price, description, category, attributes_json,
                                 seller_json, image_count, canonical_url, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ad_id) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           price = excluded.price,
           description = excluded.description,
           category = excluded.category,
           attributes_json = excluded.attributes_json,
           seller_json = excluded.seller_json,
           image_count = excluded.image_count,
           canonical_url = excluded.canonical_url,
           published_at = excluded.published_at`
      )
      .run(
        listing.id,
        fetchedAt,
        parseBrl(listing.price) ?? null,
        listing.description ?? null,
        listing.category ?? null,
        listing.attributes ? JSON.stringify(listing.attributes) : null,
        listing.seller ? JSON.stringify(listing.seller) : null,
        listing.imageUrls?.length ?? null,
        listing.url,
        listing.publishedAt?.toISOString() ?? null
      );
  }

  /**
   * Ads that passed card-level triage and still need their page read.
   *
   * "Still need" includes ads read long enough ago to be stale: a repeat hunt
   * over a known product should cost almost nothing, so anything fetched inside
   * the freshness window is skipped rather than fetched again.
   */
  adsAwaitingDetail(runId: string, limit: number, refreshAfterDays?: number): StoredAd[] {
    // Omitted means never re-read: the safe default, since re-reading is the
    // expensive mistake. A number re-reads anything older than that.
    const cutoff =
      refreshAfterDays === undefined
        ? ''
        : new Date(Date.now() - refreshAfterDays * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT a.id, a.url, a.title, a.price, a.location, a.image_url, a.published_at
         FROM ads a
         JOIN run_ads r ON r.ad_id = a.id
         JOIN verdicts v ON v.ad_id = a.id AND v.run_id = r.run_id AND v.phase = 'card'
         LEFT JOIN ad_details d ON d.ad_id = a.id
         WHERE r.run_id = ? AND v.passed = 1
           AND (d.ad_id IS NULL OR d.fetched_at < ?)
         ORDER BY a.price ASC NULLS LAST
         LIMIT ?`
      )
      .all(runId, cutoff, limit) as never;
  }

  detailsFor(runId: string): Array<StoredAd & StoredDetail> {
    return this.db
      .prepare(
        `SELECT a.id, a.url, a.title, a.location, a.image_url,
                COALESCE(d.price, a.price) AS price,
                d.ad_id, d.description, d.category, d.attributes_json, d.seller_json,
                d.image_count, COALESCE(d.published_at, a.published_at) AS published_at
         FROM ad_details d
         JOIN ads a ON a.id = d.ad_id
         JOIN run_ads r ON r.ad_id = a.id
         WHERE r.run_id = ?`
      )
      .all(runId) as never;
  }

  // --- verdicts -------------------------------------------------------------

  saveVerdicts(
    runId: string,
    phase: 'card' | 'detail',
    verdicts: ReadonlyArray<{
      adId: string;
      passed: boolean;
      failedStage?: string | undefined;
      reason?: string | undefined;
      stages: ReadonlyArray<{ id: string; passed: boolean; reason?: string | undefined }>;
    }>
  ): void {
    const upsertVerdict = this.db.prepare(
      `INSERT INTO verdicts (run_id, ad_id, phase, passed, failed_stage, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, ad_id, phase) DO UPDATE SET
         passed = excluded.passed, failed_stage = excluded.failed_stage, reason = excluded.reason`
    );
    const upsertStage = this.db.prepare(
      `INSERT INTO triage (run_id, ad_id, stage, passed, reason) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, ad_id, stage) DO UPDATE SET passed = excluded.passed, reason = excluded.reason`
    );

    this.db.exec('BEGIN');
    try {
      for (const verdict of verdicts) {
        upsertVerdict.run(
          runId,
          verdict.adId,
          phase,
          verdict.passed ? 1 : 0,
          verdict.failedStage ?? null,
          verdict.reason ?? null
        );
        for (const stage of verdict.stages) {
          upsertStage.run(
            runId,
            verdict.adId,
            stage.id,
            stage.passed ? 1 : 0,
            stage.reason ?? null
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Where ads were lost, per stage. This is the number that tells you whether a
   * filter is doing useful work or quietly eating the whole corpus.
   */
  funnel(runId: string): Array<{ stage: string; passed: number; failed: number }> {
    return this.db
      .prepare(
        `SELECT stage,
                SUM(passed) AS passed,
                SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed
         FROM triage WHERE run_id = ? GROUP BY stage ORDER BY failed DESC`
      )
      .all(runId) as never;
  }

  rejectionReasons(
    runId: string,
    phase: 'card' | 'detail',
    limit: number
  ): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT failed_stage AS stage, reason, COUNT(*) AS n
         FROM verdicts WHERE run_id = ? AND phase = ? AND passed = 0
         GROUP BY failed_stage, reason ORDER BY n DESC LIMIT ?`
      )
      .all(runId, phase, limit) as never;
  }

  // --- gems -----------------------------------------------------------------

  saveGems(
    runId: string,
    rows: ReadonlyArray<{
      adId: string;
      score: number;
      discountPct: number;
      robustZ: number;
      median: number;
      referenceSize: number;
      verdict: string;
      reasons: string[];
    }>
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO gems (run_id, ad_id, score, discount_pct, robust_z, median, reference_size, verdict, reasons_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, ad_id) DO UPDATE SET
         score = excluded.score, discount_pct = excluded.discount_pct, robust_z = excluded.robust_z,
         median = excluded.median, reference_size = excluded.reference_size,
         verdict = excluded.verdict, reasons_json = excluded.reasons_json`
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        insert.run(
          runId,
          row.adId,
          row.score,
          row.discountPct,
          row.robustZ,
          row.median,
          row.referenceSize,
          row.verdict,
          JSON.stringify(row.reasons)
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  topGems(runId: string, limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT g.score, g.discount_pct, g.robust_z, g.median, g.reference_size, g.verdict,
                g.reasons_json, a.id, a.title, a.url, a.location,
                COALESCE(d.price, a.price) AS price,
                d.seller_json, d.attributes_json
         FROM gems g
         JOIN ads a ON a.id = g.ad_id
         LEFT JOIN ad_details d ON d.ad_id = a.id
         WHERE g.run_id = ? AND g.verdict != 'rejected'
         ORDER BY g.score DESC LIMIT ?`
      )
      .all(runId, limit) as never;
  }

  priceStats(runId: string): Record<string, unknown> {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(price) AS min, MAX(price) AS max, AVG(price) AS avg
         FROM ads a JOIN run_ads r ON r.ad_id = a.id
         WHERE r.run_id = ? AND a.price IS NOT NULL`
      )
      .get(runId) as never;
  }
}
