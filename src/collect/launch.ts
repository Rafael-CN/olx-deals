import { Browser, LaunchOptions, chromium } from 'playwright';

/**
 * Playwright's default headless mode wants a separate `chromium_headless_shell`
 * download, which is easy to end up without even when a perfectly good Chromium
 * is installed. Rather than making every caller discover that through a launch
 * failure and pass `--channel` by hand, the usable build is found by trying.
 *
 * Order is deliberate: the bundled shell is lightest, the full bundled Chromium
 * is the next closest thing, and the system Chrome is the last resort because it
 * is the least predictable across machines.
 */
const CANDIDATES: ReadonlyArray<{ label: string; channel?: string }> = [
  { label: 'bundled headless shell' },
  { label: 'bundled chromium', channel: 'chromium' },
  { label: 'system chrome', channel: 'chrome' },
  { label: 'system edge', channel: 'msedge' },
];

export interface LaunchResult {
  readonly browser: Browser;
  readonly using: string;
}

export const launchChromium = async (
  options: LaunchOptions & { channel?: string | undefined } = {}
): Promise<LaunchResult> => {
  // An explicit choice is honoured as given: if the caller named a channel and it
  // does not work, that is worth an error rather than a silent substitution.
  if (options.channel) {
    return { browser: await chromium.launch(options), using: options.channel };
  }

  const failures: string[] = [];

  for (const candidate of CANDIDATES) {
    try {
      const browser = await chromium.launch({
        ...options,
        ...(candidate.channel ? { channel: candidate.channel } : {}),
      });
      return { browser, using: candidate.label };
    } catch (error) {
      failures.push(`${candidate.label}: ${firstLine(error)}`);
    }
  }

  throw new Error(
    `No usable Chromium. Tried:\n  ${failures.join('\n  ')}\n` +
      `Install one with: npx playwright install chromium`
  );
};

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'unknown error';
