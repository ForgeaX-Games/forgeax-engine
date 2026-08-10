import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeaturePreparationFailedError } from '../errors/render';
import type {
  PreparedKind,
  RenderFeatureBindingsDescriptor,
  RenderFeatureIndexDataDescriptor,
  RenderFeaturePipelineDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
  RenderFeatureVertexDataDescriptor,
} from './prepared-graphics';
import type { RenderFeatureTargetHandle } from './targets';

export type PreparedGraphicsKind = Exclude<PreparedKind, 'attachment'>;

export type PreparedGraphicsRequestByKind = {
  pipeline: RenderFeaturePipelineDescriptor;
  bindings: RenderFeatureBindingsDescriptor;
  'vertex-data': RenderFeatureVertexDataDescriptor;
  'index-data': RenderFeatureIndexDataDescriptor;
};

type PreparedGraphicsSignature = { readonly signature: string };

export type PreparedGraphicsNormalizedDescriptor =
  | (RenderFeaturePipelineDescriptor & { readonly kind: 'pipeline' })
  | (RenderFeatureBindingsDescriptor & { readonly kind: 'bindings' })
  | {
      readonly kind: 'vertex-data';
      readonly layout: string;
      readonly data?: readonly number[];
      readonly buffer?: import('./prepared-gpu-work').RenderFeatureGpuBufferRef;
    }
  | {
      readonly kind: 'index-data';
      readonly format: 'uint16' | 'uint32';
      readonly data?: readonly number[];
      readonly buffer?: import('./prepared-gpu-work').RenderFeatureGpuBufferRef;
    };

export interface PreparedGraphicsItem<Kind extends PreparedGraphicsKind = PreparedGraphicsKind> {
  readonly featureIdentity: string;
  readonly generation: number;
  readonly kind: Kind;
  readonly name: string;
  readonly signature: string;
  readonly reference: RenderFeaturePreparedRef<Kind>;
  readonly descriptor?: PreparedGraphicsNormalizedDescriptor;
  readonly uploadBytes?: readonly number[];
}

export interface PreparedGraphicsStoreSnapshot {
  readonly generation: number;
  readonly items: readonly PreparedGraphicsItem[];
}

export interface PreparedGraphicsTransaction {
  readonly featureIdentity: string;
  readonly generation: number;
  prepare<Kind extends PreparedGraphicsKind>(
    kind: Kind,
    name: string,
    descriptor: PreparedGraphicsRequestByKind[Kind] | PreparedGraphicsSignature,
  ): Result<RenderFeaturePreparedRef<Kind>, RenderError>;
  committedItems(): readonly PreparedGraphicsItem[];
  overlayItems(): readonly PreparedGraphicsItem[];
  owns(reference: RenderFeaturePreparedRef): boolean;
  graphicsState(
    capabilityAvailable: boolean,
    attachments: readonly {
      readonly resource: string | RenderFeatureTargetHandle;
      readonly format: string;
    }[],
  ): RenderFeaturePreparedGraphicsState;
  commit(): Result<PreparedGraphicsStoreSnapshot, RenderError>;
  abort(): void;
}

export interface PreparedGraphicsStore {
  beginFrame(featureIdentity: string, generation: number): PreparedGraphicsTransaction;
  snapshot(featureIdentity: string): PreparedGraphicsStoreSnapshot;
  invalidate(featureIdentity: string, generation: number): void;
}

interface Slot {
  readonly generation: number;
  readonly items: Map<string, PreparedGraphicsItem>;
}

function itemKey(kind: PreparedGraphicsKind, name: string): string {
  return `${kind}:${name}`;
}

function preparationFailure(
  featureIdentity: string,
  generation: number,
  kind: PreparedGraphicsKind,
  name: string,
  reason: string,
): RenderFeaturePreparationFailedError {
  return new RenderFeaturePreparationFailedError(
    featureIdentity,
    generation,
    'prepare-graphics-resource',
    kind,
    name,
    reason,
    'next-frame',
  );
}

function immutableValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableValue));
  if (ArrayBuffer.isView(value)) {
    return Object.freeze(Array.from(value as unknown as ArrayLike<number>));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.freeze(
      Object.fromEntries(
        Object.entries(source).map(([key, entry]) => [key, immutableValue(entry)]),
      ),
    );
  }
  return value;
}

function valuesOf(data: ArrayBufferView | readonly number[]): readonly number[] {
  return Object.freeze(
    ArrayBuffer.isView(data) ? Array.from(data as unknown as ArrayLike<number>) : [...data],
  );
}

function uploadBytes(
  data: ArrayBufferView | readonly number[],
  kind: PreparedGraphicsKind,
): readonly number[] {
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
    return Object.freeze(Array.from(bytes));
  }
  const view = kind === 'index-data' ? new Uint16Array(data) : new Float32Array(data);
  return Object.freeze(Array.from(new Uint8Array(view.buffer)));
}

