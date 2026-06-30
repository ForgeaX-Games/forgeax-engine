// @forgeax/engine-render-graph/src/resource-registry.ts — resource
// declaration registry (plan-strategy 3.1).
//
// Shape (D-4/D-6.1):
// - string key -> ResourceDescriptor + bufferRole + lifetime
// - duplicate-resource fail-fast at registration time
// - unknown-resource fail-fast at pass binding time
// - addColorTarget: color target registration with format/size/sample/usage

import {
  type CapMissingDetail,
  type DanglingReadDetail,
  type DuplicateResourceDetail,
  err,
  ok,
  RenderGraphError,
  type Result,
} from './errors.js';
import type {
  ColorTargetDescriptor,
  ColorTargetSize,
  ResourceDescriptor,
  ResourceLifetime,
} from './graph.js';

/**
 * Per-resource GPU allocation metadata carried through compile.
 * When the resource was registered via addColorTarget, colorTarget
 * carries the format/size/sample/usage fields (w5); when via
 * addResource it is undefined.
 */
export interface ColorTargetResourceMeta {
  readonly format: string;
  readonly size: ColorTargetSize;
  readonly sample: number;
  readonly usage: number;
  /**
   * Extra texture view formats pre-declared at GPU texture creation. Mirrors
   * GPUTextureDescriptor.viewFormats. Used by the LDR MSAA path which needs a
   * `bgra8unorm` storage texture plus a `bgra8unorm-srgb` view of the same
   * texture for hardware sRGB encoding on store.
   */
  readonly viewFormats?: readonly string[] | undefined;
  /**
   * When set, this resource is an alias of the given source resource.
   * The compile allocation phase folds the alias into the source's
   * physical texture (KB-1 MoveNode pattern, D-2).
   */
  readonly aliasedFrom?: string | undefined;
}

export interface ResourceEntry {
  readonly key: string;
  readonly descriptor: ResourceDescriptor;
  readonly lifetime: ResourceLifetime;
  /** Present when the resource was registered via addColorTarget (w5). */
  readonly colorTarget?: ColorTargetResourceMeta | undefined;
}

export class ResourceRegistry {
  private readonly resources = new Map<string, ResourceEntry>();

  add(key: string, descriptor: ResourceDescriptor): Result<ResourceEntry, RenderGraphError> {
    if (this.resources.has(key)) {
      return err(
        new RenderGraphError({
          code: 'duplicate-resource',
          expected: `resource key '${key}' registered exactly once`,
          hint: `remove the duplicate addResource('${key}', ...) call or use a different key`,
          detail: { resourceKey: key } satisfies DuplicateResourceDetail,
        }),
      );
    }
    const entry: ResourceEntry = {
      key,
      descriptor,
      lifetime: descriptor.lifetime,
    };
    this.resources.set(key, entry);
    return ok(entry);
  }

  /**
   * Register a color target resource (D-8).
   * Same semantics as addResource with kind:'texture' + lifetime:'transient'
   * plus GPU texture allocation metadata.
   */
  addColorTarget(name: string, desc: ColorTargetDescriptor): ResourceEntry {
    const colorTargetMeta: ColorTargetResourceMeta = {
      format: desc.format,
      size: desc.size,
      sample: desc.sample ?? 1,
      usage: desc.usage ?? 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      ...(desc.viewFormats !== undefined ? { viewFormats: desc.viewFormats } : {}),
    };
    const entry: ResourceEntry = {
      key: name,
      descriptor: { kind: 'texture', lifetime: 'transient' },
      lifetime: 'transient',
      colorTarget: colorTargetMeta,
    };
    this.resources.set(name, entry);
    return entry;
  }

  /**
   * Register a color target alias that folds into the source's physical
   * texture at compile time (KB-1 MoveNode pattern, D-2).
   * The source must already be registered via addColorTarget.
   */
  addColorTargetAlias(name: string, source: string): ResourceEntry {
    const sourceEntry = this.resources.get(source);
    const sourceMeta = sourceEntry?.colorTarget;
    const entry: ResourceEntry = {
      key: name,
      descriptor: { kind: 'texture', lifetime: 'transient' },
      lifetime: 'transient',
      colorTarget: sourceMeta
        ? {
            format: sourceMeta.format,
            size: sourceMeta.size,
            sample: sourceMeta.sample,
            usage: sourceMeta.usage,
            aliasedFrom: source,
          }
        : {
            format: 'rgba16float',
            size: 'swapchain',
            sample: 1,
            usage: 0x10 | 0x04,
            aliasedFrom: source,
          },
    };
    this.resources.set(name, entry);
    return entry;
  }

  get(key: string): ResourceEntry | undefined {
    return this.resources.get(key);
  }

  has(key: string): boolean {
    return this.resources.has(key);
  }

  entries(): IterableIterator<ResourceEntry> {
    return this.resources.values();
  }
}

// Re-export detail types for use by graph.ts compile fail-fast.
export type { CapMissingDetail, DanglingReadDetail, DuplicateResourceDetail };
