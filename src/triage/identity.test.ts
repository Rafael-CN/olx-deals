import { describe, it, expect } from 'vitest';
import {
  ClusterMember,
  clusterByPhoto,
  duplicateAdIds,
  photoIdFrom,
  photoIdsFrom,
  relistCountFor,
} from './identity.js';

const member = (overrides: Partial<ClusterMember> & { adId: string }): ClusterMember => ({
  photoIds: [],
  sellerName: 'Marcio',
  title: 'RedMagic 10 Pro',
  price: 3500,
  publishedAt: new Date('2026-08-20T12:00:00Z'),
  ...overrides,
});

describe('photoIdFrom', () => {
  it('reads the same id from a card thumbnail and an ad-page image', () => {
    // Both URLs are the same photograph; the id between them is what proves it.
    expect(photoIdFrom('https://img.olx.com.br/thumbs700x500/47/477680195021345.webp')).toBe(
      '477680195021345'
    );
    expect(photoIdFrom('https://img.olx.com.br/images/47/477680195021345.jpg')).toBe(
      '477680195021345'
    );
  });

  it('ignores anything that is not an OLX photo', () => {
    expect(photoIdFrom('https://example.com/images/12/123456789012.jpg')).toBeUndefined();
    expect(photoIdFrom('https://img.olx.com.br/cd/vi/images/olx-logo.png')).toBeUndefined();
    expect(photoIdFrom(undefined)).toBeUndefined();
    expect(photoIdFrom('')).toBeUndefined();
  });

  it('deduplicates a listing own photo list', () => {
    expect(
      photoIdsFrom([
        'https://img.olx.com.br/thumbs700x500/47/477680195021345.webp',
        'https://img.olx.com.br/images/47/477680195021345.jpg',
        'https://img.olx.com.br/images/35/358657191381261.jpg',
        undefined,
      ])
    ).toEqual(['477680195021345', '358657191381261']);
  });
});

describe('clusterByPhoto', () => {
  it('leaves listings that share nothing alone', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'a', photoIds: ['1111111111'] }),
      member({ adId: 'b', photoIds: ['2222222222'] }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('links listings through a shared photo even when the rest differ', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'a', photoIds: ['1111111111', '2222222222'] }),
      member({ adId: 'b', photoIds: ['2222222222', '3333333333'] }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.adIds.sort()).toEqual(['a', 'b']);
  });

  it('links transitively, because a relist reuses only some of the photos', () => {
    // a-b share one picture, b-c share a different one. All three are one phone.
    const clusters = clusterByPhoto([
      member({ adId: 'a', photoIds: ['1111111111'] }),
      member({ adId: 'b', photoIds: ['1111111111', '2222222222'] }),
      member({ adId: 'c', photoIds: ['2222222222'] }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.adIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('calls one seller reposting the identical listing a relist', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'old', photoIds: ['1111111111'], publishedAt: new Date('2026-06-01') }),
      member({ adId: 'new', photoIds: ['1111111111'], publishedAt: new Date('2026-08-20') }),
    ]);

    expect(clusters[0]?.kind).toBe('relist');
    expect(clusters[0]?.reason).toMatch(/has not been selling/);
    // The newest listing represents the cluster: the old one is the stale price.
    expect(clusters[0]?.representativeId).toBe('new');
  });

  it('does not mistake a shop with several identical units for a relist', () => {
    // Same seller, same photos, but the listings differ — genuinely separate items.
    const clusters = clusterByPhoto([
      member({ adId: 'u1', photoIds: ['1111111111'], price: 3500, title: 'RedMagic 10 Pro 256GB' }),
      member({ adId: 'u2', photoIds: ['1111111111'], price: 3800, title: 'RedMagic 10 Pro 512GB' }),
    ]);

    expect(clusters[0]?.kind).toBe('multi-unit');
  });

  it('flags the same photograph appearing under different accounts', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'a', photoIds: ['1111111111'], sellerName: 'Marcio' }),
      member({ adId: 'b', photoIds: ['1111111111'], sellerName: 'Outra Pessoa' }),
    ]);

    expect(clusters[0]?.kind).toBe('cross-seller');
    expect(clusters[0]?.sellers.sort()).toEqual(['Marcio', 'Outra Pessoa']);
    expect(clusters[0]?.reason).toMatch(/before contacting anyone/);
  });

  it('skips listings with no photos rather than grouping them together', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'a', photoIds: [] }),
      member({ adId: 'b', photoIds: [] }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('orders the biggest clusters first', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'a1', photoIds: ['1111111111'] }),
      member({ adId: 'a2', photoIds: ['1111111111'] }),
      member({ adId: 'b1', photoIds: ['2222222222'] }),
      member({ adId: 'b2', photoIds: ['2222222222'] }),
      member({ adId: 'b3', photoIds: ['2222222222'] }),
    ]);

    expect(clusters[0]?.adIds).toHaveLength(3);
  });
});

describe('duplicateAdIds', () => {
  it('collapses a relist to one row so it stops moving the median', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'old', photoIds: ['1111111111'], publishedAt: new Date('2026-06-01') }),
      member({ adId: 'mid', photoIds: ['1111111111'], publishedAt: new Date('2026-07-01') }),
      member({ adId: 'new', photoIds: ['1111111111'], publishedAt: new Date('2026-08-01') }),
    ]);

    expect([...duplicateAdIds(clusters)].sort()).toEqual(['mid', 'old']);
  });

  it('keeps every unit of a shop listing, because they really are for sale', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'u1', photoIds: ['1111111111'], price: 3500 }),
      member({ adId: 'u2', photoIds: ['1111111111'], price: 3800 }),
    ]);

    expect(duplicateAdIds(clusters).size).toBe(0);
  });
});

describe('relistCountFor', () => {
  it('counts how many other listings carry an ad photos', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'a', photoIds: ['1111111111'] }),
      member({ adId: 'b', photoIds: ['1111111111'] }),
      member({ adId: 'c', photoIds: ['1111111111'] }),
    ]);

    const counts = relistCountFor(clusters);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('c')).toBe(2);
  });

  it('does not count a shop separate units as relists', () => {
    const clusters = clusterByPhoto([
      member({ adId: 'u1', photoIds: ['1111111111'], price: 100 }),
      member({ adId: 'u2', photoIds: ['1111111111'], price: 200 }),
    ]);
    expect(relistCountFor(clusters).size).toBe(0);
  });
});
