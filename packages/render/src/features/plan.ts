import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { GraphBufferAccess, GraphTextureAccess } from '@forgeax/engine-render-graph';
import type { RhiCaps, TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import { isSceneDataTarget, type SceneDataTarget } from '../temporal/scene-data';
import type {
  RenderFeatureGpuBufferUsage,
  RenderFeatureGpuProgramDescriptor,
} from './prepared-gpu-work';
import type { RenderFeaturePipelineDescriptor } from './prepared-graphics';

export type RenderFeatureResourceUsage = GraphBufferAccess | GraphTextureAccess;

/**
 * Renderer-owned binding layout contract for a material shader.
 *
 * Producer features use this read-only projection to describe which logical
 * scene resources a custom material consumes. The render owner remains the
 * source of truth for the shader source and its pipeline layout.
 */
export type RenderFeatureMaterialShaderBindingContract =
  | 'group-0'
  | 'group-0-resource'
  | 'view-only'
  | 'view-and-scene-depth'
  | 'render-material-with-scene-depth'
  | 'render-material-and-scene-depth'
  | 'render-material';

export type RenderFeatureFullscreenRead =
  | string
  | { readonly key: string; readonly sampleType?: 'depth' };

/** A named graph target or an authorized semantic sampled-read target. */
export type RenderFeatureSampledTarget = string | SceneDataTarget;

/** A cooked fullscreen shader declaration owned by a RenderFeature plan. */
export interface RenderFeatureFullscreenProgramDeclaration {
  readonly kind: 'fullscreen-program';
  readonly name: string;
  readonly source: string;
  /** Optional fragment entry point when one WGSL module owns multiple passes. */
  readonly fragmentEntryPoint?: string;
  readonly reads?: readonly RenderFeatureFullscreenRead[];
  /** Bind the renderer-owned View group at group(0) for camera reconstruction. */
  readonly usesView?: boolean;
  /** Read-only storage buffers appended after the regular color/depth reads. */
  readonly storageBindings?: readonly number[];
  readonly params?: {
    readonly byteSize: number;
    readonly defaultValue: Uint8Array;
  };
}

export type RenderFeatureBindingValue =
  | null
  | boolean
  | number
  | string
  | ArrayBufferView
  | SceneDataTarget
  | readonly RenderFeatureBindingValue[]
  | { readonly [name: string]: RenderFeatureBindingValue };

export type RenderFeatureResourceDeclaration =
  | RenderFeatureFullscreenProgramDeclaration
  | {
      /** Once-per-frame scene capture from an explicit simulation camera. */
      readonly kind: 'scene-depth';
      readonly name: string;
      readonly camera: NonNullable<import('./types').RenderFeatureExtractView['selectedView']>;
    }
  | { readonly kind: 'scene-noise'; readonly name: string }
  | {
      readonly kind: 'compute-program';
      readonly name: string;
      readonly program: RenderFeatureGpuProgramDescriptor;
    }
  | {
      readonly kind: 'graphics-program';
      readonly name: string;
      readonly program: RenderFeaturePipelineDescriptor;
    }
  | {
      readonly kind: 'buffer';
      readonly name: string;
      readonly size: number;
      readonly usage: readonly RenderFeatureGpuBufferUsage[];
      readonly data?: ArrayBufferView;
    }
  | {
      /** A resident generation-owned resource supplied by a render-owned provider. */
      readonly kind: 'prepared-gpu-resource';
      readonly name: string;
      readonly resource:
        | {
            readonly kind: 'buffer';
            readonly value: unknown;
            readonly size: number;
            readonly usage?: readonly RenderFeatureGpuBufferUsage[];
          }
        | { readonly kind: 'texture-view'; readonly value: unknown }
        | { readonly kind: 'sampler'; readonly value: unknown };
      /** Optional graph target or semantic scene-data target backing the resource. */
      readonly logicalTarget?: RenderFeatureSampledTarget;
    }
  | {
      readonly kind: 'compute-bindings';
      readonly name: string;
      readonly program: string;
      readonly entries: readonly {
        readonly binding: number;
        readonly resource: string;
      }[];
    }
  | {
      readonly kind: 'graphics-bindings';
      readonly name: string;
      readonly program: string;
      readonly values: Readonly<Record<string, RenderFeatureBindingValue>>;
      readonly logicalTargets?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'vertex-data';
      readonly name: string;
      readonly layout: string;
      readonly data: ArrayBufferView | readonly number[];
      readonly buffer?: never;
    }
  | {
      readonly kind: 'vertex-data';
      readonly name: string;
      readonly layout: string;
      readonly buffer: string;
      readonly data?: never;
    }
  | {
      readonly kind: 'index-data';
      readonly name: string;
      readonly format: 'uint16' | 'uint32';
      readonly data: Uint16Array | Uint32Array;
      readonly buffer?: never;
    }
  | {
      readonly kind: 'index-data';
      readonly name: string;
      readonly format: 'uint16' | 'uint32';
      readonly buffer: string;
      readonly data?: never;
    };

export type RenderFeatureDispatch =
  | {
      readonly kind: 'direct';
      readonly entryPoint: string;
      readonly workgroups: readonly [number, number?, number?];
    }
  | {
      readonly kind: 'indirect';
      readonly entryPoint: string;
      readonly resource: string;
      readonly offset: number;
    };

export type RenderFeatureDraw =
  | {
      readonly kind: 'draw';
      readonly vertexCount: number;
      readonly instanceCount: number;
      readonly firstVertex?: number;
      readonly firstInstance?: number;
    }
  | {
      readonly kind: 'draw-indexed';
      readonly indexCount: number;
      readonly instanceCount: number;
      readonly firstIndex?: number;
      readonly baseVertex?: number;
      readonly firstInstance?: number;
    }
  | {
      readonly kind: 'draw-indirect' | 'draw-indexed-indirect';
      readonly resource: string;
      readonly offset?: number;
    };

export interface RenderFeatureDrawDeclaration {
  readonly program: string;
  readonly bindings: readonly string[];
  readonly vertexData: readonly { readonly slot: number; readonly resource: string }[];
  readonly vertexLayout?: 'none';
  readonly indexData?: {
    readonly resource: string;
    readonly format: 'uint16' | 'uint32';
  };
  readonly draw: RenderFeatureDraw;
}

export type RenderFeaturePassDeclaration =
  | {
      readonly kind: 'shadow-caster';
      readonly name: string;
      readonly draws: readonly RenderFeatureDrawDeclaration[];
    }
  | {
      readonly kind: 'compute';
      readonly name: string;
      readonly program: string;
      readonly bindings: string;
      readonly dispatches: readonly RenderFeatureDispatch[];
    }
  | {
      readonly kind: 'raster';
      readonly name: string;
      readonly colorAttachments: readonly {
        readonly target: string;
        readonly loadOp: 'load' | 'clear';
        readonly storeOp: 'store' | 'discard';
      }[];
      readonly depthStencilAttachment?: {
        readonly target: string;
        readonly depthLoadOp: 'load' | 'clear';
        readonly depthStoreOp: 'store' | 'discard';
      };
      readonly sampledTargets?: readonly RenderFeatureSampledTarget[];
      readonly draws: readonly RenderFeatureDrawDeclaration[];
    };

/**
 * The sole executable feature declaration for one frame. Programs, bindings,
 * resources, dispatches, draws, and logical targets are all named here; graph
 * access is derived from these roles rather than duplicated as reads/writes.
 */
export interface RenderFeatureWorkPlan {
  readonly resources: readonly RenderFeatureResourceDeclaration[];
  readonly passes: readonly RenderFeaturePassDeclaration[];
}

export interface RenderFeatureLogicalTarget {
  readonly name: string;
  readonly kind: 'color' | 'depth' | 'swapchain';
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderFeaturePlanView {
  readonly identity: string;
  readonly render: boolean;
  readonly frame: {
    readonly frameNumber: number;
    readonly width?: number;
    readonly height?: number;
  };
  readonly selectedView?: import('./types').RenderFeatureExtractView['selectedView'];
  readonly targets: readonly RenderFeatureLogicalTarget[];
  readonly sceneData: import('../temporal/scene-data-catalog').SceneDataCatalog;
}

export interface RenderFeaturePlanContext {
  readonly materialContext?: MaterialCookRasterContext;
  readonly caps: Readonly<RhiCaps>;
  readonly frame: { readonly frameNumber: number };
  readonly generation: number;
  readonly views: readonly RenderFeaturePlanView[];
  readonly materialShaderBindingContract?: (
    materialShaderId: string,
  ) => RenderFeatureMaterialShaderBindingContract;
}

export type RenderFeatureWorkScope = 'frame' | { readonly view: string };

/** Each scope owns its resource namespace; view work may read shared frame resources. */
export interface RenderFeatureWork extends RenderFeatureWorkPlan {
  readonly scope: RenderFeatureWorkScope;
}

/** The producer declares one frame containing shared simulation and view projections. */
export interface RenderFeaturePlan {
  readonly work: readonly RenderFeatureWork[];
  readonly sourceFeedback?: unknown;
}

/** Frozen declaration produced for one feature in one frame. */
export interface RenderFeaturePlannedFrame {
  readonly scope: RenderFeatureWorkScope;
  readonly featureIdentity: string;
  readonly generation: number;
  readonly signature: string;
  readonly plan: RenderFeatureWorkPlan;
  /** Placement selected by the installed feature; omitted means the legacy post stage. */
  readonly placement?: import('./types').RenderFeaturePlacement;
}

export interface RenderFeatureDerivedAccess {
  readonly resource: string | SceneDataTarget;
  readonly usage: RenderFeatureResourceUsage;
}

function stageFailure(identity: string): RenderError {
  return {
    code: 'render-feature-stage-failed',
    expected: 'a closed RenderFeatureWorkPlan with valid named descriptor references',
    hint: 'declare each program, binding, buffer, draw, dispatch, and logical target exactly once',
    detail: {
      featureIdentity: identity,
      order: -1,
      stage: 'plan',
      recovery: 'next-frame',
    },
  } as RenderError;
}

function validName(name: string): boolean {
  return /^[a-z][a-z0-9.-]{0,127}$/.test(name);
}

/** Detached accounting for the canonical plan signature path. */
export interface RenderFeaturePlanSignatureMetrics {
  calls: number;
  typedArrayBytes: number;
  outputChars: number;
}

const BYTE_HEX = '0123456789abcdef';
const BYTE_HEX_CHUNK_SIZE = 2048;

/**
 * Append an exact byte spelling without Array#join's per-byte number/string
 * conversion. Inline vertex/index payloads remain part of the canonical
 * signature; this only changes their private textual representation from a
 * comma-separated decimal list to bounded hex chunks.
 */
function appendByteHex(value: ArrayBufferView, parts: string[]): void {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  parts.push('[bytes-hex:');
  for (let start = 0; start < bytes.length; start += BYTE_HEX_CHUNK_SIZE) {
    const end = Math.min(bytes.length, start + BYTE_HEX_CHUNK_SIZE);
    let encoded = '';
    for (let index = start; index < end; index += 1) {
      const byte = bytes[index] as number;
      encoded += BYTE_HEX[byte >>> 4] as string;
      encoded += BYTE_HEX[byte & 0x0f] as string;
    }
    parts.push(encoded);
  }
  parts.push(']');
}

/**
 * Detached structural evidence for one plan signature.
 *
 * The renderer validates a plan twice: once while the feature host records
 * the candidate signature and again while the typed graph admits that
 * candidate. Keeping a detached structural snapshot lets the second check
 * avoid rebuilding a large string while still detecting mutations to the
 * shallow-frozen plan. This is intentionally a structural cache, not an
 * object-identity shortcut.
 */
export type RenderFeaturePlanSignatureNode =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'array';
      readonly values: readonly (RenderFeaturePlanSignatureNode | undefined)[];
    }
  | {
      readonly kind: 'object';
      readonly keys: readonly string[];
      readonly values: readonly RenderFeaturePlanSignatureNode[];
    }
  | { readonly kind: 'primitive'; readonly token: string };

export interface RenderFeaturePlanSignatureSnapshot {
  readonly resources: readonly RenderFeaturePlanSignatureNode[];
  readonly passes: RenderFeaturePlanSignatureNode;
}

const signatureEvidenceByPlan = new WeakMap<
  object,
  {
    readonly signature: string;
    readonly snapshot: RenderFeaturePlanSignatureSnapshot;
  }
>();

// The detached evidence is deliberately checked again by graph admission.
// Host and graph therefore share one exact structural proof without trusting
// a producer-owned boolean or object identity if a plan is mutated between
// the two stages.
function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stablePrimitiveToken(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Clone a signature node while reusing an unchanged subtree from the prior
 * detached snapshot.  The prior node is never mutated: a changed parent gets
 * a new frozen container and only equal children are shared.  This keeps the
 * graph-admission evidence immutable while avoiding a full tree allocation
 * when one VFX resource/pass changes.
 */
function cloneSignatureNode(
  value: unknown,
  previous?: RenderFeaturePlanSignatureNode,
): RenderFeaturePlanSignatureNode {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (previous?.kind === 'bytes' && previous.bytes.byteLength === bytes.byteLength) {
      let equal = true;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== previous.bytes[index]) {
          equal = false;
          break;
        }
      }
      if (equal) return previous;
    }
    return { kind: 'bytes', bytes: new Uint8Array(bytes) };
  }
  if (Array.isArray(value)) {
    const values: (RenderFeaturePlanSignatureNode | undefined)[] = new Array(value.length);
    const previousValues = previous?.kind === 'array' ? previous.values : undefined;
    let changed = previousValues === undefined || previousValues.length !== value.length;
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      const prior = previousValues?.[index];
      const next = child === undefined ? undefined : cloneSignatureNode(child, prior);
      values[index] = next;
      if (next !== prior) changed = true;
    }
    if (!changed && previous?.kind === 'array') return previous;
    return Object.freeze({ kind: 'array', values: Object.freeze(values) });
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Readonly<Record<string, unknown>>;
    const previousObject = previous?.kind === 'object' ? previous : undefined;
    let keys: readonly string[] | undefined;
    let changed = previousObject === undefined;
    if (previousObject !== undefined) {
      // Descriptor object shapes are stable across VFX revisions.  Reuse the
      // detached canonical key order after an allocation-free own-key check;
      // only an actual add/remove falls back to Object.keys().sort().
      let ownKeyCount = 0;
      for (const key in source) {
        if (Object.hasOwn(source, key)) ownKeyCount += 1;
      }
      if (ownKeyCount === previousObject.keys.length) {
        let sameKeySet = true;
        for (const key of previousObject.keys) {
          if (!Object.hasOwn(source, key)) {
            sameKeySet = false;
            break;
          }
        }
        if (sameKeySet) {
          keys = previousObject.keys;
        } else {
          changed = true;
        }
      } else {
        changed = true;
      }
    }
    if (keys === undefined) {
      keys = Object.freeze(Object.keys(source).sort(compareStableKeys));
    }
    const values = Object.freeze(
      keys.map((key) => {
        const previousIndex = previousObject?.keys.indexOf(key) ?? -1;
        const prior = previousIndex < 0 ? undefined : previousObject?.values[previousIndex];
        const next = cloneSignatureNode(source[key], prior);
        if (next !== prior) changed = true;
        return next;
      }),
    );
    if (!changed && previousObject !== undefined) return previousObject;
    return Object.freeze({
      kind: 'object',
      keys,
      values,
    });
  }
  const token = stablePrimitiveToken(value);
  return previous?.kind === 'primitive' && previous.token === token
    ? previous
    : { kind: 'primitive', token };
}

