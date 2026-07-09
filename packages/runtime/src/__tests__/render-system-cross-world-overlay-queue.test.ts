// feat-20260709-editor-world-partition-editorworld-super-composite / M1 / w2
// (RED — impl lands in w4/w5/w6). Contract test for cross-world Overlay queue
// merge ordering.
//
// AC-03 (gizmo overlays correctly): an editor gizmo lives in a SEPARATE world
// from the scene, drawn with an Overlay material pass (queue=4000, depthCompare
// 'always', depthWriteEnabled=false). When the editorWorld and sceneWorld are
// composited through `extractFrames(worlds, { cameraOwner, resourceOwner })`,
// the merged dispatch list must remain queue-sorted ACROSS worlds — so the
// Overlay (queue=4000) entity from the editorWorld is submitted AFTER the
// opaque (queue=2000) entity from the sceneWorld. If the merge sorted per-world
// instead of globally, the gizmo could be recorded before scene geometry and
// the topmost-overlay guarantee would break.
//
// This test asserts the ordering on the MERGED `frame.dispatch` (a single
// queue-sorted list, plan-strategy D-3). It calls the future two-index owner
// form so it is RED until w4 changes the extractFrames signature.
//
// Scope: queue-merge SEMANTICS only. Pixel-level gizmo visual correctness is
// M4's job (orchestrator Read(image) of a browser PNG, plan-strategy §5.4);
// this headless test carries no GPU dependency.
//
// Anchors:
//   requirements AC-03 (gizmo visually overlaid — here: queue merge semantics)
//   research F3 (gizmo Overlay queue=4000 + depthCompare 'always' +
//     depthWriteEnabled=false existing mechanism)
//   plan-strategy §4 risk "cross-world Overlay sort fails" countermeasure

import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type {
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
  MeshAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { extractFrames } from '../render-system-extract';

// Two-index owner shape w4-w6 introduces (see w1 for rationale).
interface OwnerSplit {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}
type ExtractFramesOwnerSplit = (
  worlds: readonly World[],
  owner: OwnerSplit,
  assets?: AssetRegistry | null,
) => ReturnType<typeof extractFrames>;
const extractFramesSplit = extractFrames as unknown as ExtractFramesOwnerSplit;

const QUEUE_OPAQUE = 2000;
const QUEUE_OVERLAY = 4000; // research F3: gizmo Overlay queue.

function identityTransform(): {
  posX: number;
  posY: number;
  posZ: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
} {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };
}

function makeShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
  sr.registerMaterialShader('forgeax::default-unlit', {
    source: 'fn main() {}',
    paramSchema: [{ name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] }],
  });
  return sr;
}

// Minimal triangle mesh so the entity is renderable and produces a dispatch.
// No `aabb` field: the extract-stage frustum cull treats an AABB-less mesh as
// always-visible (conservative pass-through), so the entity survives extract
// regardless of camera frustum (headless robustness).
function registerMesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: new Float32Array([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  });
}

function registerMaterial(world: World, queue: number): Handle<'MaterialAsset', 'shared'> {
  const pass: MaterialPassDescriptor = {
    name: queue === QUEUE_OVERLAY ? 'Overlay' : 'Forward',
    shader: 'forgeax::default-unlit',
    queue,
  };
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [pass],
    paramValues: {},
  } as MaterialAsset);
}

// A world holding a single renderable at the given queue. The mesh carries no
// AABB, so the entity survives extract regardless of camera frustum (headless
// robustness — see registerMesh).
function makeRenderableWorld(queue: number): World {
  const world = new World();
  const mesh = registerMesh(world);
  const mat = registerMaterial(world, queue);
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [mat] } },
    )
    .unwrap();
  return world;
}

describe('cross-world Overlay queue merge (w2, AC-03)', () => {
  it('Overlay(queue=4000) from editorWorld is dispatched AFTER opaque(queue=2000) from sceneWorld', () => {
    // sceneWorld (index 0): a camera + one opaque renderable. It is the
    // resourceOwner (supplies singleton resources) and cameraOwner in this
    // composite; the editorWorld carries only the gizmo overlay.
    const sceneWorld = makeRenderableWorld(QUEUE_OPAQUE);
    sceneWorld
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    // editorWorld (index 1): the gizmo overlay renderable at queue=4000.
    const editorWorld = makeRenderableWorld(QUEUE_OVERLAY);

    const assets = new AssetRegistry(makeShaderRegistry());
    // cameraOwner=0 (scene camera), resourceOwner=0 (scene singletons); the
    // editorWorld contributes renderables that must merge into the global queue.
    const frame = extractFramesSplit(
      [sceneWorld, editorWorld],
      {
        cameraOwner: 0,
        resourceOwner: 0,
      },
      assets,
    );

    // Locate the opaque + overlay dispatch entries in the MERGED list.
    const opaqueIdx = frame.dispatch.findIndex((d) => d.queue === QUEUE_OPAQUE);
    const overlayIdx = frame.dispatch.findIndex((d) => d.queue === QUEUE_OVERLAY);

    // Both worlds contributed a dispatch entry (cross-world merge happened).
    expect(opaqueIdx).toBeGreaterThanOrEqual(0);
    expect(overlayIdx).toBeGreaterThanOrEqual(0);

    // The core AC-03 guarantee: the Overlay entity (from the editorWorld) is
    // submitted AFTER the opaque entity (from the sceneWorld) in the single
    // queue-sorted dispatch list. Per-world sorting would not guarantee this.
    expect(overlayIdx).toBeGreaterThan(opaqueIdx);
  });
});
