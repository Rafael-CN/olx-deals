import { Pacing } from '../config/profile.js';

export class CollectionHalted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionHalted';
  }
}

export interface GovernorStats {
  readonly requests: number;
  readonly blocks: number;
  readonly errors: number;
  readonly currentRpm: number;
  readonly waitedMs: number;
  readonly cooldownMs: number;
}

/**
 * Paces requests to olx.com.br and reacts to being blocked.
 *
 * The rate is found rather than configured: it rises by 1 rpm for every stretch
 * of clean requests and is multiplied down on every 403/429. That is deliberate.
 * The alternative — probing until the site says no — would mean deliberately
 * hammering someone else's servers to discover a threshold that is not published
 * and not stable, and the resulting number would be wrong by tomorrow.
 *
 * Consecutive blocks end the run. A collector that keeps retrying through a
 * block is both useless and rude.
 */
export class RateGovernor {
  private rpm: number;
  private cleanStreak = 0;
  private consecutiveBlocks = 0;
  private nextAllowedAt = 0;
  private requests = 0;
  private blocks = 0;
  private errors = 0;
  private waitedMs = 0;
  private cooldownMs = 0;

  constructor(
    private readonly pacing: Pacing,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random
  ) {
    this.rpm = pacing.startRequestsPerMinute;
  }

  /** Blocks until the next request is allowed to go out. */
  async acquire(): Promise<void> {
    const jitter = Math.floor(this.random() * this.pacing.jitterMs);
    const target = this.nextAllowedAt + jitter;
    const delay = target - this.now();

    if (delay > 0) {
      this.waitedMs += delay;
      await this.sleep(delay);
    }

    this.requests += 1;
    this.nextAllowedAt = Math.max(this.now(), target) + this.intervalMs();
  }

  reportSuccess(): void {
    this.consecutiveBlocks = 0;
    this.cleanStreak += 1;

    if (this.cleanStreak >= this.pacing.increaseAfterCleanRequests) {
      this.cleanStreak = 0;
      this.rpm = Math.min(this.rpm + 1, this.pacing.maxRequestsPerMinute);
    }
  }

  /**
   * A 403 or 429. Halves the rate, sits out the cooldown, and gives up entirely
   * once the site has refused this many times in a row — at that point the
   * answer is to come back later, not to keep asking more slowly.
   */
  reportBlocked(): void {
    this.blocks += 1;
    this.cleanStreak = 0;
    this.consecutiveBlocks += 1;
    this.rpm = Math.max(this.rpm * this.pacing.backoffFactor, this.pacing.minRequestsPerMinute);

    if (this.consecutiveBlocks >= this.pacing.haltAfterConsecutiveBlocks) {
      throw new CollectionHalted(
        `olx.com.br blocked ${this.consecutiveBlocks} requests in a row. Stopping so the run does ` +
          `not keep hammering a closed door — the collected ads are saved and the run can be ` +
          `resumed later with the same profile.`
      );
    }

    const cooldown = this.pacing.cooldownSeconds * 1000;
    this.cooldownMs += cooldown;
    this.nextAllowedAt = this.now() + cooldown;
  }

  /** A timeout or a transport error: worth slowing for, but not a refusal. */
  reportError(): void {
    this.errors += 1;
    this.cleanStreak = 0;
    this.rpm = Math.max(this.rpm * 0.85, this.pacing.minRequestsPerMinute);
  }

  get stats(): GovernorStats {
    return {
      requests: this.requests,
      blocks: this.blocks,
      errors: this.errors,
      currentRpm: Math.round(this.rpm * 10) / 10,
      waitedMs: this.waitedMs,
      cooldownMs: this.cooldownMs,
    };
  }

  private intervalMs(): number {
    return Math.round(60_000 / Math.max(this.rpm, 0.1));
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Distinguishes a refusal from an ordinary failure, wherever it surfaced. */
export const isBlockError = (error: unknown): boolean =>
  error instanceof Error && /\b(403|429)\b|blocked or rate-limited/i.test(error.message);