function signatureResourceValue(resource: RenderFeatureResourceDeclaration): unknown {
  if (resource.kind === 'scene-depth') return { ...resource, camera: undefined };
  if (resource.kind !== 'buffer') return resource;
  // Match resourceTopology exactly: buffer payloads are upload evidence, not
  // topology identity, while usage order is canonicalized before comparison.
  return { ...resource, usage: [...resource.usage].sort(compareStableKeys), data: undefined };
}

/** Build a detached, mutation-resistant topology snapshot for one plan. */
export function cloneRenderFeaturePlanSignatureSnapshot(
  plan: RenderFeatureWorkPlan,
  previous?: RenderFeaturePlanSignatureSnapshot,
): RenderFeaturePlanSignatureSnapshot {
  const resources: RenderFeaturePlanSignatureNode[] = new Array(plan.resources.length);
  let resourcesChanged = previous === undefined || previous.resources.length !== resources.length;
  for (let index = 0; index < plan.resources.length; index += 1) {
    const resource = plan.resources[index] as RenderFeatureResourceDeclaration;
    const prior = previous?.resources[index];
    let next: RenderFeaturePlanSignatureNode;
    if (prior !== undefined && equalResourceNode(resource, prior)) {
      next = prior;
    } else {
      // Buffer `data` is deliberately outside topology identity, so avoid
      // materialising its normalized spread object on the common upload-only
      // update path.  Changed declarations still share equal descendants.
      next = cloneSignatureNode(signatureResourceValue(resource), prior);
    }
    resources[index] = next;
    if (next !== prior) resourcesChanged = true;
  }
  const nextResources =
    previous !== undefined && !resourcesChanged ? previous.resources : Object.freeze(resources);
  const nextPasses = cloneSignatureNode(plan.passes, previous?.passes);
  if (previous !== undefined && !resourcesChanged && nextPasses === previous.passes) {
    return previous;
  }
  return Object.freeze({ resources: nextResources, passes: nextPasses });
}

