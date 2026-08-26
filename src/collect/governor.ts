import { Pacing } from '../config/profile.js';
import { ActiveWindow, msUntilOpen, parseWindow } from './window.js';

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
  readonly lastBlockAt?: number | undefined;
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
  private lastPauseAtRequest = -1;
  private ceiling: number;
  private readonly window: ActiveWindow | undefined;
  /** Told how long the run is about to sit out, so it can say so. */
  onWindowClosed?: ((waitMs: number) => void) | undefined;
  private requests = 0;
  private blocks = 0;
  private lastBlockAt: number | undefined;
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
    this.ceiling = pacing.maxRequestsPerMinute;
    this.window = pacing.activeWindow ? parseWindow(pacing.activeWindow) : undefined;
  }

  /**
   * Inserts a long idle gap every N requests.
   *
   * Rate limits are usually windowed, so stopping dead for a few minutes every
   * few hundred requests reads very differently from trickling continuously for
   * hours, even at the same average rate.
   */
  private async pauseIfDue(): Promise<void> {
    const every = this.pacing.pauseEveryRequests;
    if (every <= 0 || this.requests === 0 || this.requests % every !== 0) return;
    if (this.requests === this.lastPauseAtRequest) return;

    this.lastPauseAtRequest = this.requests;
    const pause = this.pacing.pauseForSeconds * 1000;
    this.cooldownMs += pause;
    await this.sleep(pause);
  }

  /** Sleeps out the closed hours, if the run was given a window to work in. */
  private async waitForWindow(): Promise<void> {
    if (!this.window) return;
    const wait = msUntilOpen(this.window, new Date(this.now()));
    if (wait <= 0) return;

    this.cooldownMs += wait;
    this.onWindowClosed?.(wait);
    await this.sleep(wait);
  }

  /** Blocks until the next request is allowed to go out. */
  async acquire(): Promise<void> {
    await this.waitForWindow();
    await this.pauseIfDue();

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

  /**
   * Lowers the ceiling, and the current rate with it. Used for a crawl delay the
   * site published: it can only ever slow us down, never license a speed-up.
   */
  imposeCeiling(rpm: number): void {
    this.ceiling = Math.min(this.ceiling, rpm);
    this.rpm = Math.min(this.rpm, this.ceiling);
  }

  reportSuccess(): void {
    this.consecutiveBlocks = 0;
    this.cleanStreak += 1;

    if (this.cleanStreak >= this.pacing.increaseAfterCleanRequests) {
      this.cleanStreak = 0;
      this.rpm = Math.min(this.rpm + 1, this.ceiling);
    }
  }

  /**
   * A 403 or 429. Halves the rate, sits out the cooldown, and gives up entirely
   * once the site has refused this many times in a row — at that point the
   * answer is to come back later, not to keep asking more slowly.
   */
  reportBlocked(retryAfterSeconds?: number): void {
    this.blocks += 1;
    this.cleanStreak = 0;
    this.consecutiveBlocks += 1;
    this.rpm = Math.max(this.rpm * this.pacing.backoffFactor, this.pacing.minRequestsPerMinute);

    // The cooldown doubles with each consecutive refusal. A fixed one assumes the
    // block lasts a known time; doubling assumes only that the site meant it more
    // the second time, which is the safer assumption when the goal is to not be
    // banned rather than to finish quickly.
    const escalated = this.pacing.cooldownSeconds * 2 ** (this.consecutiveBlocks - 1);
    // The server sometimes says how long to wait. Believe it when it does, and
    // never wait less than the escalation would have imposed anyway.
    const seconds = Math.min(
      Math.max(escalated, retryAfterSeconds ?? 0),
      this.pacing.maxCooldownSeconds
    );
    const cooldown = seconds * 1000;
    this.cooldownMs += cooldown;
    this.nextAllowedAt = this.now() + cooldown;
    this.lastBlockAt = this.now();

    if (this.consecutiveBlocks >= this.pacing.haltAfterConsecutiveBlocks) {
      throw new CollectionHalted(
        `olx.com.br refused ${this.consecutiveBlocks} requests in a row. Stopping so the run does ` +
          `not keep knocking on a closed door — everything collected is saved, and the same ` +
          `command resumes where it left off. Wait at least ${Math.round(seconds / 60)} minutes.`
      );
    }
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
      ...(this.lastBlockAt === undefined ? {} : { lastBlockAt: this.lastBlockAt }),
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
