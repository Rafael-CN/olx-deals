import { vi } from 'vitest';

// Global test setup
global.console = {
  ...console,
  // Optionally silence console.log during tests
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: console.warn,
  error: console.error,
};

// Playwright is deliberately NOT mocked here. A module-wide mock made
// chromium.launch return undefined in every test file, including the ones that
// need a real browser to prove the HTML parsing path — and it failed silently,
// as a missing property rather than an error. Tests that want a fake browser
// build one themselves with tests/mocks/playwright.mock.ts.

// Global timeout for all tests
vi.setConfig({ testTimeout: 30000 });