function equalSignatureNode(value: unknown, snapshot: RenderFeaturePlanSignatureNode): boolean {
  if (snapshot.kind === 'bytes') {
    if (!ArrayBuffer.isView(value) || value.byteLength !== snapshot.bytes.byteLength) return false;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== snapshot.bytes[index]) return false;
    }
    return true;
  }
  if (snapshot.kind === 'primitive') return stablePrimitiveToken(value) === snapshot.token;
  if (snapshot.kind === 'array') {
    if (!Array.isArray(value) || value.length !== snapshot.values.length) return false;
    for (let index = 0; index < snapshot.values.length; index += 1) {
      const expected = snapshot.values[index];
      const current = value[index];
      if (expected === undefined) {
        // stable() intentionally spells holes and explicit undefined alike.
        if (current !== undefined) return false;
      } else if (!equalSignatureNode(current, expected)) {
        return false;
      }
    }
    return true;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ArrayBuffer.isView(value)
  ) {
    return false;
  }
  const source = value as Readonly<Record<string, unknown>>;
  // Avoid allocating Object.keys(source) on every frame. The snapshot keeps
  // the canonical key order, so an own-property count plus direct lookups is
  // equivalent while leaving the hot validation path allocation-free.
  let ownKeyCount = 0;
  for (const key in source) {
    if (Object.hasOwn(source, key)) ownKeyCount += 1;
  }
  if (ownKeyCount !== snapshot.keys.length) return false;
  for (let index = 0; index < snapshot.keys.length; index += 1) {
    const key = snapshot.keys[index] as string;
    if (!Object.hasOwn(source, key)) return false;
    if (
      !equalSignatureNode(source[key], snapshot.values[index] as RenderFeaturePlanSignatureNode)
    ) {
      return false;
    }
  }
  return true;
}

