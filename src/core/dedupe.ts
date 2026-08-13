/**
 * Recipient de-duplication.
 *
 * The spec's rules resolve into a two-stage merge, which matters: a single-stage merge
 * keyed only on the mailing address would fuse unrelated companies that happen to share
 * a corporate-secretary address onto one letter.
 *
 *   Stage A — merge CO-OWNERS.
 *     Key: Target + Neighbourhood + mailing address + property.
 *     "If property address and mailing address are the same, use &"
 *     -> JANE XIA, LONG GAN  ->  "JANE XIA & LONG GAN"
 *
 *   Stage B — merge PROPERTIES.
 *     Key: Target + Neighbourhood + mailing address + merged owner name.
 *     "Address (same Target, Neighborhood, Owner)"
 *     -> 27 CLUB STREET + 29 CLUB STREET -> "27 / 29 CLUB STREET SINGAPORE 069413 / 14"
 *
 * Anything that differs in Target, Neighbourhood or owner mailing address stays separate,
 * per the spec's "keep separate" rules.
 */
import { OwnerRow, RecipientGroup } from './types.js';
import { mailingAddressKey, mergeAddresses } from './address.js';
import { collapseToOwnersOf, distinctOwnerNames as distinctNames, joinOwnerNames } from './names.js';
import { normKey, squash, uniq, uniqBy } from './text.js';

export interface DedupeOptions {
  /** More than this many distinct owner names collapses to "Owners of ___". */
  maxOwnersBeforeCollapse: number;
  /** Owner names longer than this collapse to "Owners of ___". */
  maxOwnerNameLength: number;
  /** Add the owner name to the Stage A key, so co-owners never merge. */
  groupByOwnerName: boolean;
}

export interface DedupeAuditEntry {
  stage: 'A' | 'B';
  key: string;
  sourceRows: number[];
  before: string[];
  after: string;
  action: string;
}

export interface DedupeResult {
  groups: RecipientGroup[];
  audit: DedupeAuditEntry[];
}

