import { createHash } from 'node:crypto';
import { Profile } from './profile.js';

/**
 * Which parts of a profile decide what a run *means*.
 *
 * A run is swept in phases, often across invocations — plan, collect, enrich,
 * gems — and every one of those is a chance for the profile to drift. The drift
 * was invisible: `startRun` never replaced `profile_json`, while `enrich` ran
 * card triage against whatever the current flags produced and `triage`/`gems`
 * re-read the stored profile as authoritative. So `enrich --profile v2 --run
 * <id>` sampled under v2 and judged under v1, and nothing said a word.
 *
 * Only fields that change which ads exist or which pass are listed here.
 * `sampleBy`, `sample`, `minMatchScore`, pacing and budgets are deliberately
 * absent: they are exactly the knobs the documented workflow turns between
 * enrich passes, and hashing them would turn ordinary use into an exit code —
 * which trains the operator to pass the override reflexively, and that is worse
 * than not checking at all.
 */
export const DECIDING_FIELDS = [
  'query',
  'queries',
  'demote',
  'states',
  'categories',
  'minPrice',
  'maxPrice',
  'sortBy',
  'stages',
  'gems',
] as const;

type DecidingField = (typeof DECIDING_FIELDS)[number];

/** Stable JSON: object keys sorted, so key order cannot change a hash. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        if (source[key] !== undefined) out[key] = canonical(source[key]);
        return out;
      }, {});
  }
  return value;
};

const decidingPart = (profile: Profile): Record<string, unknown> =>
  DECIDING_FIELDS.reduce<Record<string, unknown>>((out, field) => {
    const value = (profile as unknown as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = canonical(value);
    return out;
  }, {});

export const profileHash = (profile: Profile): string =>
  createHash('sha256')
    .update(JSON.stringify(decidingPart(profile)))
    .digest('hex')
    .slice(0, 16);

export interface ProfileChange {
  readonly field: DecidingField;
  readonly from: string;
  readonly to: string;
}

/** A short rendering of a field's value, for a diff a person has to read. */
const show = (value: unknown): string => {
  if (value === undefined) return '(unset)';
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : value.map(show).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(canonical(value));
  return String(value);
};

/**
 * What changed between the profile a run was started with and the one in hand.
 *
 * Field-level rather than a bare "these differ": the operator has to be able to
 * see that the price ceiling moved without diffing two JSON files by eye.
 */
export const profileDiff = (stored: Profile, incoming: Profile): ProfileChange[] => {
  const before = decidingPart(stored);
  const after = decidingPart(incoming);

  return DECIDING_FIELDS.flatMap(field => {
    const from = show(before[field]);
    const to = show(after[field]);
    return from === to ? [] : [{ field, from, to }];
  });
};