function equalSortedUsage(usage: unknown, snapshot: RenderFeaturePlanSignatureNode): boolean {
  if (
    !Array.isArray(usage) ||
    snapshot.kind !== 'array' ||
    usage.length !== snapshot.values.length
  ) {
    return false;
  }
  // Usage is a short string union. Compare it as a multiset so the check
  // mirrors [...usage].sort() without allocating a sorted copy per frame.
  for (let index = 0; index < snapshot.values.length; index += 1) {
    const expected = snapshot.values[index];
    if (expected === undefined || expected.kind !== 'primitive') return false;
    let expectedCount = 0;
    let currentCount = 0;
    for (let candidate = 0; candidate < snapshot.values.length; candidate += 1) {
      const sibling = snapshot.values[candidate];
      if (
        sibling !== undefined &&
        sibling.kind === 'primitive' &&
        sibling.token === expected.token
      ) {
        expectedCount += 1;
      }
      if (stablePrimitiveToken(usage[candidate]) === expected.token) currentCount += 1;
    }
    if (expectedCount !== currentCount) return false;
  }
  return true;
}

function equalResourceNode(resource: unknown, snapshot: RenderFeaturePlanSignatureNode): boolean {
  if (
    resource === null ||
    typeof resource !== 'object' ||
    Array.isArray(resource) ||
    ArrayBuffer.isView(resource) ||
    snapshot.kind !== 'object'
  ) {
    return false;
  }
  const source = resource as Readonly<Record<string, unknown>>;
  const payloadKey =
    source.kind === 'buffer' ? 'data' : source.kind === 'scene-depth' ? 'camera' : undefined;
  if (payloadKey === undefined) return equalSignatureNode(source, snapshot);

  // Camera motion and buffer uploads change frame data, not graph topology.
  // Compare the same normalized structure used by resourceTopology without
  // allocating a spread object on every signature admission.
  let comparableKeys = 0;
  // Keep this branch allocation-free as well. Buffer declarations are among
  // the most frequently validated resources in a frame.
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (key === payloadKey) continue;
    const snapshotIndex = snapshot.keys.indexOf(key);
    if (snapshotIndex < 0) return false;
    comparableKeys += 1;
    if (source.kind === 'buffer' && key === 'usage') {
      if (
        !equalSortedUsage(
          source[key],
          snapshot.values[snapshotIndex] as RenderFeaturePlanSignatureNode,
        )
      ) {
        return false;
      }
    } else if (
      !equalSignatureNode(
        source[key],
        snapshot.values[snapshotIndex] as RenderFeaturePlanSignatureNode,
      )
    ) {
      return false;
    }
  }
  let expectedComparableKeys = 0;
  for (const key of snapshot.keys) {
    if (key === payloadKey) continue;
    expectedComparableKeys += 1;
    if (!Object.hasOwn(source, key)) return false;
  }
  if (comparableKeys !== expectedComparableKeys) return false;
  return true;
}

