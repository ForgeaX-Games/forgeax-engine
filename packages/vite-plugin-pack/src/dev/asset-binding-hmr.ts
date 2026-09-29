export interface AssetBindingRevision {
  readonly digest: string;
  readonly sourceKeys: readonly string[];
}

export function assetBindingHmrRevision(
  previous: AssetBindingRevision | undefined,
  next: AssetBindingRevision,
): AssetBindingRevision {
  return previous?.digest === next.digest ? previous : next;
}