function normalizeDescriptor(
  kind: PreparedGraphicsKind,
  request: PreparedGraphicsRequestByKind[PreparedGraphicsKind] | PreparedGraphicsSignature,
): {
  descriptor: PreparedGraphicsNormalizedDescriptor | undefined;
  signature: string;
  uploadBytes: readonly number[] | undefined;
} {
  if ('signature' in request) {
    return {
      descriptor: undefined,
      signature: request.signature,
      uploadBytes: undefined,
    };
  }
  let descriptor: PreparedGraphicsNormalizedDescriptor;
  let bytes: readonly number[] | undefined;
  switch (kind) {
    case 'pipeline': {
      const pipeline = request as RenderFeaturePipelineDescriptor;
      descriptor = Object.freeze({
        kind,
        shader: pipeline.shader,
        vertexLayout: pipeline.vertexLayout,
        colorFormats: Object.freeze([...pipeline.colorFormats]),
        ...(pipeline.depthFormat === undefined ? {} : { depthFormat: pipeline.depthFormat }),
        ...(pipeline.sampleCount === undefined ? {} : { sampleCount: pipeline.sampleCount }),
        ...(pipeline.topology === undefined ? {} : { topology: pipeline.topology }),
        ...(pipeline.indexFormat === undefined ? {} : { indexFormat: pipeline.indexFormat }),
        ...(pipeline.renderState === undefined
          ? {}
          : {
              renderState: immutableValue(pipeline.renderState) as NonNullable<
                RenderFeaturePipelineDescriptor['renderState']
              >,
            }),
      });
      break;
    }
    case 'bindings': {
      const bindings = request as RenderFeatureBindingsDescriptor;
      descriptor = Object.freeze({
        kind,
        pipeline: bindings.pipeline,
        values: immutableValue(bindings.values) as Readonly<Record<string, unknown>>,
      });
      break;
    }
    case 'vertex-data': {
      const vertexData = request as RenderFeatureVertexDataDescriptor;
      descriptor = Object.freeze({
        kind,
        layout: vertexData.layout,
        ...('buffer' in vertexData && vertexData.buffer !== undefined
          ? { buffer: vertexData.buffer }
          : { data: valuesOf(vertexData.data) }),
      });
      if ('data' in vertexData && vertexData.data !== undefined) {
        bytes = uploadBytes(vertexData.data, kind);
      }
      break;
    }
    case 'index-data': {
      const indexData = request as RenderFeatureIndexDataDescriptor;
      descriptor = Object.freeze({
        kind,
        format: indexData.format,
        ...('buffer' in indexData && indexData.buffer !== undefined
          ? { buffer: indexData.buffer }
          : { data: valuesOf(indexData.data) }),
      });
      if ('data' in indexData && indexData.data !== undefined) {
        bytes = uploadBytes(indexData.data, kind);
      }
      break;
    }
  }
  return {
    descriptor,
    signature: JSON.stringify(descriptor),
    uploadBytes: bytes,
  };
}

class PreparedGraphicsTransactionImpl implements PreparedGraphicsTransaction {
  private aborted = false;
  private committed = false;
  private readonly overlay = new Map<string, PreparedGraphicsItem>();
  private readonly touchedCommitted = new Set<string>();

  constructor(
    private readonly store: PreparedGraphicsStoreImpl,
    readonly featureIdentity: string,
    readonly generation: number,
    private readonly committedSlot: Slot | undefined,
  ) {}

  prepare<Kind extends PreparedGraphicsKind>(
    kind: Kind,
    name: string,
    request: PreparedGraphicsRequestByKind[Kind] | PreparedGraphicsSignature,
  ): Result<RenderFeaturePreparedRef<Kind>, RenderError> {
    const normalized = normalizeDescriptor(kind, request);
    if (this.aborted || this.committed || name.length === 0 || normalized.signature.length === 0) {
      return err(
        preparationFailure(
          this.featureIdentity,
          this.generation,
          kind,
          name,
          'transaction-is-not-preparable',
        ),
      );
    }
    const key = itemKey(kind, name);
    const committed = this.committedSlot?.items.get(key);
    if (committed !== undefined) {
      if (committed.signature !== normalized.signature) {
        return err(
          preparationFailure(
            this.featureIdentity,
            this.generation,
            kind,
            name,
            'prepared-signature-mismatch',
          ),
        );
      }
      this.touchedCommitted.add(key);
      return ok(committed.reference as RenderFeaturePreparedRef<Kind>);
    }
    const existing = this.overlay.get(key);
    if (existing !== undefined) {
      if (existing.signature !== normalized.signature) {
        return err(
          preparationFailure(
            this.featureIdentity,
            this.generation,
            kind,
            name,
            'duplicate-prepared-signature',
          ),
        );
      }
      return ok(existing.reference as RenderFeaturePreparedRef<Kind>);
    }
    const reference = Object.freeze({
      kind,
      generation: this.generation,
    }) as RenderFeaturePreparedRef<Kind>;
    const item: PreparedGraphicsItem<Kind> = {
      featureIdentity: this.featureIdentity,
      generation: this.generation,
      kind,
      name,
      signature: normalized.signature,
      reference,
      ...(normalized.descriptor === undefined ? {} : { descriptor: normalized.descriptor }),
      ...(normalized.uploadBytes === undefined ? {} : { uploadBytes: normalized.uploadBytes }),
    };
    this.store.registerReference(reference, item);
    this.overlay.set(key, item);
    return ok(reference);
  }

