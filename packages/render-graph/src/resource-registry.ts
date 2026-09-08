// @forgeax/engine-render-graph/src/resource-registry.ts — resource
// declaration registry (plan-strategy 3.1).
//
// Shape (D-4/D-6.1):
// - string key -> ResourceDescriptor + bufferRole + lifetime
// - duplicate-resource fail-fast across every declaration form
// - unknown-resource fail-fast at pass binding time
// - addColorTarget: color target registration with format/size/sample/usage

import type { TextureFormat } from '@forgeax/engine-rhi';
import {
  type AliasSourceDetail,
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
import type { ColorValueDomain } from './pipeline/color-value-domain.js';

/**
 * Per-resource GPU allocation metadata carried through compile.
 * When the resource was registered via addColorTarget, colorTarget
 * carries the format/size/sample/usage fields (w5); when via
 * addResource it is undefined.
 */
export interface ColorTargetResourceMeta {
  readonly format: TextureFormat;
  readonly size: ColorTargetSize;
  readonly sample: number;
  readonly usage: number;
  /** Explicit semantic color domain; never derived from format. */
  readonly domain?: ColorValueDomain | undefined;
  /**
   * Extra texture view formats pre-declared at GPU texture creation. Mirrors
   * GPUTextureDescriptor.viewFormats. Used by the LDR MSAA path which needs a
   * `bgra8unorm` storage texture plus a `bgra8unorm-srgb` view of the same
   * texture for hardware sRGB encoding on store.
   */
  readonly viewFormats?: readonly TextureFormat[] | undefined;
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
    const entry: ResourceEntry = {
      key,
      descriptor,
      lifetime: descriptor.lifetime,
    };
    return this.register(entry);
  }

  /**
   * Register a color target resource (D-8).
   * Same semantics as addResource with kind:'texture' plus GPU texture
   * allocation metadata. Existing callers default to a transient target.
   */
  addColorTarget(
    name: string,
    desc: ColorTargetDescriptor,
  ): Result<ResourceEntry, RenderGraphError> {
    const lifetime = desc.lifetime ?? 'transient';
    const colorTargetMeta: ColorTargetResourceMeta = {
      format: desc.format,
      size: desc.size,
      sample: desc.sample ?? 1,
      usage: desc.usage ?? 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      ...(desc.domain !== undefined ? { domain: desc.domain } : {}),
      ...(desc.viewFormats !== undefined ? { viewFormats: desc.viewFormats } : {}),
    };
    const entry: ResourceEntry = {
      key: name,
      descriptor: { kind: 'texture', lifetime },
      lifetime,
      colorTarget: colorTargetMeta,
    };
    return this.register(entry);
  }

  /**
   * Register a color target alias that folds into the source's physical
   * texture at compile time (KB-1 MoveNode pattern, D-2).
   * The source must already be registered via addColorTarget.
   */
  addColorTargetAlias(name: string, source: string): Result<ResourceEntry, RenderGraphError> {
    if (this.resources.has(name)) return this.duplicateResource(name);
    const sourceMeta = this.resources.get(source)?.colorTarget;
    if (sourceMeta === undefined) {
      return err(
        new RenderGraphError({
          code: 'alias-source-missing',
          expected: `alias '${name}' source '${source}' must be a registered color target`,
          hint: `call addColorTarget('${source}', ...) before retrying alias '${name}'`,
          detail: { aliasKey: name, sourceKey: source } satisfies AliasSourceDetail,
        }),
      );
    }
    const entry: ResourceEntry = {
      key: name,
      descriptor: { kind: 'texture', lifetime: 'transient' },
      lifetime: 'transient',
      colorTarget: {
        format: sourceMeta.format,
        size: sourceMeta.size,
        sample: sourceMeta.sample,
        usage: sourceMeta.usage,
        ...(sourceMeta.domain !== undefined ? { domain: sourceMeta.domain } : {}),
        ...(sourceMeta.viewFormats !== undefined ? { viewFormats: sourceMeta.viewFormats } : {}),
        aliasedFrom: source,
      },
    };
    return this.register(entry);
  }

  private duplicateResource(key: string): Result<ResourceEntry, RenderGraphError> {
    return err(
      new RenderGraphError({
        code: 'duplicate-resource',
        expected: `resource key '${key}' registered exactly once`,
        hint: `remove the duplicate resource declaration for '${key}' or use a different key`,
        detail: { resourceKey: key } satisfies DuplicateResourceDetail,
      }),
    );
  }

  private register(entry: ResourceEntry): Result<ResourceEntry, RenderGraphError> {
    if (this.resources.has(entry.key)) return this.duplicateResource(entry.key);
    this.resources.set(entry.key, entry);
    return ok(entry);
  }

  get(key: string): ResourceEntry | undefined {
    return this.resources.get(key);
  }

  getColorTargetMeta(key: string): ColorTargetResourceMeta | undefined {
    return this.resources.get(key)?.colorTarget;
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
