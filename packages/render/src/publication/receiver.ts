import type { AssetReader } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type Asset, AssetError, err, type Handle, ok, type Result } from '@forgeax/engine-types';
import { WORLD_CAPSULE_STRIDE } from '../capsule-shadow/world-capsules';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { RenderSceneOperation } from '../scene/render-scene-types';
import { isCanvasTextureSource } from '../textures/canvas-texture';
import { CanvasFrameReceiver } from './canvas';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
} from './contract';
import { publicationDependencies, publicationFrameDependencies } from './dependencies';
import type { PublishedRenderResources } from './resource-scope';
import { RenderPublicationTargetReceiver, type RenderTargetAuthoring } from './targets';

export interface PreparedRenderPublication {
  readonly resources: PublishedRenderResources;
  readonly packet: RenderPublication;
  readonly operations: readonly RenderSceneOperation[];
  readonly frame: ExtractedFrame;
  readonly onFeatureSourceSubmitted?: (identity: string, feedback: unknown) => void;
}

/** Assets live for this source session; the Renderer owns all retained scene/GPU state. */
export class RenderPublicationReceiver {
  private revision = 0;
  private readonly canvases = new CanvasFrameReceiver();
  private videoFrames = new Map<string, VideoFrame>();
  private readonly entities = new Map<
    number,
    {
      readonly snapshot: RenderableSnapshot;
      readonly dispatch: readonly DispatchEntry[];
    }
  >();
  private readonly targets: RenderPublicationTargetReceiver | undefined;
  private readonly assets = new Map<Handle<string, 'shared'>, Asset>();
  private readonly resources: PublishedRenderResources;
  private readonly guidHandles = new Map<string, Handle<string, 'shared'>>();

  constructor(
    private readonly identity: RenderPublicationIdentity,
    targets?: RenderTargetAuthoring,
  ) {
    this.targets = targets === undefined ? undefined : new RenderPublicationTargetReceiver(targets);
    const resolveAsset: AssetReader['resolveAsset'] = <T extends Asset>(
      handle: Handle<string, 'shared'>,
    ) => {
      const value = this.assets.get(handle);
      return value === undefined
        ? err(
            new AssetError({
              code: 'asset-not-found',
              expected: 'the accepted publication contains the referenced asset generation',
              hint: 'publish the asset closure before drawing its consumer',
            }),
          )
        : ok(value as T);
    };
    this.resources = {
      identity: `${identity.source}:${identity.epoch}`,
      time: { delta: 0, elapsed: 0, maxDeltaSeconds: 0 },
      transparentSort: { mode: 0, yzAlpha: 1 },
      resolveAsset,
      canvasFrame: (id) => this.canvases.get(id),
      videoFrame: (entity, clip) => this.videoFrames.get(`${entity}:${clip}`),
      handleForGuid: (guid) => this.guidHandles.get(guid.toLowerCase()),
      lookupAsset: <T extends Asset>(guid: string): T | undefined => {
        const handle = this.guidHandles.get(guid.toLowerCase());
        return handle === undefined ? undefined : (this.assets.get(handle) as T | undefined);
      },
    };
  }

