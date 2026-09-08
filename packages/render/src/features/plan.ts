import type { GraphBufferAccess, GraphTextureAccess } from '@forgeax/engine-render-graph';
import type { RhiCaps, TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
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
  | 'render-material';

export type RenderFeatureFullscreenRead =
  | string
  | { readonly key: string; readonly sampleType?: 'depth' };

/** A cooked fullscreen shader declaration owned by a RenderFeature plan. */
export interface RenderFeatureFullscreenProgramDeclaration {
  readonly kind: 'fullscreen-program';
  readonly name: string;
  readonly source: string;
  readonly reads?: readonly RenderFeatureFullscreenRead[];
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
  | readonly RenderFeatureBindingValue[]
  | { readonly [name: string]: RenderFeatureBindingValue };

export type RenderFeatureResourceDeclaration =
  | RenderFeatureFullscreenProgramDeclaration
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
      readonly sampledTargets?: readonly string[];
      readonly draws: readonly RenderFeatureDrawDeclaration[];
    };

/**
 * The sole executable feature declaration for one frame. Programs, bindings,
 * resources, dispatches, draws, and logical targets are all named here; graph
 * access is derived from these roles rather than duplicated as reads/writes.
 */
export interface RenderFeaturePlan {
  readonly resources: readonly RenderFeatureResourceDeclaration[];
  readonly passes: readonly RenderFeaturePassDeclaration[];
}

export interface RenderFeatureLogicalTarget {
  readonly name: string;
  readonly kind: 'color' | 'depth' | 'swapchain';
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderFeaturePlanContext {
  readonly caps: Readonly<RhiCaps>;
  readonly frame: { readonly frameNumber: number };
  readonly generation: number;
  readonly targets: readonly RenderFeatureLogicalTarget[];
  /** Resolve a material shader's renderer-owned binding contract. */
  readonly materialShaderBindingContract?: (
    materialShaderId: string,
  ) => RenderFeatureMaterialShaderBindingContract;
}

/** Frozen declaration produced for one feature in one frame. */
export interface RenderFeaturePlannedFrame {
  readonly featureIdentity: string;
  readonly generation: number;
  readonly signature: string;
  readonly plan: RenderFeaturePlan;
}

export interface RenderFeatureDerivedAccess {
  readonly resource: string;
  readonly usage: RenderFeatureResourceUsage;
}

function stageFailure(identity: string): RenderError {
  return {
    code: 'render-feature-stage-failed',
    expected: 'a closed RenderFeaturePlan with valid named descriptor references',
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

function stable(value: unknown): string {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `[bytes:${Array.from(bytes).join(',')}]`;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resourceTopology(resource: RenderFeatureResourceDeclaration): unknown {
  if (resource.kind === 'buffer') {
    return { ...resource, usage: [...resource.usage].sort(), data: undefined };
  }
  return resource;
}

/** Canonical signature used by typed-graph topology and last-known-good swap. */
export function renderFeaturePlanSignature(plan: RenderFeaturePlan): string {
  return stable({
    resources: plan.resources.map(resourceTopology),
    passes: plan.passes,
  });
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
  plan: RenderFeaturePlan,
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
      }
    }
    for (const dispatch of pass.dispatches) {
      if (dispatch.kind === 'indirect') {
        accesses.push({ resource: dispatch.resource, usage: 'indirect-read' });
      }
    }
    return Object.freeze(accesses);
  }

  for (const attachment of pass.colorAttachments) {
    accesses.push({ resource: attachment.target, usage: 'color-attachment' });
  }
  if (pass.depthStencilAttachment !== undefined) {
    accesses.push({
      resource: pass.depthStencilAttachment.target,
      usage: pass.sampledTargets?.includes(pass.depthStencilAttachment.target)
        ? 'depth-stencil-read'
        : 'depth-stencil-write',
    });
  }
  for (const target of pass.sampledTargets ?? []) {
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
  plan: RenderFeaturePlan,
  logicalTargets: readonly RenderFeatureLogicalTarget[] = [],
): Result<RenderFeaturePlan, RenderError> {
  const resources = new Map<string, RenderFeatureResourceDeclaration>();
  const targets = new Set(['swapchain', ...logicalTargets.map((target) => target.name)]);
  for (const resource of plan.resources) {
    if (!validName(resource.name) || resources.has(resource.name))
      return err(stageFailure(identity));
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
        const buffer = resources.get(entry.resource);
        const layout = program.program.bindings?.[0]?.entries.find(
          (candidate) => candidate.binding === entry.binding,
        );
        if (buffer?.kind !== 'buffer' || layout?.buffer === undefined) {
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
      pass.colorAttachments.some((attachment) => !targets.has(attachment.target)) ||
      (pass.depthStencilAttachment !== undefined &&
        !targets.has(pass.depthStencilAttachment.target)) ||
      pass.sampledTargets?.some((target) => !targets.has(target)) === true
    ) {
      return err(stageFailure(identity));
    }
    for (const draw of pass.draws) {
      const program = resources.get(draw.program);
      if (
        program?.kind !== 'graphics-program' ||
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
