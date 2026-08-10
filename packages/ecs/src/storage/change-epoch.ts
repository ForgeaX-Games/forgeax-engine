export interface ComponentEpochColumns {
  added: Float64Array;
  changed: Float64Array;
}

export function createComponentEpochColumns(capacity: number): ComponentEpochColumns {
  return {
    added: new Float64Array(capacity),
    changed: new Float64Array(capacity),
  };
}

export function growComponentEpochColumns(
  columns: ComponentEpochColumns,
  capacity: number,
): ComponentEpochColumns {
  const added = new Float64Array(capacity);
  const changed = new Float64Array(capacity);
  added.set(columns.added);
  changed.set(columns.changed);
  return { added, changed };
}

export function copyComponentEpoch(
  source: ComponentEpochColumns,
  sourceRow: number,
  target: ComponentEpochColumns,
  targetRow: number,
): void {
  target.added[targetRow] = source.added[sourceRow] ?? 0;
  target.changed[targetRow] = source.changed[sourceRow] ?? 0;
}
