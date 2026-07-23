import type { CatalogDelta, PackIndexEntry } from '@forgeax/engine-types';

function rowsByGuid(rows: readonly PackIndexEntry[]): Map<string, PackIndexEntry> {
  return new Map(rows.map((row) => [row.guid.toLowerCase(), row]));
}

function sameRow(left: PackIndexEntry, right: PackIndexEntry): boolean {
  return (
    JSON.stringify({ ...left, guid: left.guid.toLowerCase() }) ===
    JSON.stringify({ ...right, guid: right.guid.toLowerCase() })
  );
}

/** Derives one neutral delta from consecutive complete catalog projections. */
export function calculateCatalogDelta(
  previous: readonly PackIndexEntry[],
  next: readonly PackIndexEntry[],
): CatalogDelta | undefined {
  const before = rowsByGuid(previous);
  const after = rowsByGuid(next);
  const added: PackIndexEntry[] = [];
  const changed: PackIndexEntry[] = [];
  const removed: string[] = [];

  for (const [guid, row] of after) {
    const prior = before.get(guid);
    if (prior === undefined) added.push(row);
    else if (!sameRow(prior, row)) changed.push(row);
  }
  for (const guid of before.keys()) {
    if (!after.has(guid)) removed.push(guid);
  }

  return added.length === 0 && changed.length === 0 && removed.length === 0
    ? undefined
    : { added, changed, removed };
}
