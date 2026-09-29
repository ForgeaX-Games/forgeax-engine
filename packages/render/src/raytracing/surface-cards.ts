import {
  distanceFieldMeshDigest,
  type MeshCardLayout,
  type MeshCardProjection,
  meshCardSidednessDigest,
  validateMeshCardLayout,
} from '@forgeax/engine-geometry';
import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  admitRayMaterial,
  type RayMaterialError,
  rayMaterialContract,
} from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import { collectMaterialTextureCoordinates } from '../render-system-extract';
import { buildRaySurfaceScene, type RaySurfaceInstance } from './attributes';
import {
  captureViewProjection,
  type SurfaceViewProjection,
  transformCardProjection,
} from './capture-view';
import {
  createReferenceSurfaceMaterialBindings,
  type ResolveSurfaceTexture,
} from './material-bindings';
import type { RayPathMaterial } from './path-tracer';
import { type RayReferenceError, rayGeometryKey, rayReferenceFailure } from './scene';

export interface SurfaceCardSource {
  /** Whole geometry identity; material sections are draws within this instance. */
  readonly instance: Omit<RaySurfaceInstance, 'materialId'>;
  readonly layout: MeshCardLayout;
  /** Ordered, contiguous triangle ranges covering the whole index buffer. */
  readonly sections: readonly {
    readonly indexOffset: number;
    readonly indexCount: number;
    readonly material: RayPathMaterial;
    /** Producer revision for borrowed textures, required when this section uses them. */
    readonly textureContentKey?: string;
  }[];
}
export type SurfaceCardProjection = MeshCardProjection;
export const CARD_PLANES = [
  'albedoRoughness',
  'normals',
  'emissionMetallic',
  'f0Validity',
] as const;
export const CARD_TEXTURES = [...CARD_PLANES, 'depth'] as const;
export interface SurfaceCapture {
  readonly kind: 'cards' | 'view';
  readonly width: number;
  readonly bytes: number;
  readonly resolution: number;
  readonly height: number;
  readonly textures: Readonly<Record<(typeof CARD_TEXTURES)[number], Texture>>;
  readonly entries: readonly {
    readonly instanceId: number;
    readonly geometryKey: string;
    readonly captureKey: string;
    readonly projections: readonly SurfaceCardProjection[];
  }[];
  /** One coherent unlit capture: all material planes and depth share each raster work. */
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
export function surfaceCardKey(source: SurfaceCardSource): string {
  return JSON.stringify([
    rayGeometryKey(source.instance, source.layout.meshDigest),
    source.layout,
    source.instance.uvSets?.map((v) => Array.from(v)),
    source.instance.colors === undefined ? null : Array.from(source.instance.colors),
    source.instance.normals === undefined ? null : Array.from(source.instance.normals),
    source.instance.tangents === undefined ? null : Array.from(source.instance.tangents),
    source.sections.map((section) => [
      section.indexOffset,
      section.indexCount,
      section.material.id,
      section.material.program.contract,
      section.material.program.sourceClosureDigest,
      section.material.asset.values,
      section.textureContentKey,
    ]),
  ]);
}
export function packCardProjection(p: SurfaceCardProjection, winding = 1): Uint8Array {
  return new Uint8Array(
    new Float32Array([...p.origin, winding, ...p.u, p.width, ...p.v, p.height, ...p.n, p.depth])
      .buffer,
  );
}

/** Frozen real-mesh raster capture. The caller owns submit/completion and borrowed textures. */
export async function createSurfaceCapture(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  sources: readonly SurfaceCardSource[],
  request:
    | { readonly kind: 'cards'; readonly resolution: number }
    | {
        readonly kind: 'view';
        readonly resolution: number;
        readonly projection: SurfaceViewProjection;
      } = { kind: 'cards', resolution: 16 },
  resolveTexture?: ResolveSurfaceTexture,
): Promise<Result<SurfaceCapture, RayReferenceError | RayMaterialError | RhiError>> {
  const { resolution } = request;
  if (request.kind === 'view') {
    const projection = captureViewProjection(request.projection);
    if (!projection.ok) return projection;
  }
  if (
    !Number.isInteger(resolution) ||
    resolution < 8 ||
    resolution > 512 ||
    sources.length < 1 ||
    sources.length > 1024
  )
    return rayReferenceFailure('capture requires 1..1024 instances and 8..512 pixels', true);
  if (!device.caps.rgba16floatRenderable || device.caps.maxColorAttachments < 4)
    return rayReferenceFailure('card capture requires four rgba16float attachments');
  if (new Set(sources.map((s) => s.instance.instanceId)).size !== sources.length)
    return rayReferenceFailure('duplicate card instance');
  for (const source of sources) {
    const valid = validateMeshCardLayout(source.layout);
    if (!valid.ok) return rayReferenceFailure('invalid cooked card layout');
  }
  const cardCount = sources.reduce((sum, source) => sum + source.layout.cards.length, 0);
  if (cardCount > 4096) return rayReferenceFailure('capture exceeds 4096 card budget', true);
  const workCount = sources.reduce(
    (sum, source) =>
      sum + source.sections.length * (request.kind === 'cards' ? source.layout.cards.length : 1),
    0,
  );
  if (workCount > 65_536)
    return rayReferenceFailure('capture exceeds 65536 material-card draw budget', true);
  const columns = request.kind === 'cards' ? Math.max(1, Math.ceil(Math.sqrt(cardCount))) : 1;
  const width = resolution * columns;
  const height =
    resolution * (request.kind === 'cards' ? Math.max(1, Math.ceil(cardCount / columns)) : 1);
  if (width > 8192 || height > 8192 || width * height * 36 > 256 * 1024 * 1024)
    return rayReferenceFailure('capture exceeds texture extent or 256 MiB attachment budget', true);
  let allocatedBytes = 0;
  const ownedBuffers: Buffer[] = [],
    ownedTextures: Texture[] = [];
  const dispose = () => {
    for (const b of ownedBuffers) device.destroyBuffer(b);
    for (const t of ownedTextures) device.destroyTexture(t);
    ownedBuffers.length = 0;
    ownedTextures.length = 0;
  };
  const fail = <E>(r: Result<never, E>) => {
    dispose();
    return r;
  };
  const make = (label: string, bytes: Uint8Array, uniform = false) => {
    const b = device.createBuffer({
      label,
      size: bytes.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!b.ok) return b;
    ownedBuffers.push(b.value);
    allocatedBytes += bytes.byteLength;
    const write = device.queue.writeBuffer(b.value, 0, bytes);
    return write.ok ? b : write;
  };
  allocatedBytes += width * height * 36;
  const textures = {} as Record<(typeof CARD_TEXTURES)[number], Texture>;
  const views: TextureView[] = [];
  for (const name of CARD_PLANES) {
    const texture = device.createTexture({
      label: `cards.${name}`,
      size: { width, height },
      format: 'rgba16float',
      textureBindingViewDimension: '2d',
      usage: 21,
    });
    if (!texture.ok) return fail(texture);
    ownedTextures.push(texture.value);
    textures[name] = texture.value;
    const view = device.createTextureView(texture.value, {});
    if (!view.ok) return fail(view);
    views.push(view.value);
  }
  const depth = device.createTexture({
    label: 'cards.depth',
    size: { width, height },
    format: 'depth32float',
    textureBindingViewDimension: '2d',
    usage: 21,
  });
  if (!depth.ok) return fail(depth);
  ownedTextures.push(depth.value);
  textures.depth = depth.value;
  const depthView = device.createTextureView(depth.value, {});
  if (!depthView.ok) return fail(depthView);
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 3, buffer: { type: 'uniform' } },
    ],
  });
  if (!layout.ok) return fail(layout);
  const entries: SurfaceCapture['entries'][number][] = [];
  const draws: {
    pipeline: import('@forgeax/engine-rhi').RenderPipeline;
    material: import('@forgeax/engine-rhi').BindGroup;
    cards: import('@forgeax/engine-rhi').BindGroup[];
    vertices: number;
    firstTile: number;
  }[] = [];
  let firstTile = 0;
  for (const source of sources) {
    const { instance, layout: cardLayout } = source;
    if (
      (await distanceFieldMeshDigest(instance.positions, instance.indices)) !==
      cardLayout.meshDigest
    )
      return fail(rayReferenceFailure('card source geometry differs from its cooked layout'));
    if (source.sections.length < 1 || source.sections.length > 1024)
      return fail(rayReferenceFailure('capture requires 1..1024 material sections per mesh', true));
    const sidedness = new Uint8Array(instance.indices.length / 3);
    let indexEnd = 0;
    for (const section of source.sections) {
      if (
        section.indexOffset !== indexEnd ||
        !Number.isSafeInteger(section.indexCount) ||
        section.indexCount < 3 ||
        section.indexCount % 3 !== 0 ||
        section.indexOffset + section.indexCount > instance.indices.length
      )
        return fail(
          rayReferenceFailure(
            'card sections must cover contiguous non-overlapping triangle ranges',
          ),
        );
      indexEnd += section.indexCount;
      const forward = section.material.asset.passes?.find(
        (p) => p.name.toLowerCase() === 'forward',
      );
      const cull = forward?.renderState?.cullMode ?? 'back';
      if (cull !== 'back' && cull !== 'none')
        return fail(rayReferenceFailure('card sections require back or none culling'));
      sidedness.fill(cull === 'none' ? 1 : 0, section.indexOffset / 3, indexEnd / 3);
    }
    if (indexEnd !== instance.indices.length)
      return fail(rayReferenceFailure('card sections must cover the whole mesh'));
    if (cardLayout.sidednessDigest !== (await meshCardSidednessDigest(sidedness)))
      return fail(rayReferenceFailure('card layout sidedness must match every material section'));
    const cardProjections: SurfaceCardProjection[] = [];
    if (request.kind === 'cards')
      for (const local of cardLayout.cards) {
        const transformed = transformCardProjection(local, instance.transform);
        if (!transformed.ok) return fail(transformed);
        cardProjections.push(transformed.value);
      }
    const cards = request.kind === 'cards' ? cardProjections : [request.projection];
    const projectionBuffers: Buffer[] = [];
    for (const card of cards) {
      const projection = captureViewProjection(card);
      if (!projection.ok) return fail(projection);
      const bytes = new Float32Array(24);
      bytes.set(projection.value.matrix);
      bytes.set(projection.value.eye, 16);
      new Uint32Array(bytes.buffer)[20] = request.kind === 'cards' ? 1 : 0;
      const buffer = make('cards.projection', new Uint8Array(bytes.buffer), true);
      if (!buffer.ok) return fail(buffer);
      projectionBuffers.push(buffer.value);
    }
    for (const section of source.sections) {
      const { material } = section;
      if (
        material.program.context !== 'card-capture' ||
        material.program.contract !== rayMaterialContract(material.asset)
      )
        return fail(rayReferenceFailure('card material identity/context is stale or mismatched'));
      const admitted = admitRayMaterial(material.asset, String(material.id));
      if (!admitted.ok) return fail(admitted);
      const coordinates = collectMaterialTextureCoordinates(material.asset.values ?? {});
      const textures = material.program.paramSchema.filter((p) => p.type === 'texture2d');
      if (textures.length > 0 && !section.textureContentKey)
        return fail(rayReferenceFailure('textured cards require a producer textureContentKey'));
      for (const entry of textures) {
        if (
          entry.name === 'normalTexture' &&
          (instance.normals === undefined || instance.tangents === undefined)
        )
          return fail(
            rayReferenceFailure(
              `instance ${instance.instanceId} normal texture requires authored normals and tangents`,
            ),
          );
        const set = coordinates.get(entry.name)?.set ?? 0;
        if (set >= (instance.uvSets?.length ?? 0))
          return fail(
            rayReferenceFailure(
              `instance ${instance.instanceId} is missing material UV set ${set}`,
            ),
          );
      }
      const cullMode =
        material.asset.passes?.find((p) => p.name.toLowerCase() === 'forward')?.renderState
          ?.cullMode ?? 'back';
      if (cullMode !== 'back' && cullMode !== 'none')
        return fail(rayReferenceFailure('invalid card culling'));
      const scene = buildRaySurfaceScene([
        {
          ...instance,
          materialId: material.id,
          indices: Array.from(
            { length: section.indexCount },
            (_, i) => instance.indices[section.indexOffset + i] ?? NaN,
          ),
        },
      ]);
      if (!scene.ok) return fail(scene);
      const value = scene.value;
      const triangles = make('cards.triangles', value.triangles),
        attributes = make('cards.attributes', value.attributes);
      if (!triangles.ok) return fail(triangles);
      if (!attributes.ok) return fail(attributes);
      const bindings = createReferenceSurfaceMaterialBindings(device, material, 2, resolveTexture);
      if (!bindings.ok) return fail(bindings);
      ownedBuffers.push(bindings.value.uniform);
      allocatedBytes += bindings.value.bytes;
      const module = await compile(device, {
        code: material.program.wgsl,
        label: 'cards.material',
      });
      if (!module.ok) return fail(module);
      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [layout.value, bindings.value.layout],
      });
      if (!pipelineLayout.ok) return fail(pipelineLayout);
      const winding = new DataView(value.attributes.buffer).getFloat32(108, true);
      const pipeline = device.createRenderPipeline({
        label: `cards.capture.instance-${instance.instanceId}.indices-${section.indexOffset}-${section.indexCount}.material-${material.id}`,
        layout: pipelineLayout.value,
        vertex: { module: module.value, entryPoint: 'vs_card', buffers: [] },
        fragment: {
          module: module.value,
          entryPoint: 'fs_card',
          targets: CARD_PLANES.map(() => ({ format: 'rgba16float' as const })),
        },
        primitive: {
          topology: 'triangle-list',
          cullMode,
          frontFace: winding < 0 ? 'cw' : 'ccw',
        },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      });
      if (!pipeline.ok) return fail(pipeline);
      const groups = [];
      for (const buffer of projectionBuffers) {
        const group = device.createBindGroup({
          layout: layout.value,
          entries: [triangles.value, attributes.value, buffer].map((b, binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value: { buffer: b } },
          })),
        });
        if (!group.ok) return fail(group);
        groups.push(group.value);
      }
      draws.push({
        pipeline: pipeline.value,
        material: bindings.value.group,
        cards: groups,
        vertices: value.triangleCount * 3,
        firstTile,
      });
    }
    entries.push({
      instanceId: instance.instanceId,
      geometryKey: rayGeometryKey(instance, cardLayout.meshDigest),
      captureKey: surfaceCardKey(source),
      projections: cardProjections,
    });
    firstTile += cardProjections.length;
  }
  let disposed = false;
  return ok({
    kind: request.kind,
    bytes: allocatedBytes,
    width,
    resolution,
    height,
    textures,
    entries,
    record(encoder) {
      if (disposed) return rayReferenceFailure('surface cards are disposed');
      const pass = encoder.beginRenderPass({
        label: 'cards.capture',
        colorAttachments: views.map((view) => ({
          view,
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        })),
        depthStencilAttachment: {
          view: depthView.value,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      draws.forEach((draw) => {
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(1, draw.material);
        draw.cards.forEach((group, cardIndex) => {
          const tile = draw.firstTile + cardIndex;
          const column = tile % columns,
            row = Math.floor(tile / columns);
          pass.setViewport(
            column * resolution,
            (request.kind === 'cards' ? row : 0) * resolution,
            resolution,
            resolution,
            0,
            1,
          );
          pass.setScissorRect(
            column * resolution,
            (request.kind === 'cards' ? row : 0) * resolution,
            resolution,
            resolution,
          );
          pass.setBindGroup(0, group);
          pass.draw(draw.vertices);
        });
      });
      pass.end();
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        dispose();
      }
    },
  });
}