/** Exact structural equality against a detached signature snapshot. */
export function renderFeaturePlanSignatureSnapshotEquals(
  plan: RenderFeatureWorkPlan,
  snapshot: RenderFeaturePlanSignatureSnapshot,
): boolean {
  if (plan.resources.length !== snapshot.resources.length) return false;
  for (let index = 0; index < plan.resources.length; index += 1) {
    if (
      !equalResourceNode(
        plan.resources[index],
        snapshot.resources[index] as RenderFeaturePlanSignatureNode,
      )
    ) {
      return false;
    }
  }
  return equalSignatureNode(plan.passes, snapshot.passes);
}

/** Associate a freshly produced plan with detached evidence for later validation. */
export function rememberRenderFeaturePlanSignature(
  plan: RenderFeatureWorkPlan,
  signature: string,
  snapshot: RenderFeaturePlanSignatureSnapshot,
): void {
  signatureEvidenceByPlan.set(plan as object, { signature, snapshot });
}

/**
 * Validate an existing signature without serializing the plan again. A false
 * result means the plan has no evidence or its nested data no longer matches;
 * callers must then run the canonical serializer as the recovery path.
 */
export function renderFeaturePlanSignatureEvidenceMatches(
  plan: RenderFeatureWorkPlan,
  signature: string,
): boolean {
  const evidence = signatureEvidenceByPlan.get(plan as object);
  return (
    evidence !== undefined &&
    evidence.signature === signature &&
    renderFeaturePlanSignatureSnapshotEquals(plan, evidence.snapshot)
  );
}

