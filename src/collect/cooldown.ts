import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface BlockRecord {
  lastBlockAt: number;
  consecutiveRuns: number;
}

/**
 * Remembers being blocked across invocations.
 *
 * The governor backs off within a run, but a run ends. Nothing stopped the next
 * command from starting cold thirty seconds later and refusing to notice the
 * site had just said no — which is exactly how a temporary rate limit becomes an
 * argument with someone's edge. This makes the refusal outlive the process.
 *
 * The wait doubles for each run that ends in a block, and resets as soon as one
 * finishes clean.
 */
export class BlockMemory {
  private readonly path: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'last-block.json');
  }

  private read(): BlockRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as BlockRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * How much longer to wait before touching the site, in milliseconds. Zero when
   * the last run went fine.
   */
  remainingMs(baseCooldownSeconds: number, now: number = Date.now()): number {
    const record = this.read();
    if (!record) return 0;

    const required = baseCooldownSeconds * 1000 * 2 ** Math.max(0, record.consecutiveRuns - 1);
    return Math.max(0, record.lastBlockAt + required - now);
  }

  recordBlock(now: number = Date.now()): void {
    const previous = this.read();
    const record: BlockRecord = {
      lastBlockAt: now,
      consecutiveRuns: (previous?.consecutiveRuns ?? 0) + 1,
    };
    try {
      writeFileSync(this.path, JSON.stringify(record), 'utf8');
    } catch {
      // Losing the record only costs the next run its head start.
    }
  }

  /** A run that finished without a refusal clears the penalty. */
  recordClean(): void {
    try {
      if (existsSync(this.path))
        writeFileSync(this.path, JSON.stringify({ lastBlockAt: 0, consecutiveRuns: 0 }), 'utf8');
    } catch {
      // Same: harmless either way.
    }
  }
}

export const describeWait = (ms: number): string => {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`;
};
