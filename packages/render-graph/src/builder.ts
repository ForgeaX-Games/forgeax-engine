import type { Buffer, RhiCaps, Texture, TextureView } from '@forgeax/engine-rhi';
import { CompiledRenderGraphImpl } from './compiled-graph.js';
import { err, ok, RenderGraphError, type Result } from './errors.js';
import {
  accessResourceId,
  bufferHandle,
  type CompiledPass,
  type CompiledResource,
  type CompiledView,
  handleData,
  type PassRecord,
  type ResourceRecord,
  type TextureViewRecord,
  textureHandle,
  textureViewHandle,
} from './kernel-internal.js';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphInfo,
  ComputeGraphPass,
  CopyGraphPass,
  GraphAccess,
  GraphBuffer,
  GraphBufferAccess,
  GraphBufferDescriptor,
  GraphExtent,
  GraphPass,
  GraphTexture,
  GraphTextureAccess,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  ImportedBufferDescriptor,
  ImportedTextureDescriptor,
  ImportedTextureViewResolver,
  RasterGraphPass,
  RenderGraphCompileOptions,
  RenderGraphFrame,
} from './types.js';

const BUFFER_USAGE = {
  copySrc: 0x0004,
  copyDst: 0x0008,
  index: 0x0010,
  vertex: 0x0020,
  uniform: 0x0040,
  storage: 0x0080,
  indirect: 0x0100,
} as const;

const TEXTURE_USAGE = {
  copySrc: 0x01,
  copyDst: 0x02,
  textureBinding: 0x04,
  storageBinding: 0x08,
  renderAttachment: 0x10,
} as const;

let nextGeneration = 1;

interface NormalizedRange {
  readonly mipStart: number;
  readonly mipEnd: number;
  readonly layerStart: number;
  readonly layerEnd: number;
  readonly aspect: GPUTextureAspect;
}

interface NormalizedAccess {
  readonly passIndex: number;
  readonly passName: string;
  readonly resourceId: number;
  readonly viewId?: number | undefined;
  readonly usage: GraphBufferAccess | GraphTextureAccess;
  readonly read: boolean;
  readonly write: boolean;
  readonly range?: NormalizedRange | undefined;
}

function bufferUsage(access: GraphBufferAccess): number {
  switch (access) {
    case 'uniform-read':
      return BUFFER_USAGE.uniform;
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return BUFFER_USAGE.storage;
    case 'indirect-read':
      return BUFFER_USAGE.indirect;
    case 'vertex-read':
      return BUFFER_USAGE.vertex;
    case 'index-read':
      return BUFFER_USAGE.index;
    case 'copy-src':
      return BUFFER_USAGE.copySrc;
    case 'copy-dst':
      return BUFFER_USAGE.copyDst;
  }
}

function textureUsage(access: GraphTextureAccess): number {
  switch (access) {
    case 'sampled-read':
      return TEXTURE_USAGE.textureBinding;
    case 'storage-read':
    case 'storage-write':
    case 'storage-read-write':
      return TEXTURE_USAGE.storageBinding;
    case 'color-attachment':
    case 'depth-stencil-read':
    case 'depth-stencil-write':
      return TEXTURE_USAGE.renderAttachment;
    case 'copy-src':
      return TEXTURE_USAGE.copySrc;
    case 'copy-dst':
      return TEXTURE_USAGE.copyDst;
  }
}

function accessMode(access: GraphBufferAccess | GraphTextureAccess): {
  readonly read: boolean;
  readonly write: boolean;
} {
  switch (access) {
    case 'storage-read-write':
      return { read: true, write: true };
    case 'storage-write':
    case 'color-attachment':
    case 'depth-stencil-write':
    case 'copy-dst':
      return { read: false, write: true };
    default:
      return { read: true, write: false };
  }
}

function rangesOverlap(
  left: NormalizedRange | undefined,
  right: NormalizedRange | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  const aspectOverlap =
    left.aspect === 'all' || right.aspect === 'all' || left.aspect === right.aspect;
  return (
    aspectOverlap &&
    left.mipStart < right.mipEnd &&
    right.mipStart < left.mipEnd &&
    left.layerStart < right.layerEnd &&
    right.layerStart < left.layerEnd
  );
}