  accept(packet: RenderPublication): Result<PreparedRenderPublication, RenderPublicationError> {
    const reject = (reason: RenderPublicationError['detail']['reason'], subject: string) =>
      err(new RenderPublicationError({ reason, subject }));
    if (packet.source !== this.identity.source || packet.epoch !== this.identity.epoch)
      return reject('identity', 'source/epoch');
    if (packet.base !== this.revision || packet.baseline !== (this.revision === 0))
      return reject('base', 'accepted revision');
    if (!Number.isSafeInteger(packet.revision) || packet.revision !== this.revision + 1)
      return reject('revision', 'next revision');
    if (
      !(packet.upserts instanceof Uint32Array) ||
      packet.upserts.length % 2 !== 0 ||
      !(packet.removed instanceof Uint32Array) ||
      !(packet.transformEntities instanceof Uint32Array) ||
      !(packet.transforms instanceof Float32Array) ||
      packet.transforms.length !== packet.transformEntities.length * 16 ||
      !packet.transforms.every(Number.isFinite) ||
      !Number.isFinite(packet.sampleTimeSeconds)
    )
      return reject('shape', 'numeric columns');
    if (
      !Array.isArray(packet.videoFrames) ||
      !Array.isArray(packet.targets) ||
      !Array.isArray(packet.targetSources) ||
      !Array.isArray(packet.features) ||
      !Array.isArray(packet.templates) ||
      !Array.isArray(packet.programs) ||
      !Array.isArray(packet.assets) ||
      !Array.isArray(packet.retiredAssets) ||
      !Array.isArray(packet.invalidatedAssets) ||
      packet.metadata === null ||
      typeof packet.metadata !== 'object' ||
      !Array.isArray(packet.metadata.cameras) ||
      !Number.isFinite(packet.time?.elapsed) ||
      !Number.isFinite(packet.time?.delta)
    )
      return reject('shape', 'frame metadata');
    if (packet.canvasFrames !== undefined && !Array.isArray(packet.canvasFrames))
      return reject('shape', 'canvas frames');
    const canvasIds = new Set<number>();
    for (const row of packet.canvasFrames ?? []) {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        canvasIds.has(row.id) ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        typeof row.disposed !== 'boolean' ||
        (row.disposed && row.frame !== undefined) ||
        (row.frame !== undefined &&
          (typeof VideoFrame === 'undefined' ||
            !(row.frame instanceof VideoFrame) ||
            row.frame.displayWidth <= 0 ||
            row.frame.displayHeight <= 0))
      )
        return reject('shape', 'canvas frame');
      canvasIds.add(row.id);
    }
    const videoKeys = new Set<string>();
    for (const row of packet.videoFrames) {
      const key = `${row.entity}:${row.clip}`;
      if (
        !Number.isSafeInteger(row.entity) ||
        !Number.isSafeInteger(row.clip) ||
        typeof VideoFrame === 'undefined' ||
        !(row.frame instanceof VideoFrame) ||
        row.frame.displayWidth <= 0 ||
        row.frame.displayHeight <= 0 ||
        videoKeys.has(key)
      )
        return reject('shape', 'video frame');
      videoKeys.add(key);
    }
    const targetIds = new Set<number>();
    const targetTokens = new Set<object>();
    for (const row of packet.targets) {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        targetIds.has(row.id) ||
        typeof row.token !== 'object' ||
        row.token === null ||
        targetTokens.has(row.token) ||
        typeof row.descriptor !== 'object' ||
        row.descriptor === null
      )
        return reject('shape', 'target identity/descriptor');
      targetIds.add(row.id);
      targetTokens.add(row.token);
    }
    for (const camera of [
      ...packet.metadata.cameras,
      ...packet.metadata.auxiliaryCameras,
      ...packet.metadata.cubeCameras,
    ])
      if (camera.target !== undefined && !targetTokens.has(camera.target))
        return reject('shape', 'missing target descriptor');
    const cameraWriters = [
      ...packet.metadata.cameras,
      ...packet.metadata.auxiliaryCameras,
      ...packet.metadata.cubeCameras,
    ];
    const planarTargets = new Set(
      packet.metadata.auxiliaryCameras
        .filter((camera) => camera.planarReflection !== undefined)
        .map((camera) => camera.target),
    );
    for (const target of planarTargets) {
      if (
        target === undefined ||
        cameraWriters.filter((camera) => camera.target === target).length !== 1
      )
        return reject('shape', 'duplicate planar target writer');
    }
    const sourceTokens = new Set<object>();
    for (const row of packet.targetSources) {
      if (
        !targetTokens.has(row.target) ||
        typeof row.token !== 'object' ||
        row.token === null ||
        sourceTokens.has(row.token)
      )
        return reject('shape', 'target source');
      sourceTokens.add(row.token);
    }
    const featureIdentities = new Set<string>();
    for (const row of packet.features) {
      if (typeof row.identity !== 'string' || featureIdentities.has(row.identity))
        return reject('shape', 'feature identity');
      featureIdentities.add(row.identity);
    }
    const matrices = new Map<number, Float32Array>();
    for (let i = 0; i < packet.transformEntities.length; i++) {
      const entity = packet.transformEntities[i] as number;
      if (matrices.has(entity)) return reject('shape', 'duplicate transform identity');
      matrices.set(entity, packet.transforms.slice(i * 16, i * 16 + 16));
    }
    const operations: RenderSceneOperation[] = [];
    const renderables: RenderableSnapshot[] = [];
    const dispatch: DispatchEntry[] = [];
    const updated = new Set<number>();
    for (let i = 0; i < packet.upserts.length; i += 2) {
      const entityKey = packet.upserts[i] as number;
      const template = packet.templates[packet.upserts[i + 1] as number];
      const world = matrices.get(entityKey);
      if (template === undefined || world === undefined || updated.has(entityKey))
        return reject('shape', 'upsert template/transform');
      if (!Array.isArray(template.snapshot?.materials) || !Array.isArray(template.dispatch))
        return reject('shape', 'template');
      for (const material of template.snapshot.materials)
        for (const source of material.textureSources?.values() ?? [])
          if (
            isCanvasTextureSource(source)
              ? !canvasIds.has(source.canvasTextureId)
              : !sourceTokens.has(source)
          )
            return reject('shape', 'missing material texture source');
      if (template.snapshot.skin !== undefined) return reject('shape', 'source GPU skin receipt');
      const pose = template.snapshot.skinPose;
      if (
        pose !== undefined &&
        (!Number.isInteger(pose.jointCount) ||
          pose.jointCount <= 0 ||
          pose.inverseBindMatrices.length !== pose.jointCount ||
          pose.jointWorlds.length !== pose.jointCount ||
          [...pose.inverseBindMatrices, ...pose.jointWorlds].some(
            (matrix) =>
              !(matrix instanceof Float32Array) ||
              matrix.length !== 16 ||
              !matrix.every(Number.isFinite),
          ))
      )
        return reject('shape', 'skin pose');
      const capsuleShadow = template.snapshot.capsuleShadow;
      if (
        capsuleShadow?.status === 'ready' &&
        (!(capsuleShadow.capsules instanceof Float32Array) ||
          capsuleShadow.capsules.length % WORLD_CAPSULE_STRIDE !== 0 ||
          !capsuleShadow.capsules.every(Number.isFinite))
      )
        return reject('shape', 'capsule shadow');
      updated.add(entityKey);
      const snapshot: RenderableSnapshot = {
        ...template.snapshot,
        worldId: 0,
        entityKey,
        transform: { world },
      };
      for (const item of template.dispatch)
        dispatch.push({ ...item, entityIndex: entityKey, renderableIndex: renderables.length });
      renderables.push(snapshot);
      operations.push({ kind: 'update', worldId: 0, entityKey, snapshot });
    }
    const removed = new Set<number>();
    for (const entityKey of packet.removed) {
      if (!this.entities.has(entityKey) || updated.has(entityKey) || removed.has(entityKey))
        return reject('shape', 'duplicate removal');
      removed.add(entityKey);
      operations.push({ kind: 'remove', worldId: 0, entityKey });
    }
    for (const [entityKey, world] of matrices) {
      if (removed.has(entityKey)) return reject('shape', 'removed transform');
      if (!updated.has(entityKey) && !this.entities.has(entityKey))
        return reject('shape', 'unknown transform identity');
      if (!updated.has(entityKey))
        operations.push({ kind: 'update', worldId: 0, entityKey, world });
    }
    // Validate the complete packet before changing the accepted asset namespace.
    const assetHandles = new Set<number>();
    for (const row of packet.assets) {
      if (
        row.value === null ||
        typeof row.value !== 'object' ||
        !Number.isSafeInteger(row.handle) ||
        assetHandles.has(row.handle) ||
        packet.retiredAssets.includes(row.handle)
      )
        return reject('shape', 'asset payload');
      assetHandles.add(row.handle);
    }
    for (const handles of [
      publicationFrameDependencies(packet.metadata),
      ...renderables.map(publicationDependencies),
    ]) {
      if (
        handles.some(
          (handle) =>
            !assetHandles.has(handle) &&
            (!this.assets.has(handle as Handle<string, 'shared'>) ||
              packet.retiredAssets.includes(handle as Handle<string, 'shared'>)),
        )
      )
        return reject('shape', 'missing asset dependency');
    }
    const guidHandles = new Map(this.guidHandles);
    for (const [guid, handle] of guidHandles)
      if (packet.retiredAssets.includes(handle)) guidHandles.delete(guid);
    for (const row of packet.assets)
      if (row.guid !== undefined) guidHandles.set(row.guid.toLowerCase(), row.handle);
    for (const row of renderables)
      if (row.lods?.some((lod) => !guidHandles.has(AssetGuid.format(lod.mesh).toLowerCase())))
        return reject('shape', 'missing LOD dependency');
    if (packet.baseline) this.assets.clear();
    this.guidHandles.clear();
    for (const [guid, handle] of guidHandles) this.guidHandles.set(guid, handle);
    for (const handle of packet.retiredAssets) this.assets.delete(handle);
    for (const row of packet.assets) this.assets.set(row.handle, row.value);
    Object.assign(this.resources, { time: packet.time, transparentSort: packet.transparentSort });
    this.releaseVideoFrames();
    this.videoFrames = new Map(
      packet.videoFrames.map((row) => [`${row.entity}:${row.clip}`, row.frame]),
    );
    this.canvases.accept(packet.canvasFrames ?? []);
    this.revision = packet.revision;
    let prepared: PreparedRenderPublication = {
      resources: this.resources,
      packet,
      operations,
      frame: {
        ...packet.metadata,
        renderables,
        dispatch,
        visibilitySnapshots: [],
        featureVisibilitySnapshots: [],
        hiddenEntityReports: [],
        shadowCasterEntityKeys: new Set(),
        shadowCasterDrawKeys: new Set(),
      },
    };
    prepared = this.targets?.apply(prepared) ?? prepared;
    for (const entity of removed) this.entities.delete(entity);
    const dispatchByEntity = new Map<number, DispatchEntry[]>();
    for (const item of prepared.frame.dispatch) {
      const entity = prepared.frame.renderables[item.renderableIndex]?.entityKey;
      if (entity === undefined) continue;
      const entries = dispatchByEntity.get(entity) ?? [];
      entries.push(item);
      dispatchByEntity.set(entity, entries);
    }
    for (const snapshot of prepared.frame.renderables)
      this.entities.set(snapshot.entityKey, {
        snapshot,
        dispatch: dispatchByEntity.get(snapshot.entityKey) ?? [],
      });
    for (const [entity, world] of matrices) {
      const row = this.entities.get(entity);
      if (!updated.has(entity) && row !== undefined)
        this.entities.set(entity, {
          ...row,
          snapshot: {
            ...row.snapshot,
            transform: { ...row.snapshot.transform, world },
          },
        });
    }
    return ok(prepared);
  }

  /** A new view starts at the accepted scene, including changes made while no view rendered. */
  snapshot(input: PreparedRenderPublication): PreparedRenderPublication {
    const renderables: RenderableSnapshot[] = [];
    const dispatch: DispatchEntry[] = [];
    for (const row of this.entities.values()) {
      for (const item of row.dispatch)
        dispatch.push({ ...item, renderableIndex: renderables.length });
      renderables.push(row.snapshot);
    }
    return {
      ...input,
      packet: { ...input.packet, baseline: true },
      frame: { ...input.frame, renderables, dispatch },
      operations: renderables.map((snapshot) => ({
        kind: 'update',
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    };
  }

  /** copyExternalImageToTexture consumes native sources synchronously during draw. */
  releaseVideoFrames(): void {
    this.canvases.releaseFrames();
    for (const frame of this.videoFrames.values()) frame.close();
    this.videoFrames.clear();
  }

  dispose(): void {
    this.canvases.dispose();
    this.releaseVideoFrames();
    this.assets.clear();
    this.guidHandles.clear();
    this.entities.clear();
  }

  get acceptedRevision(): number {
    return this.revision;
  }
}
