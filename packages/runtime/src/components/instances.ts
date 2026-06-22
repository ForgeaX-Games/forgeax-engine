// @forgeax/engine-runtime - Instances component (per-entity instanced-draw transforms).
//
// Schema: 1 array<f32> field `transforms` carrying packed column-major mat4
// instance transforms (16 f32 per instance, stride = 16). Stride is enforced
// through a TWO-LAYER contract:
//
//   1. AI user set-site: spawn / `world.set` / `world.push` callers pass a
//      `Float32Array` (or numeric array) whose `length` is a non-zero
//      multiple of 16. The set site is the AI user's responsibility -- the
//      engine cannot prove the column-major mat4 packing without the
//      caller's intent.
//   2. RenderSystem extract entry: `render-system-extract.ts` performs a
//      defensive `transforms.length % 16 === 0` check on every
//      `world.get(e, Instances).transforms` snapshot at frame extract time;
//      violations route a structured `InstanceTransformsStrideMismatchError`
//      (`code: 'instance-transforms-stride-mismatch'`,
//      `detail: { actualLength, expectedStride: 16 }`) through the World
//      Layer-3 ErrorHandler and the renderable is skipped (fail-fast: the
//      malformed length never reaches the GPU upload path).
//
// feat-20260515-buffer-array-vocab-collapse M3 / w16 (decision §2.3 stride
// responsibility migration): the legacy component-level
// stride-declaration option (`{ transforms: 16 }` keyed on the retired
// per-component stride defineComponent option key) was retired because:
//   - The ECS layer no longer carries any per-component stride schema (M2 /
//     w9 dropped the option from `DefineComponentOptions` -- the SSOT
//     moved to the RenderSystem entry + AI user set site).
//   - Centralising the check at the consumer (RenderSystem extract) rather
//     than the producer (ECS write paths) lets the GPU upload path stay
//     trust-the-snapshot; AI users get one structured error per offending
//     frame rather than one per write.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w14:
// migrated from the legacy `{ buffer: 'ref', count: 'u32' }` pair (which
// cross-coupled with the now-deleted `AssetRegistry.createInstancedBuffer`
// pipeline + the `InstancedBufferAsset` POD) to the ECS-managed array path.
// Resize is a `world.push(e, Instances, 'transforms', value)` away (one f32
// at a time) plus a future `world.grow` if a bulk-resize affordance is
// added.
//
// Storage buffer cap-gate (D-5 OOS-08 follow-up):
//   - The runtime RenderSystem consumer (`render-system-record.ts`) checks
//     `device.caps.storageBuffer` before binding the per-entity transforms;
//     `caps.storageBuffer === false` (backend lacking storage buffer support,
//     e.g. rhi-wgpu webgl backend) routes a `RhiError` ('feature-not-enabled').
//     A future loop owns the per-draw fallback path.
//
// Group transform chained semantics (charter proposition 5 mental migration):
//   - When the same entity carries both `Transform` (entity_world) and
//     `Instances` (per-instance local transforms), the vertex shader
//     composes per instance:
//
//       world_position[i] = entity_world * instances_local[i] * vertex_position
//
//   - `Instances.transforms[i*16..i*16+15]` is interpreted as a local-space
//     transform under the entity, exactly like a child entity's `Transform`
//     under `ChildOf { parent }` in the hierarchy system. AI users reuse
//     the `parent x local` intuition without a new concept. Set the
//     entity's `Transform` to identity to make `instances_local[i]`
//     directly world-space.
//
// 4-segment minimum contract (read this header before reaching for
// the source body):
//
// ===== (a) single-component import + spawn example =====
//
//   import {
//     createRenderer, HANDLE_CUBE,
//     MeshFilter, MeshRenderer, Transform,
//     Instances, type InstancesData,
//   } from '@forgeax/engine-runtime';
//
//   // 1 entity rendering N instanced cubes (16N packed f32, column-major mat4):
//   const transforms = new Float32Array(N * 16);
//   // ... fill column-major mat4 columns per instance ...
//   world.spawn(
//     { component: MeshFilter,    data: { assetHandle: HANDLE_CUBE } },
//     { component: MeshRenderer,  data: {} },
//     { component: Instances,     data: { transforms } },
//   );
//
// ===== (b) packed mat4 layout =====
//
//   const transforms = new Float32Array(N * 16); // column-major mat4 per instance
//   // instance i occupies floats [i*16 .. i*16+15]:
//   //   [m00 m10 m20 m30   <- column 0
//   //    m01 m11 m21 m31   <- column 1
//   //    m02 m12 m22 m32   <- column 2
//   //    m03 m13 m23 m33]  <- column 3 (translation in m03/m13/m23)
//
// `transforms.length` MUST be a non-zero multiple of 16. AI users gate at
// the set / push site; the RenderSystem extract entry holds the second
// defensive (AC-06: detail carries `{ expectedStride: 16, actualLength }`).
// The instance count is the live snapshot length / 16.
//
// ===== (c) error code consumption (typed property access, no message regex) =====
//
//   // Stride violation surfaces through the engine-ecs Layer-3 ErrorHandler
//   // when extract reads a malformed snapshot:
//   //   on('error', (err) => {
//   //     if (err.code === 'instance-transforms-stride-mismatch') {
//   //       // err.detail.expectedStride === 16
//   //       // err.detail.actualLength === <user-supplied length>
//   //     }
//   //   });
//   //
//   // RenderSystem cap-gate (D-5) -> RhiError 'feature-not-enabled' on the
//   // RhiErrorListenerRegistry channel:
//   //   on('error', (err) => {
//   //     if (err.code === 'feature-not-enabled') {
//   //       console.warn(err.expected, err.hint);
//   //     }
//   //   });
//
// charter mapping: proposition 1 (single import surface
// `import { Instances, type InstancesData } from '@forgeax/engine-runtime'`);
// proposition 3 (machine-readable schema > prose:
// `{ transforms: 'array<f32>' }` is the SSOT, stride 16 documented here +
// enforced at the RenderSystem entry);
// proposition 4 (explicit failure: stride violation routes a structured
// EcsError, not a silent half-row); proposition 5 (consistent abstraction:
// Instances mirrors Children -- both ride the array-vocab path).
//
// Anchors: requirements §AC-06 (stride 16 + RenderSystem upload path);
// plan-strategy §2.3 (stride responsibility migration to RenderSystem entry
// defensive + AI user set site) + §3.3 stride error path; plan-decisions
// D-1 / D-5.
// OOS-09 (no addChild Commands API) does not apply here; OOS-01 (no
// dangling-entity sweep) does not apply (Instances stores f32 not entity).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Per-entity instanced-draw transforms (ECS component).
 *
 * Carries a variable-length `array<f32>` of column-major mat4 instance
 * transforms (16 f32 per instance, stride = 16; documented above and
 * enforced at the RenderSystem extract entry, NOT at the ECS write paths).
 *
 * The runtime RenderSystem consumer materialises a fresh `Float32Array`
 * snapshot on every `world.get(e, Instances).transforms` access (D-4
 * no-cache), reads the live count from the snapshot's `length`, and
 * uploads the bytes to a per-entity GPU storage buffer in the record stage
 * (`render-system-record.ts`).
 *
 * @example Spawn an entity rendering 10000 instanced cubes:
 *   const transforms = new Float32Array(10000 * 16);
 *   // ... fill column-major mat4 columns ...
 *   world.spawn(
 *     { component: MeshFilter,   data: { assetHandle: HANDLE_CUBE } },
 *     { component: MeshRenderer, data: { ... } },
 *     { component: Instances,    data: { transforms } },
 *   );
 */
export const Instances = defineComponent('Instances', {
  transforms: { type: 'array<f32>' },
});

/**
 * Type-level hint for `data` at the `Instances` spawn site.
 *
 * The runtime ECS column shape for `array<f32>` accepts a `Float32Array`
 * payload at spawn / set time (the bytes are copied into the BufferPool
 * slot). The `transforms` field is documented as `Float32Array` here so
 * AI-user IDE autocomplete picks up the typed-array shape.
 *
 * @example
 *   import type { InstancesData } from '@forgeax/engine-runtime';
 *   const data: InstancesData = { transforms: new Float32Array(N * 16) };
 */
export type InstancesData = {
  readonly transforms: Float32Array;
};