function freezeInfo(info: CompiledRenderGraphInfo): CompiledRenderGraphInfo {
  return Object.freeze({
    passes: Object.freeze(
      info.passes.map((pass) =>
        Object.freeze({
          ...pass,
          accesses: Object.freeze(pass.accesses.map((access) => Object.freeze({ ...access }))),
          dependencies: Object.freeze([...pass.dependencies]),
        }),
      ),
    ),
    resources: Object.freeze(info.resources.map((resource) => Object.freeze({ ...resource }))),
  });
}

export class RenderGraphBuilder<FrameCtx extends RenderGraphFrame> {
  private readonly owner = Object.freeze({});
  private readonly labels = new Set<string>();
  private readonly resources = new Map<number, ResourceRecord<FrameCtx>>();
  private readonly views = new Map<number, TextureViewRecord<FrameCtx>>();
  private readonly passes: PassRecord<FrameCtx>[] = [];
  private readonly passNames = new Set<string>();
  private nextId = 1;
  private sealed = false;

  createTexture(
    label: string,
    descriptor: GraphTextureDescriptor,
  ): Result<GraphTexture, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    const unique = this.reserveLabel(label);
    if (!unique.ok) return unique;
    const id = this.nextId++;
    this.resources.set(id, { id, label, kind: 'texture', origin: 'created', descriptor });
    return ok(textureHandle(this.owner, id));
  }

  importTexture(
    label: string,
    descriptor: ImportedTextureDescriptor,
    resolve: (frame: FrameCtx) => Texture,
  ): Result<GraphTexture, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    const unique = this.reserveLabel(label);
    if (!unique.ok) return unique;
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'texture',
      origin: 'imported',
      descriptor,
      resolve,
    });
    return ok(textureHandle(this.owner, id));
  }

  createBuffer(
    label: string,
    descriptor: GraphBufferDescriptor,
  ): Result<GraphBuffer, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    const unique = this.reserveLabel(label);
    if (!unique.ok) return unique;
    const id = this.nextId++;
    this.resources.set(id, { id, label, kind: 'buffer', origin: 'created', descriptor });
    return ok(bufferHandle(this.owner, id));
  }

  importBuffer(
    label: string,
    descriptor: ImportedBufferDescriptor,
    resolve: (frame: FrameCtx) => Buffer,
  ): Result<GraphBuffer, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    const unique = this.reserveLabel(label);
    if (!unique.ok) return unique;
    const id = this.nextId++;
    this.resources.set(id, {
      id,
      label,
      kind: 'buffer',
      origin: 'imported',
      descriptor,
      resolve,
    });
    return ok(bufferHandle(this.owner, id));
  }

  view(
    texture: GraphTexture,
    descriptor: GraphTextureViewDescriptor = {},
  ): Result<GraphTextureView, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    const data = handleData(texture);
    if (data?.kind !== 'texture' || data.owner !== this.owner) {
      return err(this.foreignHandleError());
    }
    const textureRecord = this.resources.get(data.id);
    if (textureRecord?.kind !== 'texture') return err(this.foreignHandleError());
    const label = descriptor.label ?? `${textureRecord.label}.view.${this.nextId}`;
    const unique = this.reserveLabel(label);
    if (!unique.ok) return unique;
    const id = this.nextId++;
    this.views.set(id, { id, label, textureId: data.id, descriptor });
    return ok(textureViewHandle(this.owner, id, data.id));
  }

  importView(
    texture: GraphTexture,
    descriptor: GraphTextureViewDescriptor,
    resolve: ImportedTextureViewResolver<FrameCtx>,
  ): Result<GraphTextureView, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    const data = handleData(texture);
    if (data?.kind !== 'texture' || data.owner !== this.owner) {
      return err(this.foreignHandleError());
    }
    const textureRecord = this.resources.get(data.id);
    if (textureRecord?.kind !== 'texture' || textureRecord.origin !== 'imported') {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'an imported view belongs to an imported texture',
          hint: 'use view() for graph-created textures and importView() for host-owned views',
          detail: {
            resourceLabel: textureRecord?.label ?? 'foreign',
            field: 'origin',
            expected: 'imported',
            actual: textureRecord?.origin ?? 'foreign',
          },
        }),
      );
    }
    const label = descriptor.label ?? `${textureRecord.label}.view.${this.nextId}`;
    const unique = this.reserveLabel(label);
    if (!unique.ok) return unique;
    const id = this.nextId++;
    this.views.set(id, { id, label, textureId: data.id, descriptor, resolve });
    return ok(textureViewHandle(this.owner, id, data.id));
  }

  addRasterPass(
    name: string,
    descriptor: RasterGraphPass<FrameCtx>,
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'raster', descriptor });
  }

  addComputePass(
    name: string,
    descriptor: ComputeGraphPass<FrameCtx>,
  ): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'compute', descriptor });
  }

  addCopyPass(name: string, descriptor: CopyGraphPass<FrameCtx>): Result<void, RenderGraphError> {
    return this.addPass(name, { kind: 'copy', descriptor });
  }

  compile(
    options: RenderGraphCompileOptions,
  ): Result<CompiledRenderGraph<FrameCtx>, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    this.sealed = true;

    const descriptors = this.validateDescriptors(options.surfaceSize);
    if (!descriptors.ok) return descriptors;
    const analyzed = this.analyze(options.device.caps);
    if (!analyzed.ok) return analyzed;

    const allocated = this.allocate(
      options,
      analyzed.value.usageByResource,
      analyzed.value.firstUseByResource,
      analyzed.value.lastUseByResource,
    );
    if (!allocated.ok) return allocated;

    const info = freezeInfo({
      passes: analyzed.value.passes.map((pass, executionIndex) => ({
        name: pass.name,
        kind: pass.pass.kind,
        executionIndex,
        accesses: pass.pass.descriptor.accesses.map((access) => {
          const id = accessResourceId(access);
          return {
            resource: this.resources.get(id ?? -1)?.label ?? 'foreign',
            usage: access.usage,
          };
        }),
        dependencies: pass.dependencies.map(
          (dependency) => analyzed.value.passes[dependency]?.name ?? 'unknown',
        ),
      })),
      resources: [...allocated.value.resources.values()].map((resource) => ({
        label: resource.record.label,
        kind: resource.record.kind,
        origin: resource.record.origin,
        firstUse: resource.firstUse,
        lastUse: resource.lastUse,
        derivedUsage: resource.usage,
      })),
    });

    return ok(
      new CompiledRenderGraphImpl(
        nextGeneration++,
        this.owner,
        options.device,
        allocated.value.resources,
        allocated.value.views,
        Object.freeze(analyzed.value.passes),
        info,
      ),
    );
  }

  private addPass(name: string, pass: GraphPass<FrameCtx>): Result<void, RenderGraphError> {
    const writable = this.ensureWritable();
    if (!writable.ok) return writable;
    if (this.passNames.has(name)) {
      return err(
        new RenderGraphError({
          code: 'duplicate-pass-name',
          expected: `pass name '${name}' is unique within one builder`,
          hint: `rename the second '${name}' pass; names are diagnostics, not identity`,
          detail: { passName: name },
        }),
      );
    }
    for (const access of pass.descriptor.accesses) {
      const valid = this.validateAccessHandle(name, access);
      if (!valid.ok) return valid;
    }
    this.passNames.add(name);
    this.passes.push({ id: this.passes.length, name, pass });
    return ok(undefined);
  }

  private validateAccessHandle(
    passName: string,
    access: GraphAccess,
  ): Result<void, RenderGraphError> {
    const data = handleData(access.resource);
    if (data === undefined || data.owner !== this.owner) {
      return err(this.foreignHandleError(passName));
    }
    if (data.kind === 'texture-view') {
      if (!this.views.has(data.id)) return err(this.foreignHandleError(passName));
      return ok(undefined);
    }
    if (data.kind !== 'buffer' || !this.resources.has(data.id)) {
      return err(this.foreignHandleError(passName));
    }
    return ok(undefined);
  }

  private analyze(caps: RhiCaps): Result<
    {
      readonly passes: readonly CompiledPass<FrameCtx>[];
      readonly usageByResource: ReadonlyMap<number, number>;
      readonly firstUseByResource: ReadonlyMap<number, number>;
      readonly lastUseByResource: ReadonlyMap<number, number>;
    },
    RenderGraphError
  > {
    const normalizedByPass: NormalizedAccess[][] = [];
    const usageByResource = new Map<number, number>();
    const firstUseByResource = new Map<number, number>();
    const lastUseByResource = new Map<number, number>();
    const compiledPasses: CompiledPass<FrameCtx>[] = [];
    const history: NormalizedAccess[] = [];

    for (let passIndex = 0; passIndex < this.passes.length; passIndex++) {
      const pass = this.passes[passIndex];
      if (pass === undefined) continue;
      const capability = this.validateCapabilities(pass, caps);
      if (!capability.ok) return capability;
      const normalized: NormalizedAccess[] = [];
      for (const access of pass.pass.descriptor.accesses) {
        const item = this.normalizeAccess(passIndex, pass, access);
        if (!item.ok) return item;
        normalized.push(item.value);
        const usage =
          this.resources.get(item.value.resourceId)?.kind === 'buffer'
            ? bufferUsage(access.usage as GraphBufferAccess)
            : textureUsage(access.usage as GraphTextureAccess);
        usageByResource.set(
          item.value.resourceId,
          (usageByResource.get(item.value.resourceId) ?? 0) | usage,
        );
        if (!firstUseByResource.has(item.value.resourceId)) {
          firstUseByResource.set(item.value.resourceId, passIndex);
        }
        lastUseByResource.set(item.value.resourceId, passIndex);
      }
      const conflict = this.validatePassAccesses(pass, normalized);
      if (!conflict.ok) return conflict;
      const attachments = this.validateAttachments(pass);
      if (!attachments.ok) return attachments;

      const dependencies = new Set<number>();
      for (const current of normalized) {
        if (current.read) {
          const priorWrite = this.findPriorWrite(history, current);
          if (priorWrite !== undefined) {
            dependencies.add(priorWrite.passIndex);
          } else if (this.resources.get(current.resourceId)?.origin === 'created') {
            const label = this.resources.get(current.resourceId)?.label;
            return err(
              new RenderGraphError({
                code: 'uninitialized-read',
                expected: `graph-created resource '${label}' is written before pass '${pass.name}' reads it`,
                hint: 'add a clear/write/copy-dst pass before the first read, or import initialized data',
                detail: { passName: pass.name, resourceLabel: label, usage: current.usage },
              }),
            );
          }
        }
        if (current.write) {
          for (const dependency of this.findWriteDependencies(history, current)) {
            dependencies.add(dependency);
          }
        }
      }
      normalizedByPass.push(normalized);
      history.push(...normalized);
      compiledPasses.push({
        ...pass,
        dependencies: Object.freeze([...dependencies].sort((left, right) => left - right)),
        resourceIds: new Set(normalized.map((access) => access.resourceId)),
        viewIds: new Set(
          normalized.flatMap((access) => (access.viewId === undefined ? [] : [access.viewId])),
        ),
      });
    }

    for (const [resourceId, usage] of usageByResource) {
      const resource = this.resources.get(resourceId);
      if (resource?.origin !== 'imported') continue;
      if ((resource.descriptor.usage & usage) !== usage) {
        return err(
          new RenderGraphError({
            code: 'import-usage-mismatch',
            expected: `imported resource '${resource.label}' physical usage contains derived graph usage ${usage}`,
            hint: 'recreate the imported resource with every usage declared by graph accesses',
            detail: {
              resourceLabel: resource.label,
              field: 'usage',
              expected: String(usage),
              actual: resource.descriptor.usage,
            },
          }),
        );
      }
    }

    return ok({
      passes: compiledPasses,
      usageByResource,
      firstUseByResource,
      lastUseByResource,
    });
  }

  private normalizeAccess(
    passIndex: number,
    pass: PassRecord<FrameCtx>,
    access: GraphAccess,
  ): Result<NormalizedAccess, RenderGraphError> {
    const passName = pass.name;
    const data = handleData(access.resource);
    if (data === undefined || data.owner !== this.owner) {
      return err(this.foreignHandleError(passName));
    }
    const mode = this.accessModeForPass(pass, access);
    if (data.kind === 'buffer') {
      return ok({ passIndex, passName, resourceId: data.id, usage: access.usage, ...mode });
    }
    if (data.kind !== 'texture-view') return err(this.foreignHandleError(passName));
    const view = this.views.get(data.id);
    const texture = this.resources.get(data.textureId);
    if (view === undefined || texture?.kind !== 'texture') {
      return err(this.foreignHandleError(passName));
    }
    const mipLevels = texture.descriptor.mipLevelCount ?? 1;
    const layers =
      typeof texture.descriptor.size === 'object'
        ? (texture.descriptor.size.depthOrArrayLayers ?? 1)
        : 1;
    const mipStart = view.descriptor.baseMipLevel ?? 0;
    const layerStart = view.descriptor.baseArrayLayer ?? 0;
    return ok({
      passIndex,
      passName,
      resourceId: data.textureId,
      viewId: data.id,
      usage: access.usage,
      ...mode,
      range: {
        mipStart,
        mipEnd: mipStart + (view.descriptor.mipLevelCount ?? mipLevels - mipStart),
        layerStart,
        layerEnd: layerStart + (view.descriptor.arrayLayerCount ?? layers - layerStart),
        aspect: view.descriptor.aspect ?? 'all',
      },
    });
  }

  private accessModeForPass(
    pass: PassRecord<FrameCtx>,
    access: GraphAccess,
  ): { readonly read: boolean; readonly write: boolean } {
    const base = accessMode(access.usage);
    if (pass.pass.kind !== 'raster' || handleData(access.resource)?.kind !== 'texture-view') {
      return base;
    }
    if (access.usage === 'color-attachment') {
      const attachment = pass.pass.descriptor.colorAttachments.find(
        (candidate) => candidate.view === access.resource,
      );
      return attachment?.loadOp === 'load' ? { read: true, write: true } : base;
    }
    if (access.usage === 'depth-stencil-write') {
      const attachment = pass.pass.descriptor.depthStencilAttachment;
      if (
        attachment?.view === access.resource &&
        (attachment.depthLoadOp === 'load' || attachment.stencilLoadOp === 'load')
      ) {
        return { read: true, write: true };
      }
    }
    return base;
  }

  private validateCapabilities(
    pass: PassRecord<FrameCtx>,
    caps: RhiCaps,
  ): Result<void, RenderGraphError> {
    if (pass.pass.kind === 'compute' && !caps.compute) {
      return this.capabilityError(pass.name, 'compute');
    }
    for (const access of pass.pass.descriptor.accesses) {
      if (
        (access.usage === 'storage-read' ||
          access.usage === 'storage-write' ||
          access.usage === 'storage-read-write') &&
        handleData(access.resource)?.kind === 'buffer' &&
        !caps.storageBuffer
      ) {
        return this.capabilityError(pass.name, 'storage-buffer', access);
      }
      if (
        (access.usage === 'storage-read' ||
          access.usage === 'storage-write' ||
          access.usage === 'storage-read-write') &&
        handleData(access.resource)?.kind === 'texture-view' &&
        !caps.storageTexture
      ) {
        return this.capabilityError(pass.name, 'storage-texture', access);
      }
      if (access.usage === 'indirect-read' && !caps.indirectDrawing) {
        return this.capabilityError(pass.name, 'indirect', access);
      }
    }
    return ok(undefined);
  }

  private capabilityError(
    passName: string,
    capability: 'compute' | 'storage-buffer' | 'storage-texture' | 'indirect',
    access?: GraphAccess,
  ): Result<never, RenderGraphError> {
    const resourceId = access === undefined ? undefined : accessResourceId(access);
    return err(
      new RenderGraphError({
        code: 'capability-missing',
        expected: `pass '${passName}' is built only when capability '${capability}' is available`,
        hint: 'select the fallback algorithm before adding this pass to the builder',
        detail: {
          passName,
          capability,
          ...(resourceId === undefined
            ? {}
            : { resourceLabel: this.resources.get(resourceId)?.label, usage: access?.usage }),
        },
      }),
    );
  }

  private validatePassAccesses(
    pass: PassRecord<FrameCtx>,
    accesses: readonly NormalizedAccess[],
  ): Result<void, RenderGraphError> {
    for (let leftIndex = 0; leftIndex < accesses.length; leftIndex++) {
      const left = accesses[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < accesses.length; rightIndex++) {
        const right = accesses[rightIndex];
        if (
          right === undefined ||
          left.resourceId !== right.resourceId ||
          !rangesOverlap(left.range, right.range)
        ) {
          continue;
        }
        if (!left.write && !right.write) continue;
        if (left.usage === right.usage && left.usage === 'storage-read-write') continue;
        const label = this.resources.get(left.resourceId)?.label;
        return err(
          new RenderGraphError({
            code: 'access-conflict',
            expected: `pass '${pass.name}' uses resource '${label}' in one compatible WebGPU usage scope`,
            hint: 'split conflicting read/write roles into ordered passes or use storage-read-write once',
            detail: {
              passName: pass.name,
              resourceLabel: label,
              accesses: [left.usage, right.usage],
            },
          }),
        );
      }
    }
    if (pass.pass.kind === 'copy') {
      const invalid = accesses.find(
        (access) => access.usage !== 'copy-src' && access.usage !== 'copy-dst',
      );
      if (invalid !== undefined) {
        return err(
          new RenderGraphError({
            code: 'access-conflict',
            expected: `copy pass '${pass.name}' declares only copy-src/copy-dst accesses`,
            hint: 'move shader or attachment work into raster/compute passes',
            detail: { passName: pass.name, usage: invalid.usage },
          }),
        );
      }
    }
    return ok(undefined);
  }

  private validateAttachments(pass: PassRecord<FrameCtx>): Result<void, RenderGraphError> {
    if (pass.pass.kind !== 'raster') return ok(undefined);
    const accesses = pass.pass.descriptor.accesses;
    const has = (view: GraphTextureView, usage: GraphTextureAccess): boolean =>
      accesses.some((access) => access.resource === view && access.usage === usage);
    for (const attachment of pass.pass.descriptor.colorAttachments) {
      if (!has(attachment.view, 'color-attachment')) {
        return this.missingAttachmentAccess(pass.name, attachment.view, 'color-attachment');
      }
      if (
        attachment.resolveTarget !== undefined &&
        !has(attachment.resolveTarget, 'color-attachment')
      ) {
        return this.missingAttachmentAccess(
          pass.name,
          attachment.resolveTarget,
          'color-attachment',
        );
      }
    }
    const depth = pass.pass.descriptor.depthStencilAttachment;
    if (depth !== undefined) {
      const usage = depth.depthReadOnly === true ? 'depth-stencil-read' : 'depth-stencil-write';
      if (!has(depth.view, usage))
        return this.missingAttachmentAccess(pass.name, depth.view, usage);
    }
    return ok(undefined);
  }

  private missingAttachmentAccess(
    passName: string,
    view: GraphTextureView,
    usage: GraphTextureAccess,
  ): Result<never, RenderGraphError> {
    const data = handleData(view);
    const label = data?.kind === 'texture-view' ? this.views.get(data.id)?.label : undefined;
    return err(
      new RenderGraphError({
        code: 'resource-not-declared-by-pass',
        expected: `raster pass '${passName}' attachment '${label}' declares '${usage}' access`,
        hint: 'add the attachment view and matching usage to accesses',
        detail: { passName, resourceLabel: label, usage },
      }),
    );
  }

  private findPriorWrite(
    history: readonly NormalizedAccess[],
    current: NormalizedAccess,
  ): NormalizedAccess | undefined {
    for (let index = history.length - 1; index >= 0; index--) {
      const prior = history[index];
      if (
        prior !== undefined &&
        prior.resourceId === current.resourceId &&
        prior.write &&
        rangesOverlap(prior.range, current.range)
      ) {
        return prior;
      }
    }
    return undefined;
  }

  private findWriteDependencies(
    history: readonly NormalizedAccess[],
    current: NormalizedAccess,
  ): readonly number[] {
    const dependencies = new Set<number>();
    for (let index = history.length - 1; index >= 0; index--) {
      const prior = history[index];
      if (
        prior === undefined ||
        prior.resourceId !== current.resourceId ||
        !rangesOverlap(prior.range, current.range)
      ) {
        continue;
      }
      if (prior.read) dependencies.add(prior.passIndex);
      if (prior.write) {
        dependencies.add(prior.passIndex);
        break;
      }
    }
    return [...dependencies];
  }

  private validateDescriptors(
    surfaceSize: RenderGraphCompileOptions['surfaceSize'],
  ): Result<void, RenderGraphError> {
    if (surfaceSize.width <= 0 || surfaceSize.height <= 0) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'surfaceSize width and height are positive integers',
          hint: 'compile after the render surface has a non-zero physical extent',
          detail: {
            resourceLabel: 'surface',
            field: 'surfaceSize',
            expected: 'width > 0 and height > 0',
            actual: `${surfaceSize.width}x${surfaceSize.height}`,
          },
        }),
      );
    }
    for (const resource of this.resources.values()) {
      if (resource.kind === 'buffer' && resource.descriptor.size <= 0) {
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: `buffer '${resource.label}' size is greater than zero`,
            hint: 'derive a positive byte size before creating/importing the buffer',
            detail: {
              resourceLabel: resource.label,
              field: 'size',
              expected: 'size > 0',
              actual: resource.descriptor.size,
            },
          }),
        );
      }
      if (resource.kind === 'texture') {
        const extent = this.resolveExtent(resource.descriptor.size, surfaceSize);
        if (extent.width <= 0 || extent.height <= 0 || extent.depthOrArrayLayers <= 0) {
          return err(
            new RenderGraphError({
              code: 'resource-descriptor-invalid',
              expected: `texture '${resource.label}' extent is positive`,
              hint: 'repair the authored extent or compile surface size',
              detail: {
                resourceLabel: resource.label,
                field: 'size',
                expected: 'all extent axes > 0',
                actual: `${extent.width}x${extent.height}x${extent.depthOrArrayLayers}`,
              },
            }),
          );
        }
      }
    }
    return ok(undefined);
  }

  private allocate(
    options: RenderGraphCompileOptions,
    usageByResource: ReadonlyMap<number, number>,
    firstUseByResource: ReadonlyMap<number, number>,
    lastUseByResource: ReadonlyMap<number, number>,
  ): Result<
    {
      readonly resources: ReadonlyMap<number, CompiledResource<FrameCtx>>;
      readonly views: ReadonlyMap<number, CompiledView<FrameCtx>>;
    },
    RenderGraphError
  > {
    const compiledResources = new Map<number, CompiledResource<FrameCtx>>();
    const compiledViews = new Map<number, CompiledView<FrameCtx>>();
    const createdTextures: Texture[] = [];
    const createdBuffers: Buffer[] = [];
    const discard = (): void => {
      for (const texture of createdTextures) options.device.destroyTexture(texture);
      for (const buffer of createdBuffers) options.device.destroyBuffer(buffer);
    };

    for (const resource of this.resources.values()) {
      const usage = usageByResource.get(resource.id) ?? 0;
      let texture: Texture | undefined;
      let buffer: Buffer | undefined;
      if (resource.origin === 'created' && usage !== 0) {
        if (resource.kind === 'texture') {
          const extent = this.resolveExtent(resource.descriptor.size, options.surfaceSize);
          const created = options.device.createTexture({
            label: resource.label,
            size: extent,
            mipLevelCount: resource.descriptor.mipLevelCount ?? 1,
            sampleCount: resource.descriptor.sampleCount ?? 1,
            dimension: resource.descriptor.dimension ?? '2d',
            format: resource.descriptor.format,
            usage,
            viewFormats: [...(resource.descriptor.viewFormats ?? [])],
          });
          if (!created.ok) {
            discard();
            return err(
              new RenderGraphError({
                code: 'resource-allocation-failed',
                expected: `RHI creates graph texture '${resource.label}'`,
                hint: 'inspect detail.rhiCode and repair the descriptor/capability route',
                detail: { resourceKey: resource.label, rhiCode: created.error.code },
              }),
            );
          }
          texture = created.value;
          createdTextures.push(texture);
        } else {
          const created = options.device.createBuffer({
            label: resource.label,
            size: resource.descriptor.size,
            usage,
            mappedAtCreation: resource.descriptor.mappedAtCreation ?? false,
          });
          if (!created.ok) {
            discard();
            return err(
              new RenderGraphError({
                code: 'resource-allocation-failed',
                expected: `RHI creates graph buffer '${resource.label}'`,
                hint: 'inspect detail.rhiCode and repair the descriptor/capability route',
                detail: { resourceKey: resource.label, rhiCode: created.error.code },
              }),
            );
          }
          buffer = created.value;
          createdBuffers.push(buffer);
        }
      }
      compiledResources.set(resource.id, {
        record: resource,
        usage,
        firstUse: firstUseByResource.get(resource.id) ?? null,
        lastUse: lastUseByResource.get(resource.id) ?? null,
        ...(texture === undefined ? {} : { texture }),
        ...(buffer === undefined ? {} : { buffer }),
      });
    }

    for (const view of this.views.values()) {
      const resource = compiledResources.get(view.textureId);
      let physicalView: TextureView | undefined;
      if (resource?.record.origin === 'created' && resource.texture !== undefined) {
        const created = options.device.createTextureView(resource.texture, view.descriptor);
        if (!created.ok) {
          discard();
          return err(
            new RenderGraphError({
              code: 'resource-allocation-failed',
              expected: `RHI creates graph texture view '${view.label}'`,
              hint: 'inspect detail.rhiCode and repair the view descriptor',
              detail: { resourceKey: view.label, rhiCode: created.error.code },
            }),
          );
        }
        physicalView = created.value;
      }
      compiledViews.set(view.id, {
        record: view,
        ...(physicalView === undefined ? {} : { view: physicalView }),
      });
    }
    return ok({ resources: compiledResources, views: compiledViews });
  }

  private resolveExtent(
    extent: GraphExtent,
    surface: RenderGraphCompileOptions['surfaceSize'],
  ): { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number } {
    if (extent === 'surface') return { ...surface, depthOrArrayLayers: 1 };
    if (extent === 'half-surface') {
      return {
        width: Math.ceil(surface.width / 2),
        height: Math.ceil(surface.height / 2),
        depthOrArrayLayers: 1,
      };
    }
    return {
      width: extent.width,
      height: extent.height,
      depthOrArrayLayers: extent.depthOrArrayLayers ?? 1,
    };
  }

  private ensureWritable(): Result<void, RenderGraphError> {
    return this.sealed
      ? err(
          new RenderGraphError({
            code: 'builder-sealed',
            expected: 'a RenderGraphBuilder accepts declarations only before compile()',
            hint: 'create a new builder for a changed topology',
            detail: {},
          }),
        )
      : ok(undefined);
  }

  private reserveLabel(label: string): Result<void, RenderGraphError> {
    if (this.labels.has(label)) {
      return err(
        new RenderGraphError({
          code: 'duplicate-resource-label',
          expected: `resource label '${label}' is unique within one builder`,
          hint: `rename the second '${label}' declaration`,
          detail: { resourceLabel: label },
        }),
      );
    }
    this.labels.add(label);
    return ok(undefined);
  }

  private foreignHandleError(passName?: string): RenderGraphError {
    return new RenderGraphError({
      code: 'foreign-resource-handle',
      expected: 'every graph resource handle belongs to this builder',
      hint: 'create/import/view the resource on the same builder that declares the pass',
      detail: { ...(passName === undefined ? {} : { passName }) },
    });
  }
}