/** Identity of the physical property, used to decide "same property". */
function propertyKey(row: OwnerRow): string {
  if (row.property.postal) return `P:${row.property.postal}`;
  if (row.addressId) return `ID:${normKey(row.addressId)}`;
  return `A:${normKey(row.property.raw)}`;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

export function dedupe(rows: OwnerRow[], options: DedupeOptions): DedupeResult {
  const audit: DedupeAuditEntry[] = [];

  // ---- Stage A: co-owners of the same property sharing one mailing address ----
  const stageAKey = (r: OwnerRow) =>
    [
      normKey(r.target),
      normKey(r.neighbourhood),
      mailingAddressKey(r.ownerAddress),
      propertyKey(r),
      options.groupByOwnerName ? normKey(r.ownerName) : '',
    ].join('||');

  interface StageA {
    key: string;
    members: OwnerRow[];
    ownerNames: string[];
    mergedName: string;
  }

  const stageA: StageA[] = [];
  for (const [key, members] of groupBy(rows, stageAKey)) {
    const ownerNames = distinctNames(members.map((m) => m.ownerName));
    const mergedName = joinOwnerNames(ownerNames);
    if (ownerNames.length > 1) {
      audit.push({
        stage: 'A',
        key,
        sourceRows: uniq(members.map((m) => m.sourceRow)),
        before: ownerNames,
        after: mergedName,
        action: `Joined ${ownerNames.length} co-owners with "&" (same property, same mailing address)`,
      });
    }
    stageA.push({ key, members, ownerNames, mergedName });
  }

  // ---- Stage B: the same owner's properties within one Target + Neighbourhood ----
  //
  // Buckets are first grouped by Target + Neighbourhood + mailing address, then split
  // into clusters that share at least one owner name. The overlap test is what makes
  // both of these come out right:
  //
  //   "JANE XIA & LONG GAN" at 27 Club St and "JANE XIA" at 29 Club St share JANE XIA,
  //   so they merge into one letter covering 27 / 29 — not two letters to one household.
  //
  //   "ALPHA HOLDINGS PTE LTD" and "BETA HOLDINGS PTE LTD" share a corporate-secretary
  //   mailing address but no owner, so they stay separate. Merging them would put two
  //   unrelated companies on one offer letter.
  const stageBBucketKey = (a: StageA) => {
    const first = a.members[0];
    return [
      normKey(first.target),
      normKey(first.neighbourhood),
      mailingAddressKey(first.ownerAddress),
    ].join('||');
  };

  const groups: RecipientGroup[] = [];

  for (const [bucketKey, bucketItems] of groupBy(stageA, stageBBucketKey)) {
    for (const cluster of clusterBySharedOwner(bucketItems)) {
      buildGroup(bucketKey, cluster);
    }
  }

  return { groups, audit };

  function buildGroup(bucketKey: string, bucket: StageA[]): void {
    const key = `${bucketKey}||${normKey(
      distinctNames(bucket.flatMap((b) => b.ownerNames)).join(' & '),
    )}`;
    const members = bucket.flatMap((b) => b.members);
    const first = members[0];

    // Distinct physical properties, so the same property listed twice is not doubled up.
    const properties = uniqBy(
      members.map((m) => m.property),
      (p) => `${p.postal}|${normKey(p.raw)}`,
    );

    const merged = mergeAddresses(properties);

    const distinctOwnerNames = distinctNames(members.map((m) => m.ownerName));
    let registeredProprietor = joinOwnerNames(distinctOwnerNames);
    const notes: string[] = [];

    if (properties.length > 1) {
      audit.push({
        stage: 'B',
        key,
        sourceRows: uniq(members.map((m) => m.sourceRow)),
        before: properties.map((p) => p.raw),
        after: merged.fullAddress,
        action: merged.multiStreet
          ? `Merged ${properties.length} properties across ${countStreets(properties)} streets with ";"`
          : `Merged ${properties.length} properties on one street (numbers "/", postal collapsed)`,
      });
    }

    // Effective owner count: the number of distinct names we hold, or the larger count
    // a source cell declared inline ("Total 18 owners: ...").
    const declared = Math.max(
      0,
      ...members.map((m) => m.declaredOwnerCount ?? 0),
    );
    const effectiveOwnerCount = Math.max(distinctOwnerNames.length, declared);

    // Step 7: too many owners, or a name too long to print on an envelope.
    if (effectiveOwnerCount > options.maxOwnersBeforeCollapse) {
      const before = registeredProprietor;
      registeredProprietor = collapseToOwnersOf(merged.address);
      notes.push(
        `Collapsed ${effectiveOwnerCount} owners to "Owners of ___" (limit ${options.maxOwnersBeforeCollapse})`,
      );
      audit.push({
        stage: 'B',
        key,
        sourceRows: uniq(members.map((m) => m.sourceRow)),
        before: [before],
        after: registeredProprietor,
        action: 'Collapsed to "Owners of ___" — more owners than the configured limit',
      });
    } else if (registeredProprietor.length > options.maxOwnerNameLength) {
      const before = registeredProprietor;
      registeredProprietor = collapseToOwnersOf(merged.address);
      notes.push(
        `Collapsed name of ${before.length} characters to "Owners of ___" (limit ${options.maxOwnerNameLength})`,
      );
      audit.push({
        stage: 'B',
        key,
        sourceRows: uniq(members.map((m) => m.sourceRow)),
        before: [before],
        after: registeredProprietor,
        action: 'Collapsed to "Owners of ___" — name longer than the configured limit',
      });
    }

    groups.push({
      key,
      target: first.target,
      neighbourhood: first.neighbourhood,
      landUse: first.landUse,
      tenure: first.tenure,
      members,
      address: merged.address,
      fullAddress: merged.fullAddress,
      registeredProprietor,
      mailingAddress: squash(first.ownerAddress),
      distinctOwnerNames,
      notes: uniq([...members.flatMap((m) => m.notes), ...notes]),
    });
  }
}

function countStreets(properties: { street: string }[]): number {
  return uniq(properties.map((p) => normKey(p.street))).length;
}

/**
 * Split a set of Stage A buckets into clusters whose owner-name sets overlap, directly
 * or through a chain. Two buckets end up together when they share at least one owner.
 */
function clusterBySharedOwner<T extends { ownerNames: string[] }>(items: T[]): T[][] {
  if (items.length <= 1) return items.length ? [items] : [];

  // Union-find over bucket indices, linked by shared owner-name keys.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const firstSeenAt = new Map<string, number>();
  items.forEach((item, i) => {
    for (const name of item.ownerNames) {
      const key = normKey(name);
      if (!key) continue;
      const seen = firstSeenAt.get(key);
      if (seen === undefined) firstSeenAt.set(key, i);
      else union(seen, i);
    }
  });

  const clusters = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(item);
  });
  return [...clusters.values()];
}