function stable(value: unknown, metrics?: RenderFeaturePlanSignatureMetrics): string {
  const parts: string[] = [];
  appendStable(value, parts, metrics);
  return parts.join('');
}

function appendStable(
  value: unknown,
  parts: string[],
  metrics?: RenderFeaturePlanSignatureMetrics,
): void {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (metrics !== undefined) metrics.typedArrayBytes += bytes.byteLength;
    // Keep every byte in the canonical identity. Decimal Array#join creates
    // a number/string conversion and a separator for every byte; bounded hex
    // chunks cut that allocation footprint while remaining deterministic.
    appendByteHex(value, parts);
    return;
  }
  if (Array.isArray(value)) {
    parts.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) parts.push(',');
      // Array#join renders holes and an explicit undefined child as an empty
      // field; retain that canonical spelling instead of writing "undefined".
      if (value[index] !== undefined) appendStable(value[index], parts, metrics);
    }
    parts.push(']');
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Readonly<Record<string, unknown>>).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    parts.push('{');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string;
      if (index > 0) parts.push(',');
      parts.push(JSON.stringify(key), ':');
      appendStable((value as Readonly<Record<string, unknown>>)[key], parts, metrics);
    }
    parts.push('}');
    return;
  }
  parts.push(JSON.stringify(value) ?? 'undefined');
}

function resourceTopology(
  resource: RenderFeatureResourceDeclaration,
  metrics?: RenderFeaturePlanSignatureMetrics,
): unknown {
  if (resource.kind === 'scene-depth') return { ...resource, camera: undefined };
  if (resource.kind === 'buffer') {
    if (metrics !== undefined && resource.data !== undefined) {
      metrics.typedArrayBytes += resource.data.byteLength;
    }
    return { ...resource, usage: [...resource.usage].sort(), data: undefined };
  }
  if (resource.kind === 'prepared-gpu-resource') {
    return {
      ...resource,
      resource:
        resource.resource.kind === 'buffer'
          ? {
              kind: 'buffer',
              size: resource.resource.size,
              usage: [...(resource.resource.usage ?? [])].sort(),
            }
          : { kind: resource.resource.kind },
    };
  }
  return resource;
}

/** Canonical signature used by typed-graph topology and last-known-good swap. */
export function renderFeaturePlanSignature(
  plan: RenderFeatureWorkPlan,
  metrics?: RenderFeaturePlanSignatureMetrics,
): string {
  if (metrics !== undefined) metrics.calls += 1;
  const signature = stable(
    {
      resources: plan.resources.map((resource) => resourceTopology(resource, metrics)),
      passes: plan.passes,
    },
    metrics,
  );
  if (metrics !== undefined) metrics.outputChars += signature.length;
  return signature;
}

function bindingAccess(type: GPUBufferBindingType | undefined): GraphBufferAccess | undefined {
  switch (type) {
    case 'uniform':
      return 'uniform-read';
    case 'read-only-storage':
      return 'storage-read';
    case 'storage':
      return 'storage-read-write';
    case undefined:
      return undefined;
  }
}

