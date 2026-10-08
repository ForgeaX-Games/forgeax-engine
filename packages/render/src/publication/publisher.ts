import {
  type AssetRegistry,
  RuntimeMaterialValue,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { type EntityHandle, Time, type World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { ChildOf, Children, GlobalTransform } from '@forgeax/engine-scene';
import { type Asset, err, type Handle, ok, type Result } from '@forgeax/engine-types';
import { Visibility } from '../components';
import { stereoEyeCameras } from '../components/stereo-camera';
import { renderMaterialContext } from '../extract/material-context';
import type { RenderFeature } from '../features/types';
import { renderFeatureCameraView } from '../features/view';
import {
  internSharedRefFromGuid,
  type MaterialSnapshot,
  type MaterialSnapshotCachesByWorld,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  isRenderableMember,
  RENDERABLE_SOURCE_COMPONENTS,
} from '../scene/render-source';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { getTransparentSortConfig } from '../systems/transparent-sort-config';
import { renderTargetMaterialSourceIdentity } from '../targets/material-source';
import { type CanvasTextureSource, isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { type PublishedCanvasFrame, publicationCanvasFrames } from './canvas';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationTemplate,
} from './contract';
import { publicationDependencies, publicationFrameDependencies } from './dependencies';
import { publicationTargetSources, type RenderPublicationTargetOwner } from './targets';
import { publicationVideoFrames } from './video';

export interface RenderPublicationCandidate {
  readonly packet: RenderPublication;
  /** Call synchronously after successful postMessage; never wait for remote ACK. */
  accept(): void;
  discard(): void;
}

/** Source indices and asset dependencies only; the receiver owns the RenderScene. */
export function createRenderPublisher(
  world: World,
  assets: AssetRegistry,
  identity: RenderPublicationIdentity,
  capabilities?: RhiCaps,
  features: readonly RenderFeature<unknown>[] = [],
  targetOwner?: RenderPublicationTargetOwner,
  limits?: Readonly<Record<string, number>>,
) {
  const pendingMeshContent = new Set<Handle<string, 'shared'>>();
  const releaseTransforms = registerRenderSourceSystems(world, assets, {
    updateMesh: (handle) => pendingMeshContent.add(handle),
  });
  const source = createRenderSourceState(world);
  const transforms = createGlobalTransformChangeQuery(world);
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  const members = new Set<number>();
  const publishedPrograms = new Set<string>();
  const dependencies = new Map<number, readonly Handle<string, 'shared'>[]>();
  const consumers = new Map<Handle<string, 'shared'>, Set<number>>();
  const pending = new Set<number>();
  let canvasConsumers = new Map<number, readonly CanvasTextureSource[]>();
  let videoConsumers = new Map<number, readonly number[]>();
  // Two slots: the consuming frame and one sealed successor.
  const flights = new Map<
    number,
    {
      features: RenderPublication['features'];
      owners: readonly RenderFeature<unknown>[];
      submitted: boolean;
    }
  >();
  const jointsByEntity = new Map<number, readonly number[]>();
  const skinConsumers = new Map<number, Set<number>>();
  let frameDependencies = new Set<Handle<string, 'shared'>>();
  let catalogEpoch = -1,
    revision = 0,
    disposed = false,
    active = false;
  let lastScannedRows = 0,
    allocations = 0;
  let storage = [new ArrayBuffer(0), new ArrayBuffer(0), new ArrayBuffer(0), new ArrayBuffer(0)];
  const spareStorage: ArrayBuffer[][] = [];
  const buffer = (index: number, bytes: number): ArrayBuffer => {
    let value = storage[index] as ArrayBuffer;
    if (value.byteLength < bytes) {
      let capacity = Math.max(16, value.byteLength);
      while (capacity < bytes) capacity *= 2;
      value = new ArrayBuffer(capacity);
      storage[index] = value;
      allocations++;
    }
    return value;
  };

  const fail = (reason: RenderPublicationError['detail']['reason'], subject: string) =>
    err(new RenderPublicationError({ reason, subject }));

  return {
    identity,
    inspect: () => ({
      revision,
      members: members.size,
      assetCount: consumers.size,
      scannedRows: lastScannedRows,
      inFlight: flights.size > 0,
      inFlightCount: flights.size,
      allocations,
    }),
    prepare(
      sampleTimeSeconds: number,
      temporalReset = false,
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      if (disposed) return fail('disposed', 'publisher');
      if (active || flights.size === 2)
        return fail('in-flight', 'both publication slots are occupied');
      const baseline = revision === 0;
      const featureSources = [...features];
      const batch = source.projection.read();
      lastScannedRows = batch.scannedRows;
      const changed = new Set(pending),
        removed = new Set<number>();
      const invalidated = new Set<Handle<string, 'shared'>>(pendingMeshContent);
      const runtimeChanged =
        batch.membershipChanged ||
        batch.changedComponents.includes(RuntimeMaterialValue) ||
        batch.changedComponents.includes(RuntimeMeshVertices);
      for (const index of batch.indices) {
        const previous = source.entities.get(index),
          current = source.projection.entity(index);
        if (
          previous !== undefined &&
          members.has(previous) &&
          (current !== previous || !isRenderableMember(world, previous))
        )
          removed.add(previous);
        if (runtimeChanged) {
          for (const handle of source.contentHandles.get(index) ?? [])
            invalidated.add(handle as Handle<string, 'shared'>);
          if (current !== undefined) {
            if (world.hasComponent(current, RuntimeMaterialValue))
              invalidated.add(world.get(current, RuntimeMaterialValue).unwrap().asset);
            if (world.hasComponent(current, RuntimeMeshVertices))
              invalidated.add(world.get(current, RuntimeMeshVertices).unwrap().asset);
          }
        }
        if (previous !== undefined)
          for (const consumer of skinConsumers.get(previous) ?? []) changed.add(consumer);
        if (current === undefined) continue;
        if (
          isRenderableMember(world, current) &&
          (baseline ||
            !members.has(current) ||
            RENDERABLE_SOURCE_COMPONENTS.some((component) =>
              source.projection.changed(current, component),
            ))
        )
          changed.add(current);
        if (
          batch.membershipChanged ||
          source.projection.changed(current, ChildOf) ||
          source.projection.changed(current, Visibility)
        ) {
          const queue = [current],
            visited = new Set<number>();
          while (queue.length) {
            const entity = queue.pop() as EntityHandle;
            if (visited.has(entity)) continue;
            visited.add(entity);
            if (isRenderableMember(world, entity)) changed.add(entity);
            if (world.hasComponent(entity, Children))
              queue.push(
                ...Array.from(
                  world.get(entity, Children).unwrap().entities,
                  (child) => child as EntityHandle,
                ),
              );
          }
        }
      }
      if (baseline || catalogEpoch !== assets.catalogEpoch) {
        for (const entity of members) changed.add(entity);
        for (const entity of source.entities.values())
          if (isRenderableMember(world, entity)) changed.add(entity);
      }
      for (const handle of invalidated)
        for (const entity of consumers.get(handle) ?? []) changed.add(entity);
      const matrixRows = new Map<number, Float32Array>();
      for (const span of transforms.spans().unwrap()) {
        const values = span.get(GlobalTransform).world;
        for (let row = 0; row < span.entities.length; row++) {
          const entity = span.entities[row] as EntityHandle;
          for (const consumer of skinConsumers.get(entity) ?? []) changed.add(consumer);
          if (members.has(entity) && !removed.has(entity)) {
            matrixRows.set(entity, values.subarray(row * 16, row * 16 + 16));
            pending.add(entity);
          }
        }
      }
      for (const entity of changed) pending.add(entity);
      let canvasFrames: readonly PublishedCanvasFrame[] = [];
      let videoFrames: RenderPublication['videoFrames'] = [];
      try {
        const frame = extractFrames(
          [world],
          { cameraOwner: 0, resourceOwner: 0 },
          assets,
          undefined,
          caches,
          {
            ...(capabilities === undefined ? {} : renderMaterialContext(capabilities, limits)),
            cull: 'none',
            retainHidden: true,
            renderables: changed.size ? { kind: 'partial', entitiesByWorld: [changed] } : 'none',
          },
        );
        const templates: RenderPublicationTemplate[] = [],
          templateIds = new Map<string, number>();
        const upserts: number[] = [];
        const programs = new Map<string, RenderPublication['programs'][number]>();
        const nextDependencies = new Map<number, readonly Handle<string, 'shared'>[]>();
        const assetRows = new Map<Handle<string, 'shared'>, Asset>();
        const byRenderable = new Map<number, RenderPublicationTemplate['dispatch'][number][]>();
        for (const { entityIndex: _entity, renderableIndex, ...dispatch } of frame.dispatch) {
          const rows = byRenderable.get(renderableIndex) ?? [];
          rows.push(dispatch);
          byRenderable.set(renderableIndex, rows);
        }
        const publishPrograms = (materials: readonly MaterialSnapshot[]) => {
          for (const material of materials) {
            const keys = new Set([
              ...Object.values(material.materialProgramKeys ?? {}),
              ...Object.values(material.materialSurfacePrograms ?? {}).map(
                (program) => program.programKey,
              ),
              ...Object.values(material.materialSceneIndexProgramKeys ?? {}).map(
                (program) => program.specializationKey,
              ),
              ...(material.materialShaderId === undefined ||
              material.materialShaderId.startsWith('forgeax::')
                ? []
                : [material.materialShaderId]),
            ]);
            for (const key of keys) {
              if (publishedPrograms.has(key) || programs.has(key)) continue;
              const shader = assets.shaderRegistry.findMaterialArtifact(key);
              if (!shader.ok) throw shader.error;
              const artifact = assets.getMaterialArtifact(key);
              programs.set(key, {
                key,
                shader: {
                  source: shader.value.source,
                  paramSchema: shader.value.paramSchema,
                  ...(shader.value.receipt === undefined ? {} : { receipt: shader.value.receipt }),
                },
                ...(artifact === undefined ? {} : { artifact }),
              });
            }
          }
        };
        for (let i = 0; i < frame.renderables.length; i++) {
          const row = frame.renderables[i] as RenderableSnapshot;
          if (row.skin) return fail('unsupported', 'source GPU skin receipt');
          if (
            row.materials.some((material) =>
              [...(material.textureSources?.values() ?? [])].some(isExternalTextureSource),
            )
          )
            return fail('unsupported', 'renderer-local external texture source');
          const { worldId: _world, entityKey, transform, ...snapshot } = row;
          const template = { snapshot, dispatch: byRenderable.get(i) ?? [] };
          const key = JSON.stringify(template, (_key, value: unknown) =>
            value instanceof Map
              ? _key === 'textureSources'
                ? [...value].map(([name, source]) => [
                    name,
                    isCanvasTextureSource(source)
                      ? `canvas:${source.canvasTextureId}`
                      : isExternalTextureSource(source)
                        ? `external:${source.externalTextureId}`
                        : renderTargetMaterialSourceIdentity(source),
                  ])
                : [...value]
              : ArrayBuffer.isView(value)
                ? Array.from(value as unknown as ArrayLike<number>)
                : value,
          );
          let templateId = templateIds.get(key);
          if (templateId === undefined) {
            templateId = templates.length;
            templateIds.set(key, templateId);
            templates.push(template);
          }
          upserts.push(entityKey, templateId);
          matrixRows.set(entityKey, transform.world);
          publishPrograms(row.materials);
          const handles = publicationDependencies(row);
          for (const lod of row.lods ?? []) {
            const handle = internSharedRefFromGuid(
              world,
              assets,
              AssetGuid.format(lod.mesh),
              'MeshAsset',
            );
            if (handle !== undefined) handles.push(handle);
          }
          nextDependencies.set(entityKey, handles);
          for (const handle of handles) {
            if (
              !baseline &&
              (consumers.has(handle) || frameDependencies.has(handle)) &&
              !invalidated.has(handle) &&
              catalogEpoch === assets.catalogEpoch
            )
              continue;
            const value = resolveAssetHandle(world, handle);
            if (!value.ok) throw value.error;
            assetRows.set(handle, value.value);
          }
        }
        const featureRows = featureSources.map((feature) => {
          const data = feature
            .extract({
              worlds: [world],
              owner: 0,
              frameNumber: revision + 1,
              ...(capabilities === undefined
                ? {}
                : { caps: capabilities, ...(limits === undefined ? {} : { limits }) }),
              views: frame.cameras
                .filter((camera) => camera.view?.enabled !== false)
                .flatMap(stereoEyeCameras)
                .map((camera) => ({
                  ...renderFeatureCameraView(camera),
                  ...(frame.cloudLayer === undefined
                    ? {}
                    : { frame: { cloudLayer: frame.cloudLayer } }),
                })),
              visibilitySnapshots: frame.featureVisibilitySnapshots,
            })
            .unwrap();
          return { identity: feature.identity, data };
        });
        const nextFrameDependencies = new Set(publicationFrameDependencies(frame));
        const pendingGuids = featureSources.flatMap((feature) => {
          const row = featureRows.find((row) => row.identity === feature.identity);
          return row === undefined ? [] : [...(feature.assetDependencies?.(row.data) ?? [])];
        });
        const seenGuids = new Set<string>();
        for (const guid of pendingGuids) {
          const key = guid.toLowerCase();
          if (seenGuids.has(key)) continue;
          seenGuids.add(key);
          const asset = assets.lookup(key);
          // Dynamic asset content is keyed by the canonical World handle. Feature
          // dependencies must share the same identity as ordinary scene consumers.
          const handle = internSharedRefFromGuid(
            world,
            assets,
            key,
            asset?.kind === 'material'
              ? 'MaterialAsset'
              : asset?.kind === 'mesh'
                ? 'MeshAsset'
                : 'RenderFeatureAsset',
          );
          if (asset === undefined || handle === undefined)
            throw new Error(`Missing feature asset ${guid}`);
          nextFrameDependencies.add(handle);
          for (const ref of assets.assetCatalog.get(key)?.refs ?? []) pendingGuids.push(ref.guid);
          if (asset.kind === 'material') {
            const material = resolveMaterialSnapshot(
              handle,
              world,
              assets,
              undefined,
              undefined,
              capabilities === undefined
                ? undefined
                : renderMaterialContext(capabilities, limits).materialContext,
            );
            publishPrograms([material]);
            for (const dependency of publicationDependencies({
              assetHandle: handle,
              materials: [material],
            }))
              nextFrameDependencies.add(dependency);
          }
        }
        for (const handle of nextFrameDependencies) {
          if (
            !baseline &&
            (consumers.has(handle) || frameDependencies.has(handle)) &&
            !invalidated.has(handle) &&
            catalogEpoch === assets.catalogEpoch
          )
            continue;
          const value = resolveAssetHandle(world, handle);
          if (!value.ok) throw value.error;
          assetRows.set(handle, value.value);
        }
        const emitted = new Set(frame.renderables.map((row) => row.entityKey));
        for (const entity of changed)
          if (members.has(entity) && !emitted.has(entity)) removed.add(entity);
        for (const entity of removed) matrixRows.delete(entity);
        const nextVideoConsumers = new Map(videoConsumers);
        for (const entity of removed) nextVideoConsumers.delete(entity);
        for (const row of frame.renderables) {
          const clips = [
            ...new Set(
              row.materials.flatMap((material) => [
                ...(material.videoTextureFields?.values() ?? []),
              ]),
            ),
          ];
          if (clips.length > 0) nextVideoConsumers.set(row.entityKey, clips);
          else nextVideoConsumers.delete(row.entityKey);
        }
        videoFrames = publicationVideoFrames(world, nextVideoConsumers);
        const nextCanvasConsumers = new Map(canvasConsumers);
        for (const entity of removed) nextCanvasConsumers.delete(entity);
        for (const row of frame.renderables) {
          const sources = [
            ...new Set(
              row.materials.flatMap((material) =>
                [...(material.textureSources?.values() ?? [])].filter(isCanvasTextureSource),
              ),
            ),
          ];
          if (sources.length > 0) nextCanvasConsumers.set(row.entityKey, sources);
          else nextCanvasConsumers.delete(row.entityKey);
        }
        canvasFrames = publicationCanvasFrames(nextCanvasConsumers);

        const transformEntities = new Uint32Array(
            buffer(2, matrixRows.size * 4),
            0,
            matrixRows.size,
          ),
          matrices = new Float32Array(buffer(3, matrixRows.size * 64), 0, matrixRows.size * 16);
        let index = 0;
        for (const [entity, matrix] of matrixRows) {
          transformEntities[index] = entity;
          matrices.set(matrix, index * 16);
          index++;
        }
        const {
          renderables: _rows,
          dispatch: _dispatch,
          visibilitySnapshots: _visibility,
          featureVisibilitySnapshots: _features,
          hiddenEntityReports: _hidden,
          shadowCasterEntityKeys: _casters,
          shadowCasterDrawKeys: _draws,
          shadowCasterMembership: _membership,
          ...metadata
        } = frame;
        const retired = new Set<Handle<string, 'shared'>>();
        const removedConsumers = new Set([...removed, ...nextDependencies.keys()]);
        const nextHandles = new Set([...nextDependencies.values()].flat());
        const removedCounts = new Map<Handle<string, 'shared'>, number>();
        for (const entity of removedConsumers)
          for (const handle of dependencies.get(entity) ?? [])
            removedCounts.set(handle, (removedCounts.get(handle) ?? 0) + 1);
        for (const [handle, count] of removedCounts)
          if (
            count === consumers.get(handle)?.size &&
            !nextHandles.has(handle) &&
            !nextFrameDependencies.has(handle)
          )
            retired.add(handle);
        for (const handle of frameDependencies) {
          if (
            !nextFrameDependencies.has(handle) &&
            !nextHandles.has(handle) &&
            (consumers.get(handle)?.size ?? 0) === (removedCounts.get(handle) ?? 0)
          )
            retired.add(handle);
        }
        const upsertColumn = new Uint32Array(buffer(0, upserts.length * 4), 0, upserts.length);
        upsertColumn.set(upserts);
        const removedColumn = new Uint32Array(buffer(1, removed.size * 4), 0, removed.size);
        removedColumn.set([...removed]);
        const packet: RenderPublication = {
          ...identity,
          revision: revision + 1,
          base: revision,
          baseline,
          time: { ...world.getResource(Time) },
          sampleTimeSeconds,
          temporalReset,
          transparentSort: getTransparentSortConfig(world),
          metadata,
          templates,
          videoFrames,
          ...(canvasFrames.length > 0 ? { canvasFrames } : {}),
          targets: targetOwner?.snapshot() ?? [],
          targetSources: publicationTargetSources(templates),
          features: featureRows,
          programs: [...programs.values()],
          upserts: upsertColumn,
          removed: removedColumn,
          transformEntities,
          transforms: matrices,
          assets: [...assetRows].map(([handle, value]) => {
            // Runtime content is a projection, so GUID identity stays with the
            // underlying catalogued payload rather than the projected object.
            const source = world.sharedRefs.resolve<string, Asset>(handle);
            const guid = assets.guidOf(source.ok ? source.value : value);
            return { handle, value, ...(guid === undefined ? {} : { guid }) };
          }),
          retiredAssets: [...retired],
          invalidatedAssets: [...invalidated],
        };
        batch.validate();
        active = true;
        let closed = false;
        return ok({
          packet,
          accept: () => {
            if (closed)
              throw new RenderPublicationError({ reason: 'revision', subject: 'closed candidate' });
            batch.accept();
            for (const handle of invalidated) pendingMeshContent.delete(handle);
            for (const key of programs.keys()) publishedPrograms.add(key);
            closed = true;
            active = false;
            revision++;
            flights.set(revision, {
              features: featureRows,
              owners: featureSources,
              submitted: false,
            });
            storage = spareStorage.pop() ?? [
              new ArrayBuffer(0),
              new ArrayBuffer(0),
              new ArrayBuffer(0),
              new ArrayBuffer(0),
            ];
            for (const row of videoFrames) row.frame.close();
            for (const row of canvasFrames) row.frame?.close();
            videoConsumers = nextVideoConsumers;
            canvasConsumers = nextCanvasConsumers;
            frameDependencies = nextFrameDependencies;
            catalogEpoch = assets.catalogEpoch;
            for (const entity of removedConsumers) {
              for (const handle of dependencies.get(entity) ?? []) {
                consumers.get(handle)?.delete(entity);
                if (consumers.get(handle)?.size === 0) consumers.delete(handle);
              }
              dependencies.delete(entity);
            }
            for (const entity of removedConsumers) {
              for (const joint of jointsByEntity.get(entity) ?? []) {
                const users = skinConsumers.get(joint);
                users?.delete(entity);
                if (users?.size === 0) skinConsumers.delete(joint);
              }
              jointsByEntity.delete(entity);
            }
            for (const row of frame.renderables) {
              if (row.skinJointEntities === undefined) continue;
              jointsByEntity.set(row.entityKey, row.skinJointEntities);
              for (const joint of row.skinJointEntities) {
                let users = skinConsumers.get(joint);
                if (users === undefined) {
                  users = new Set();
                  skinConsumers.set(joint, users);
                }
                users.add(row.entityKey);
              }
            }
            for (const entity of removed) members.delete(entity);
            for (const [entity, handles] of nextDependencies) {
              members.add(entity);
              dependencies.set(entity, handles);
              for (const handle of handles) {
                let users = consumers.get(handle);
                if (!users) {
                  users = new Set();
                  consumers.set(handle, users);
                }
                users.add(entity);
              }
            }
            for (const entity of matrixRows.keys()) pending.delete(entity);
            for (const entity of removed) pending.delete(entity);
            for (const sourceIndex of batch.indices) {
              const entity = source.projection.entity(sourceIndex);
              if (entity === undefined) {
                source.entities.delete(sourceIndex);
                source.contentHandles.delete(sourceIndex);
              } else {
                source.entities.set(sourceIndex, entity);
                const handles: number[] = [];
                if (world.hasComponent(entity, RuntimeMaterialValue))
                  handles.push(world.get(entity, RuntimeMaterialValue).unwrap().asset);
                if (world.hasComponent(entity, RuntimeMeshVertices))
                  handles.push(world.get(entity, RuntimeMeshVertices).unwrap().asset);
                if (handles.length) source.contentHandles.set(sourceIndex, handles);
                else source.contentHandles.delete(sourceIndex);
              }
            }
          },
          discard: () => {
            if (!closed) {
              closed = true;
              active = false;
              for (const row of videoFrames) row.frame.close();
              for (const row of canvasFrames) row.frame?.close();
            }
          },
        });
      } catch (cause) {
        for (const row of videoFrames) row.frame.close();
        for (const row of canvasFrames) row.frame?.close();
        return fail('unsupported', cause instanceof Error ? cause.message : String(cause));
      }
    },
    acknowledgeFeatures(
      acceptedRevision: number,
      receipts: readonly { readonly identity: string; readonly feedback: unknown }[],
    ): Result<void, RenderPublicationError> {
      if (disposed) return fail('disposed', 'publisher');
      const flight = flights.get(acceptedRevision);
      if (flight === undefined || flight.submitted)
        return fail('revision', 'feature acknowledgment');
      const identities = new Set<string>();
      for (const receipt of receipts) {
        if (identities.has(receipt.identity))
          return fail('revision', 'duplicate feature acknowledgment');
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        if (row === undefined || feature === undefined)
          return fail('shape', 'unknown feature acknowledgment');
        identities.add(receipt.identity);
      }
      flight.submitted = true;
      for (const receipt of receipts) {
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        feature?.onSourceFrameSubmitted?.(row?.data, receipt.feedback);
      }
      return ok(undefined);
    },
    recycle(
      acceptedRevision: number,
      buffers: readonly ArrayBuffer[],
    ): Result<void, RenderPublicationError> {
      if (disposed) return fail('disposed', 'publisher');
      if (flights.keys().next().value !== acceptedRevision)
        return fail('revision', 'returned storage revision');
      if (buffers.length !== 4 || buffers.some((value) => !(value instanceof ArrayBuffer)))
        return fail('shape', 'returned storage');
      if (active || storage.some((buffer) => buffer.byteLength > 0))
        spareStorage.push([...buffers]);
      else storage = [...buffers];
      flights.delete(acceptedRevision);
      return ok(undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseTransforms();
      members.clear();
      dependencies.clear();
      consumers.clear();
      pending.clear();
      pendingMeshContent.clear();
      videoConsumers.clear();
      flights.clear();
      spareStorage.length = 0;
      frameDependencies.clear();
      jointsByEntity.clear();
      skinConsumers.clear();
    },
  };
}