  committedItems(): readonly PreparedGraphicsItem[] {
    return Object.freeze(
      [...this.touchedCommitted].flatMap((key) => {
        const item = this.committedSlot?.items.get(key);
        return item === undefined ? [] : [item];
      }),
    );
  }

  overlayItems(): readonly PreparedGraphicsItem[] {
    return Object.freeze([...this.overlay.values()]);
  }

  owns(reference: RenderFeaturePreparedRef): boolean {
    const item = this.store.itemFor(reference);
    return (
      item?.featureIdentity === this.featureIdentity &&
      item.generation === this.generation &&
      ((this.touchedCommitted.has(itemKey(item.kind, item.name)) &&
        this.committedSlot?.items.get(itemKey(item.kind, item.name)) === item) ||
        this.overlay.get(itemKey(item.kind, item.name)) === item)
    );
  }

  graphicsState(
    capabilityAvailable: boolean,
    attachments: readonly {
      readonly resource: string | RenderFeatureTargetHandle;
      readonly format: string;
    }[],
  ): RenderFeaturePreparedGraphicsState {
    const items = [...this.committedItems(), ...this.overlay.values()];
    return {
      capabilityAvailable,
      generation: this.generation,
      attachments,
      pipeline: items.find((item) => item.kind === 'pipeline')?.reference,
      pipelines: items.filter((item) => item.kind === 'pipeline').map((item) => item.reference),
      bindings: items.filter((item) => item.kind === 'bindings').map((item) => item.reference),
      vertexData: items.filter((item) => item.kind === 'vertex-data').map((item) => item.reference),
      indexData: items.filter((item) => item.kind === 'index-data').map((item) => item.reference),
    };
  }

  commit(): Result<PreparedGraphicsStoreSnapshot, RenderError> {
    if (this.aborted || this.committed) {
      return err(
        preparationFailure(
          this.featureIdentity,
          this.generation,
          'pipeline',
          'transaction',
          'transaction-already-closed',
        ),
      );
    }
    this.committed = true;
    return ok(
      this.store.commit(this.featureIdentity, this.generation, this.committedItems(), this.overlay),
    );
  }

  abort(): void {
    if (this.committed) return;
    this.aborted = true;
    this.overlay.clear();
  }
}

class PreparedGraphicsStoreImpl implements PreparedGraphicsStore {
  private readonly slots = new Map<string, Slot>();
  private readonly references = new WeakMap<object, PreparedGraphicsItem>();

  beginFrame(featureIdentity: string, generation: number): PreparedGraphicsTransaction {
    const slot = this.slots.get(featureIdentity);
    const committedSlot = slot?.generation === generation ? slot : undefined;
    return new PreparedGraphicsTransactionImpl(this, featureIdentity, generation, committedSlot);
  }

  snapshot(featureIdentity: string): PreparedGraphicsStoreSnapshot {
    const slot = this.slots.get(featureIdentity);
    return {
      generation: slot?.generation ?? -1,
      items: Object.freeze([...(slot?.items.values() ?? [])]),
    };
  }

  invalidate(featureIdentity: string, generation: number): void {
    const slot = this.slots.get(featureIdentity);
    if (slot !== undefined && slot.generation < generation) {
      this.slots.delete(featureIdentity);
    }
  }

  registerReference(reference: object, item: PreparedGraphicsItem): void {
    this.references.set(reference, item);
  }

  itemFor(reference: object): PreparedGraphicsItem | undefined {
    return this.references.get(reference);
  }

  commit(
    featureIdentity: string,
    generation: number,
    activeCommitted: readonly PreparedGraphicsItem[],
    overlay: ReadonlyMap<string, PreparedGraphicsItem>,
  ): PreparedGraphicsStoreSnapshot {
    const items = new Map<string, PreparedGraphicsItem>();
    for (const item of activeCommitted) items.set(itemKey(item.kind, item.name), item);
    for (const [key, item] of overlay) items.set(key, item);
    const slot: Slot = { generation, items };
    this.slots.set(featureIdentity, slot);
    return {
      generation,
      items: Object.freeze([...items.values()]),
    };
  }
}

export function createPreparedGraphicsStore(): PreparedGraphicsStore {
  return new PreparedGraphicsStoreImpl();
}