/** Derive graph access from descriptor roles; producers never author a parallel ledger. */
export function deriveRenderFeaturePassAccess(
  plan: RenderFeatureWorkPlan,
  pass: RenderFeaturePassDeclaration,
): readonly RenderFeatureDerivedAccess[] {
  const resources = new Map(plan.resources.map((resource) => [resource.name, resource]));
  const accesses: RenderFeatureDerivedAccess[] = [];
  if (pass.kind === 'compute') {
    const program = resources.get(pass.program);
    const bindings = resources.get(pass.bindings);
    const layoutEntries =
      program?.kind === 'compute-program' ? (program.program.bindings?.[0]?.entries ?? []) : [];
    if (bindings?.kind === 'compute-bindings') {
      for (const entry of bindings.entries) {
        const usage = bindingAccess(
          layoutEntries.find((candidate) => candidate.binding === entry.binding)?.buffer?.type,
        );
        if (usage !== undefined) accesses.push({ resource: entry.resource, usage });
        const declaration = resources.get(entry.resource);
        if (
          declaration?.kind === 'prepared-gpu-resource' &&
          declaration.logicalTarget !== undefined
        ) {
          const layout = layoutEntries.find((candidate) => candidate.binding === entry.binding);
          const usage =
            layout?.storageTexture?.access === 'write-only'
              ? 'storage-write'
              : layout?.storageTexture?.access === 'read-only'
                ? 'storage-read'
                : layout?.storageTexture?.access === 'read-write'
                  ? 'sampled-storage-read-write'
                  : 'sampled-read';
          accesses.push({ resource: declaration.logicalTarget, usage });
        }
      }
    }
    for (const dispatch of pass.dispatches) {
      if (dispatch.kind === 'indirect') {
        accesses.push({ resource: dispatch.resource, usage: 'indirect-read' });
      }
    }
    return Object.freeze(accesses);
  }

  for (const attachment of pass.kind === 'raster' ? pass.colorAttachments : []) {
    accesses.push({ resource: attachment.target, usage: 'color-attachment' });
  }
  if (pass.kind === 'raster' && pass.depthStencilAttachment !== undefined) {
    accesses.push({
      resource: pass.depthStencilAttachment.target,
      usage: pass.sampledTargets?.some(
        (target) => typeof target === 'string' && target === pass.depthStencilAttachment?.target,
      )
        ? 'depth-stencil-read'
        : 'depth-stencil-write',
    });
  }
  for (const target of pass.kind === 'raster' ? (pass.sampledTargets ?? []) : []) {
    if (typeof target !== 'string') continue;
    accesses.push({ resource: target, usage: 'sampled-read' });
  }
  for (const draw of pass.draws) {
    for (const vertex of draw.vertexData) {
      const declaration = resources.get(vertex.resource);
      accesses.push({
        resource:
          declaration?.kind === 'vertex-data' && declaration.buffer !== undefined
            ? declaration.buffer
            : vertex.resource,
        usage: 'vertex-read',
      });
    }
    if (draw.indexData !== undefined) {
      const declaration = resources.get(draw.indexData.resource);
      accesses.push({
        resource:
          declaration?.kind === 'index-data' && declaration.buffer !== undefined
            ? declaration.buffer
            : draw.indexData.resource,
        usage: 'index-read',
      });
    }
    if (draw.draw.kind === 'draw-indirect' || draw.draw.kind === 'draw-indexed-indirect') {
      accesses.push({ resource: draw.draw.resource, usage: 'indirect-read' });
    }
  }
  return Object.freeze(accesses);
}

function validPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function freezeRenderFeaturePlan(
  identity: string,
  plan: RenderFeatureWorkPlan,
  logicalTargets: readonly RenderFeatureLogicalTarget[] = [],
): Result<RenderFeatureWorkPlan, RenderError> {
  const resources = new Map<string, RenderFeatureResourceDeclaration>();
  const targets = new Set(['swapchain', ...logicalTargets.map((target) => target.name)]);
  for (const resource of plan.resources) {
    if (!validName(resource.name) || resources.has(resource.name))
      return err(stageFailure(identity));
    if (
      resource.kind === 'scene-depth' &&
      [
        [resource.camera.position, 3],
        [resource.camera.right, 3],
        [resource.camera.up, 3],
        [resource.camera.viewProjection, 16],
      ].some(
        ([data, length]) =>
          !(data instanceof Float32Array) || data.length !== length || !data.every(Number.isFinite),
      )
    )
      return err(stageFailure(identity));
    if (
      resource.kind === 'prepared-gpu-resource' &&
      resource.logicalTarget !== undefined &&
      !(typeof resource.logicalTarget === 'string'
        ? targets.has(resource.logicalTarget)
        : isSceneDataTarget(resource.logicalTarget))
    ) {
      return err(stageFailure(identity));
    }
    resources.set(resource.name, resource);
  }
  const passes = new Set<string>();
  for (const pass of plan.passes) {
    if (!validName(pass.name) || passes.has(pass.name)) return err(stageFailure(identity));
    passes.add(pass.name);
    if (pass.kind === 'compute') {
      const program = resources.get(pass.program);
      const bindings = resources.get(pass.bindings);
      if (
        program?.kind !== 'compute-program' ||
        bindings?.kind !== 'compute-bindings' ||
        bindings.program !== pass.program ||
        pass.dispatches.length === 0
      ) {
        return err(stageFailure(identity));
      }
      const entryPoints = new Set(program.program.entryPoints);
      for (const entry of bindings.entries) {
        const layout = program.program.bindings?.[0]?.entries.find(
          (candidate) => candidate.binding === entry.binding,
        );
        const resource = resources.get(entry.resource);
        const validBuffer = resource?.kind === 'buffer' && layout?.buffer !== undefined;
        const validPrepared =
          resource?.kind === 'prepared-gpu-resource' &&
          ((resource.resource.kind === 'buffer' && layout?.buffer !== undefined) ||
            (resource.resource.kind === 'texture-view' &&
              (layout?.texture !== undefined || layout?.storageTexture !== undefined)) ||
            (resource.resource.kind === 'sampler' && layout?.sampler !== undefined));
        const validSceneInput =
          (resource?.kind === 'scene-depth' && layout?.texture?.sampleType === 'depth') ||
          (resource?.kind === 'scene-noise' && layout?.texture !== undefined);
        if (!validBuffer && !validPrepared && !validSceneInput) {
          return err(stageFailure(identity));
        }
      }
      for (const dispatch of pass.dispatches) {
        if (!entryPoints.has(dispatch.entryPoint)) return err(stageFailure(identity));
        if (dispatch.kind === 'direct') {
          if (
            !dispatch.workgroups.every(
              (value) => value === undefined || validPositiveInteger(value),
            )
          ) {
            return err(stageFailure(identity));
          }
        } else {
          const buffer = resources.get(dispatch.resource);
          if (
            buffer?.kind !== 'buffer' ||
            !buffer.usage.includes('indirect') ||
            !Number.isInteger(dispatch.offset) ||
            dispatch.offset < 0 ||
            dispatch.offset % 4 !== 0
          ) {
            return err(stageFailure(identity));
          }
        }
      }
      continue;
    }

    if (
      pass.draws.length === 0 ||
      (pass.kind === 'raster' &&
        (pass.colorAttachments.some((attachment) => !targets.has(attachment.target)) ||
          (pass.depthStencilAttachment !== undefined &&
            !targets.has(pass.depthStencilAttachment.target)) ||
          pass.sampledTargets?.some(
            (target) => typeof target === 'string' && !targets.has(target),
          ) === true))
    ) {
      return err(stageFailure(identity));
    }
    for (const draw of pass.draws) {
      const program = resources.get(draw.program);
      if (
        program?.kind !== 'graphics-program' ||
        (pass.kind === 'shadow-caster' &&
          (program.program.colorFormats.length !== 0 ||
            program.program.depthFormat !== 'depth32float')) ||
        draw.bindings.some((name) => {
          const binding = resources.get(name);
          return binding?.kind !== 'graphics-bindings' || binding.program !== draw.program;
        }) ||
        draw.vertexData.some(
          (binding) => resources.get(binding.resource)?.kind !== 'vertex-data',
        ) ||
        (draw.indexData !== undefined &&
          resources.get(draw.indexData.resource)?.kind !== 'index-data') ||
        ((draw.draw.kind === 'draw-indirect' || draw.draw.kind === 'draw-indexed-indirect') &&
          (() => {
            const buffer = resources.get(draw.draw.resource);
            return buffer?.kind !== 'buffer' || !buffer.usage.includes('indirect');
          })())
      ) {
        return err(stageFailure(identity));
      }
    }
  }

  const frozen = Object.freeze({
    resources: Object.freeze(plan.resources.map((resource) => Object.freeze({ ...resource }))),
    passes: Object.freeze(plan.passes.map((pass) => Object.freeze({ ...pass }))),
  });
  return ok(frozen);
}
