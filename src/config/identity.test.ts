import { describe, it, expect } from 'vitest';
import { profileDiff, profileHash } from './identity.js';
import { ProfileSchema } from './profile.js';

const profile = (overrides: Record<string, unknown> = {}) =>
  ProfileSchema.parse({ name: 'test', query: 'redmagic 10 pro', ...overrides });

describe('profileHash', () => {
  it('is stable across two parses of the same profile', () => {
    expect(profileHash(profile())).toBe(profileHash(profile()));
  });

  it('changes when a field that decides which ads exist changes', () => {
    const base = profileHash(profile());

    expect(profileHash(profile({ maxPrice: 3000 }))).not.toBe(base);
    expect(profileHash(profile({ states: ['rs'] }))).not.toBe(base);
    expect(profileHash(profile({ queries: ['red magic 10 pro'] }))).not.toBe(base);
    expect(profileHash(profile({ demote: ['10s'] }))).not.toBe(base);
    expect(profileHash(profile({ sortBy: 'price-asc' }))).not.toBe(base);
  });

  it('ignores the knobs the documented workflow turns between passes', () => {
    // Hashing these would turn ordinary iteration into an exit code, and an
    // override the operator learns to pass reflexively is worse than no check.
    const base = profileHash(profile());

    expect(profileHash(profile({ sampleBy: 'spread' }))).toBe(base);
    expect(profileHash(profile({ minMatchScore: 70 }))).toBe(base);
    expect(profileHash(profile({ dataDir: '/somewhere/else' }))).toBe(base);
    expect(profileHash(profile({ name: 'another name' }))).toBe(base);
  });
});

describe('profileDiff', () => {
  it('names the field, and what it was against what it is', () => {
    const changes = profileDiff(profile(), profile({ maxPrice: 3000, states: ['rs', 'sc'] }));

    expect(changes).toEqual([
      { field: 'states', from: '(empty)', to: 'rs, sc' },
      { field: 'maxPrice', from: '(unset)', to: '3000' },
    ]);
  });

  it('is empty when nothing that decides anything moved', () => {
    expect(profileDiff(profile(), profile({ sampleBy: 'random' }))).toEqual([]);
  });
});
