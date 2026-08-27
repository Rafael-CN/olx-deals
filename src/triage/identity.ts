/**
 * Works out which listings are the same physical item.
 *
 * OLX serves every photo from `img.olx.com.br` under a numeric id that is stable
 * across sizes: a card's `thumbs700x500/47/477680195021345.webp` and the ad
 * page's `images/47/477680195021345.jpg` are the same photo. So two listings that
 * share a photo id were uploaded from the same picture — which, in a classifieds
 * corpus, almost always means the same object.
 *
 * That costs nothing to compute. The ids are already in the store, put there by
 * the card sweep, and none of this touches the network.
 *
 * It buys three things a price analysis badly needs:
 *
 *   - The median stops double-counting. One unit relisted five times is five
 *     rows pulling the going rate in whatever direction that seller chose.
 *   - A relist is a signal, not noise. An ad republished is an ad that did not
 *     sell, which is the most reliable evidence of a negotiable seller there is.
 *   - Photo reuse across *different* accounts is worth knowing about before
 *     sending anyone money.
 */

export interface PhotoRef {
  readonly adId: string;
  readonly photoId: string;
}

export type ClusterKind = 'relist' | 'multi-unit' | 'cross-seller';

export interface IdentityCluster {
  readonly photoIds: string[];
  readonly adIds: string[];
  readonly kind: ClusterKind;
  /** The ad chosen to represent the cluster in price statistics. */
  readonly representativeId: string;
  readonly sellers: string[];
  readonly reason: string;
}

export interface ClusterMember {
  readonly adId: string;
  readonly photoIds: readonly string[];
  readonly sellerName?: string | undefined;
  readonly title?: string | undefined;
  readonly price?: number | undefined;
  /** Newest first is what decides the representative. */
  readonly publishedAt?: Date | undefined;
}

/**
 * The numeric id inside an OLX image URL, or undefined for anything else.
 *
 * Matches both the card's thumbnail path and the ad page's full-size path, since
 * the id between them is the same.
 */
export const photoIdFrom = (url: string | undefined | null): string | undefined => {
  if (!url) return undefined;
  const match = url.match(/img\.olx\.com\.br\/(?:thumbs\d+x\d+|images)\/\d+\/(\d{8,})\./i);
  return match?.[1];
};

export const photoIdsFrom = (urls: ReadonlyArray<string | undefined>): string[] => {
  const ids = urls.map(photoIdFrom).filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
};

/**
 * Groups listings that share at least one photo, transitively.
 *
 * Transitive because a relisted ad often reuses only some of the original photos:
 * A shares a picture with B, B shares a different one with C, and all three are
 * the same phone. Union-find gets that; pairwise comparison does not.
 */
export const clusterByPhoto = (members: readonly ClusterMember[]): IdentityCluster[] => {
  const parent = new Map<string, string>();

  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    let walk = key;
    while (parent.get(walk) !== undefined && parent.get(walk) !== walk) {
      const next = parent.get(walk) as string;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  // Ads and photos share one namespace so a photo links every ad that used it.
  for (const member of members) {
    const adKey = `ad:${member.adId}`;
    if (!parent.has(adKey)) parent.set(adKey, adKey);
    for (const photoId of member.photoIds) union(adKey, `photo:${photoId}`);
  }

  const groups = new Map<string, ClusterMember[]>();
  for (const member of members) {
    if (member.photoIds.length === 0) continue;
    const root = find(`ad:${member.adId}`);
    groups.set(root, [...(groups.get(root) ?? []), member]);
  }

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => describeCluster(group))
    .sort((a, b) => b.adIds.length - a.adIds.length);
};

const describeCluster = (group: readonly ClusterMember[]): IdentityCluster => {
  const sellers = [...new Set(group.map(m => m.sellerName).filter((s): s is string => Boolean(s)))];
  const photoIds = [...new Set(group.flatMap(m => m.photoIds))];
  const adIds = group.map(m => m.adId);

  // Newest wins as the representative: an old duplicate is usually the listing
  // that already failed to sell, and its price is the stale one.
  const newest = [...group].sort(
    (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)
  )[0];

  const kind = classify(group, sellers);

  return {
    photoIds,
    adIds,
    kind,
    representativeId: newest?.adId ?? adIds[0] ?? '',
    sellers,
    reason: reasonFor(kind, group, sellers),
  };
};

const classify = (group: readonly ClusterMember[], sellers: readonly string[]): ClusterKind => {
  // More than one account behind the same photograph. Sometimes a person with two
  // accounts, sometimes a listing copied from someone else's ad.
  if (sellers.length > 1) return 'cross-seller';

  // One seller, same photos, but the listings differ in title or price. A shop
  // with several identical units does this, and those really are distinct items.
  const titles = new Set(group.map(m => (m.title ?? '').trim().toLowerCase()));
  const prices = new Set(group.map(m => m.price ?? -1));
  if (titles.size > 1 || prices.size > 1) return 'multi-unit';

  return 'relist';
};

const reasonFor = (
  kind: ClusterKind,
  group: readonly ClusterMember[],
  sellers: readonly string[]
): string => {
  switch (kind) {
    case 'cross-seller':
      return `the same photo appears under ${sellers.length} different sellers (${sellers.join(', ')}) — worth checking before contacting anyone`;
    case 'multi-unit':
      return `${group.length} listings from one seller sharing photos but differing in title or price — probably separate units of the same product`;
    case 'relist':
      return `${group.length} identical listings from one seller — the ad has been republished, which means it has not been selling`;
  }
};

/**
 * Ad ids to leave out of a price reference, keeping one per cluster.
 *
 * Only relists are collapsed. A shop with five identical phones genuinely has
 * five for sale, and dropping four of them would understate supply; a single
 * unit posted five times is one phone wearing five hats, and counting it five
 * times is what quietly moves a median.
 */
export const duplicateAdIds = (clusters: readonly IdentityCluster[]): Set<string> => {
  const drop = new Set<string>();
  for (const cluster of clusters) {
    if (cluster.kind !== 'relist') continue;
    for (const adId of cluster.adIds) {
      if (adId !== cluster.representativeId) drop.add(adId);
    }
  }
  return drop;
};

/** How many times an ad's photos have appeared under a different listing. */
export const relistCountFor = (clusters: readonly IdentityCluster[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const cluster of clusters) {
    if (cluster.kind === 'multi-unit') continue;
    for (const adId of cluster.adIds) counts.set(adId, cluster.adIds.length - 1);
  }
  return counts;
};
