import type { EntityHandle } from './entity-handle';

export type WorldChangeKind =
  | 'component-added'
  | 'component-changed'
  | 'component-removed'
  | 'derived-component-changed'
  | 'entity-removed';

export interface WorldChangeRecord {
  readonly sequence: number;
  readonly kind: WorldChangeKind;
  readonly entity: EntityHandle;
  readonly componentId?: number;
}

export type WorldChange = Omit<WorldChangeRecord, 'sequence'>;

export type WorldChangeRead =
  | {
      readonly status: 'ok';
      readonly cursor: number;
      readonly records: readonly WorldChangeRecord[];
    }
  | {
      readonly status: 'overflow';
      readonly cursor: number;
      readonly oldestAvailable: number;
    };

const EMPTY_CHANGES: readonly WorldChangeRecord[] = Object.freeze([]);

/**
 * Bounded mutation evidence for engine-owned projections.
 *
 * Readers retain a cursor and rebuild their projection when the ring has
 * overwritten unread records. An overflow never returns a partial delta.
 */
export class WorldChangeJournal {
  private readonly records: Array<WorldChangeRecord | undefined>;
  private nextSequence = 1;

  constructor(readonly capacity = 65_536) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('WorldChangeJournal capacity must be a positive safe integer');
    }
    this.records = new Array<WorldChangeRecord | undefined>(capacity);
  }

  cursor(): number {
    return this.nextSequence - 1;
  }

  append(change: WorldChange): number {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.records[(sequence - 1) % this.capacity] = { ...change, sequence };
    return sequence;
  }

  readAfter(cursor: number): WorldChangeRead {
    const latest = this.cursor();
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > latest) {
      throw new RangeError(`WorldChangeJournal cursor ${cursor} is outside 0..${latest}`);
    }
    const oldestAvailable = Math.max(1, latest - this.capacity + 1);
    if (cursor < oldestAvailable - 1) {
      return { status: 'overflow', cursor: latest, oldestAvailable };
    }
    if (cursor === latest) {
      return { status: 'ok', cursor: latest, records: EMPTY_CHANGES };
    }

    const records: WorldChangeRecord[] = [];
    for (let sequence = cursor + 1; sequence <= latest; sequence += 1) {
      const record = this.records[(sequence - 1) % this.capacity];
      if (record === undefined || record.sequence !== sequence) {
        return { status: 'overflow', cursor: latest, oldestAvailable };
      }
      records.push(record);
    }
    return { status: 'ok', cursor: latest, records };
  }
}