/**
 * Build the "Duplicate Owner / Owner Addresses" column (L).
 *
 * For each recipient, list the OTHER recipients that share the same owner name or the
 * same mailing address, with their neighbourhood and address — the information step 7
 * asks a human to review before sending.
 */
export function buildDuplicateIndex(groups: RecipientGroup[]): Map<string, string> {
  const byName = new Map<string, number[]>();
  const byAddress = new Map<string, number[]>();

  groups.forEach((g, i) => {
    for (const name of g.distinctOwnerNames) {
      const k = normKey(name);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k)!.push(i);
    }
    const ak = mailingAddressKey(g.mailingAddress);
    if (ak) {
      if (!byAddress.has(ak)) byAddress.set(ak, []);
      byAddress.get(ak)!.push(i);
    }
  });

  const out = new Map<string, string>();

  groups.forEach((g, i) => {
    const related = new Set<number>();
    for (const name of g.distinctOwnerNames) {
      for (const j of byName.get(normKey(name)) ?? []) if (j !== i) related.add(j);
    }
    for (const j of byAddress.get(mailingAddressKey(g.mailingAddress)) ?? []) {
      if (j !== i) related.add(j);
    }
    if (related.size === 0) {
      out.set(g.key, 'unique');
      return;
    }
    const parts = [...related]
      .sort((a, b) => a - b)
      .map((j) => {
        const other = groups[j];
        const sharedName = other.distinctOwnerNames.some((n) =>
          g.distinctOwnerNames.some((m) => normKey(n) === normKey(m)),
        );
        const sharedAddress =
          mailingAddressKey(other.mailingAddress) === mailingAddressKey(g.mailingAddress);
        const why = sharedName && sharedAddress ? 'name+address' : sharedName ? 'name' : 'address';
        return `${other.neighbourhood} — ${other.address} [${why}]`;
      });
    out.set(g.key, `${related.size + 1} entries: ${parts.join('; ')}`);
  });

  return out;
}

/**
 * Column B, "Owner No.".
 *
 * Reproduces the tracker's TEXTJOIN/COUNTIF formula: for the proprietor name and the
 * mailing address, report "<value> (n)" when the value also appears on another row of
 * the sheet (counting both the name and address columns), or "unique" when it does not.
 */
export function buildOwnerNoColumn(
  rows: { registeredProprietor: string; mailingAddress: string }[],
): string[] {
  const counts = new Map<string, number>();
  const bump = (value: string) => {
    const k = normKey(value);
    if (!k) return;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const r of rows) {
    bump(r.registeredProprietor);
    bump(r.mailingAddress);
  }

  return rows.map((r) => {
    const parts: string[] = [];
    for (const value of [r.registeredProprietor, r.mailingAddress]) {
      const text = squash(value);
      if (!text) continue;
      const k = normKey(text);
      const selfHits =
        (normKey(r.registeredProprietor) === k ? 1 : 0) +
        (normKey(r.mailingAddress) === k ? 1 : 0);
      const elsewhere = (counts.get(k) ?? 0) - selfHits;
      parts.push(elsewhere > 0 ? `${text} (${elsewhere + 1})` : 'unique');
    }
    return parts.join(', ');
  });
}
