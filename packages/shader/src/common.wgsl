#define_import_path forgeax_view::common

// @forgeax/engine-shader - common.wgsl (M5 T-18 feat-20260512-naga-oil-composition-hmr).
//
// Shared view + mesh structs extracted from pbr.wgsl + unlit.wgsl via
// naga_oil #define_import_path / #import (D-04 moduleId convention). Both
// material shaders pull View + Mesh from here so the RenderSystem can
// uniform-upload view + mesh storage once per frame for all pipelines.
//
// `View` carries the full PBR-superset field set (worldViewProj + light +
// cameraPos). Unlit only reads `worldViewProj`; the extra fields stay bound
// but unused in the unlit path (zero perf cost because the fragment shader
// never references them). This is the canonical "superset struct" pattern
// aligned with Bevy's bevy_view::common and matches charter proposition 5
// (consistent abstraction - one View struct everywhere).

// View UBO byte layout (592 B std140):
//   [  0.. 64) worldViewProj    mat4x4<f32>  (align 16, size 64)
//   [ 64.. 80) lightDir         vec3<f32>    (align 16, 12+4 pad)
//   [ 80.. 96) lightColor       vec3<f32>    (align 16, 12+4 pad)
//   [ 96..112) cameraPos        vec3<f32>    (align 16, 12+4 pad)
//   [112..176) lightViewProj_A  mat4x4<f32>  (align 16, size 64)
//   [176..240) inverseViewProj  mat4x4<f32>  (align 16, size 64)
//   [240..304) lightViewProj_B  mat4x4<f32>  (align 16, size 64)
//   [304..368) lightViewProj_C  mat4x4<f32>  (align 16, size 64)
//   [368..432) lightViewProj_D  mat4x4<f32>  (align 16, size 64)
//   [432..448) splitPlanes[0]   vec4<f32>     (align 16, 16; .x=depth)
//   [448..464) splitPlanes[1]   vec4<f32>     (align 16, 16)
//   [464..480) splitPlanes[2]   vec4<f32>     (align 16, 16)
//   [480..496) splitPlanes[3]   vec4<f32>     (align 16, 16)
//   [496..500) cascadeCount     f32           (align 4, size 4)
//   [500..504) cascadeBlend     f32           (align 4, size 4)
//   [504..508) depthBias        f32           (align 4, size 4)
//   [508..512) normalBias       f32           (align 4, size 4)
//   [512..516) pcfKernelSize    f32           (align 4, size 4)
//   [516..528) _align_pad      —             (mat4 array align=16, 12 B)
//   [528..784) spotLightViewProj array<mat4x4<f32>,4>  (align 16, size 256)
//   WGSL struct = 784 B. Host UBO = VIEW_UBO_BYTES = 784 B (createRenderer.ts);
//   render-system-record.ts writes the full 196 f32 payload. The spot matrix
//   array fold (feat-20260625 w25) removes the standalone @group(0) binding 9
//   uniform buffer so the WebGL2 fallback fragment uniform-buffer count returns
//   to 11 (GLES 3.0 max).
//   total = 784 B.
//
// Field order must stay byte-for-byte identical to every prior release
// (charter P4 consistent abstraction); new fields append at the tail.
// Host write in render-system-record.ts builds the 148-float payload and
// createRenderer.ts allocates VIEW_UBO_BYTES = 592.
//
// feat-20260531-skybox-env-background M2 / w3: inverseViewProj appended
// at the tail (64 B mat4 at byte offset 176). The host pre-computes
// mat4.invert(inverseViewProj, worldViewProj) so the skybox fragment
// shader can reconstruct world-space view direction without per-pixel
// matrix inversion.
//
// feat-20260613-csm-cascaded-shadow-maps M4 / w16 + M5 / w28:
// the legacy single-cascade light-space matrix is replaced by a 4-cascade
// `lightViewProj_A..D` array at offset 112 (inverseViewProj stays at 176;
// `lightViewProj_B..D` + `splitPlanes` + cascadeCount/cascadeBlend follow
// inverseViewProj). WGSL struct is 512 B (auto-padded tail); the host
// allocates 592 B and writes 22 f32 of trailing zeros (88 B) to satisfy
// the AC-08 fixed-UBO-size invariant (the extra bytes are never read).
// shadow_caster.wgsl indexes the 4 fields via `shadowCasterCascade.index`
// (binding 5, written per shadow pass).
//
// feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t3:
// the merged DirectionalLight's shadow bias + PCF kernel width append at the
// tail (depthBias / normalBias / pcfKernelSize at bytes 504/508/512, floats
// 126/127/128). Tail-append only -- field order is byte-for-byte stable
// (charter P4); the prior 88 B host tail pad shrinks to 64 B, total stays
// 592 B (host UBO size unchanged, AC-08). lighting-directional.wgsl drives the
// directional shadow bias (D-1: bias = max(normalBias*(1-N.L), depthBias)) and
// a pcfKernelSize-wide PCF loop from these fields.
//
// feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
// the per-spot perspective `spotLightViewProj` matrices (4 lanes, fragment-read)
// fold into the View UBO tail instead of a standalone @group(0) binding 9
// uniform buffer. The standalone binding pushed the fragment-stage uniform
// buffer count to 12 (view + pointLights + spotLights + shadowParams +
// shadowCasterCascade + spotLightViewProj on the WebGL2 fallback path),
// exceeding GLES 3.0's `max_uniform_buffers_per_shader_stage = 11` so the
// WebGL2 fallback (mobile / WebKit — this feat's compat target) crashed
// pipeline-layout creation. Folding into the View UBO costs zero new bindings
// (the count drops back to 11). D-1 rejected the View UBO for the CASTER vertex
// channel (binding 7) because directional + spot casters both need a light-view
// matrix in the same frame (same-frame write contention); the FRAGMENT read
// channel has no such contention — the host writes all <=4 spot matrices once
// per frame before the forward pass, so the fold is safe. mat4 array align=16:
// the array lands at byte 528 (next 16 B-aligned offset after pcfKernelSize at
// byte 512..516), spanning bytes 528..784. WGSL struct = 784 B; the host
// allocates VIEW_UBO_BYTES = 784 (createRenderer.ts) and writes the full 196 f32
// payload (render-system-record.ts). Lane N = the spot with `shadowAtlasTile
// === N` (cap = 4); `evalSpotShadowed` reads `view.spotLightViewProj[tile]`.
struct View {
  worldViewProj   : mat4x4<f32>,
  lightDir        : vec3<f32>,
  lightColor      : vec3<f32>,
  cameraPos       : vec3<f32>,
  lightViewProj_A : mat4x4<f32>,
  inverseViewProj : mat4x4<f32>,
  lightViewProj_B : mat4x4<f32>,
  lightViewProj_C : mat4x4<f32>,
  lightViewProj_D : mat4x4<f32>,
  splitPlanes     : array<vec4<f32>,4>,
  cascadeCount    : f32,
  cascadeBlend    : f32,
  depthBias       : f32,
  normalBias      : f32,
  pcfKernelSize   : f32,
  // feat-20260625-spot-light-shadow-mapping w25: per-spot perspective
  // light-view-projection matrices, fragment-read. Auto-aligned to byte 528
  // (mat4 array align=16, after pcfKernelSize at byte 512); spans bytes
  // 528..784. Lane N = spot with shadowAtlasTile === N (cap = 4). Zeroed lanes
  // are safe (sample gated on shadowAtlasTile >= 0 in default-standard-pbr.wgsl).
  spotLightViewProj : array<mat4x4<f32>, 4>,
};

// Per-instance mesh slot (feat-20260518-pbr-direct-lighting-mvp M2 / w8.5,
// plan-strategy D-5 + AC-08). `normalMatrix` is the host-precomputed
// transpose(inverse(mat3(worldFromLocal))) so the fragment stage avoids the
// 9-mul shader-side inverse path; per-frame per-entity CPU computation
// (single mat4 -> mat3 -> invert+transpose) is one-shot and feeds the
// world-space normal mapping path in pbr.wgsl. Storage layout: mat4 in
// [0, 64), mat3 columns in [64, 112) padded as three vec4 (16 B each = 48 B
// total), trailing slack inside the PER_ENTITY_STRIDE = 256 B slot.
struct Mesh {
  worldFromLocal : mat4x4<f32>,
  normalMatrix   : mat3x3<f32>,
};

// feat-20260519-light-casters-point-spot-pbr M4 / w21 (D-S1 + D-S2 +
// AC-04 b/c + AC-05 binding declaration). Punctual-light std430 storage
// types byte-for-byte mirror packPointLight / packSpotLight in
// `packages/runtime/src/light-buffer-layout.ts`:
//
//   PointLight (32 B / 8 floats):
//     [ 0..2 ] position vec3<f32>
//     [   3 ] invRangeSquared f32 (Bevy color_inverse_square_range.w; 0
//             collapses range falloff to a pure 1/d^2 inverse-square law)
//     [ 4..6 ] colorTimesIntensity vec3<f32> (host pre-multiplied
//             color * intensity so the shader avoids the per-fragment mul)
//     [   7 ] pad f32 = 0
//
//   SpotLight (64 B / 16 floats):
//     [ 0..2 ] position vec3<f32>
//     [   3 ] invRangeSquared f32
//     [ 4..6 ] colorTimesIntensity vec3<f32>
//     [   7 ] cosInner f32 (cos of half-angle inner cone; KHR
//             smoothstep falloff anchor)
//     [ 8..10] direction vec3<f32> (raw outgoing vector; shader reads
//             via dot(L, -direction) for cone angle test)
//     [  11 ] cosOuter f32
//     [12..14] spotPad vec3<f32> = 0 (std430 vec4-alignment padding)
//     [  15 ] shadowAtlasTile i32 (sentinel -1 = unassigned/clipped,
//             0..3 = spot atlas tile index; feat-20260625 M2/M3 D-4)
//
// WGSL std430 alignment audit: vec3<f32> alignof=16 / sizeof=12. The
// f32 lane wedged immediately after each vec3 fills the 4 B remainder
// (WGSL struct member rule: next.offset = roundUp(prev.offset +
// prev.size, this.alignof) - for f32 alignof=4 the round-up is a
// no-op, so position[3] / color[3] / direction[3] sit at byte
// offsets 12 / 28 / 44 with zero internal padding). PointLight stays
// 32 B; SpotLight grows to 64 B (feat-20260625 M2/M3 D-4): the trailing
// `spotPad: vec3<f32>` + `shadowAtlasTile: i32` form one vec4-aligned block
// at bytes 48..64, with `shadowAtlasTile` at byte 60. These struct sizes
// match the host packers (packPointLight 32 B / packSpotLight 64 B) exactly.
//
// Header `count: u32` lives in a wrapper struct with the trailing
// runtime-sized array. Array-of-vec4-aligned-struct alignof = 16, so
// `slots` starts at byte 16 (count u32 occupies 0..4; bytes 4..16 are
// implicit padding). This matches `packLightArrayHeader`'s 16 B
// (count u32 + 12 B pad) layout in light-buffer-layout.ts.

struct PointLight {
  position            : vec3<f32>,
  invRangeSquared     : f32,
  colorTimesIntensity : vec3<f32>,
  // feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 (plan-strategy §D-2):
  // Repurposes the prior `pointPadW` (f32 zero-pad) lane as `shadowAtlasLayer`
  // (i32 sentinel, -1 = no shadow, 0..3 = cube_array atlas layer index for
  // shadow-casting point lights). Cap = 4 enforced by the PointLightShadow
  // ECS component cardinality. The shader path samples the cube_array atlas
  // (binding 5) only when `shadowAtlasLayer >= 0`. Field name is unique to
  // this struct (no `pad0`/`pad1` collision with the pbr Material struct
  // under naga_oil writeback substitution).
  shadowAtlasLayer    : i32,
};

struct SpotLight {
  position            : vec3<f32>,
  invRangeSquared     : f32,
  colorTimesIntensity : vec3<f32>,
  cosInner            : f32,
  direction           : vec3<f32>,
  cosOuter            : f32,
  // feat-20260625-spot-light-shadow-mapping M3 / w13 (plan-strategy D-4):
  // The prior 8-lane (48 B) SpotLight had no spare pad lane (unlike PointLight
  // which repurposed `pointPadW`), so the clip-signal field needs a fresh
  // vec4-aligned block. `spotPad` fills bytes 48..60 (host packSpotLight slots
  // 12..14 stay zero); `shadowAtlasTile` (i32 sentinel, -1 = no shadow /
  // clipped, 0..3 = spot atlas tile) lands at byte 60 (host slot 15, written
  // through an Int32Array view). The fragment path gates on
  // `shadowAtlasTile >= 0` (evalSpotShadowed vs evalSpot). Field names are
  // unique across the composed module surface so naga_oil writeback
  // substitution does not collide with prior `pad0` members. (naga_oil
  // reserves the `__` identifier prefix, so the pad lane is `spotPad`, not
  // `__pad`.)
  spotPad             : vec3<f32>,
  shadowAtlasTile     : i32,
};

struct PointLightsArray {
  count : u32,
  slots : array<PointLight, 4>,
};

struct SpotLightsArray {
  count : u32,
  slots : array<SpotLight, 4>,
};

@group(0) @binding(0) var<uniform> view : View;
#if STORAGE_BUFFER_AVAILABLE == true
@group(0) @binding(1) var<storage, read> pointLightsBuffer : PointLightsArray;
@group(0) @binding(2) var<storage, read> spotLightsBuffer  : SpotLightsArray;
#else
@group(0) @binding(1) var<uniform> pointLightsBuffer : PointLightsArray;
@group(0) @binding(2) var<uniform> spotLightsBuffer  : SpotLightsArray;
#endif
// feat-20260520-directional-light-shadow-mapping M3 / w16 (D-1 / plan-strategy §8.1):
// shadowMap + shadowSampler consume @group(0) bindings 3/4 (smallest unused
// slots adjacent to view UBO at 0). M3 uses 3x3 PCF with textureLoad on
// shadowMap for 9-tap depth sampling; shadowSampler retained for GPU probe.
//
// feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 (plan-strategy §D-1 + §D-8):
// Binding 5 declares the cube_array shadow atlas (texture_depth_cube_array,
// layers=4, depth32float; one cube per shadow-casting point light, cap=4).
// Binding 6 declares the per-light shadow params buffer (URP only — proj
// constants for cube depth-ref reconstruction); HDRP rides the same constants
// on LightSlot pad lanes (.kind_and_pad.wyz) so binding 6 stays unbound on
// the HDRP path. Sample-time gating by PointLight.shadowAtlasLayer >= 0.
@group(0) @binding(3) var shadowMap       : texture_depth_2d;
@group(0) @binding(4) var shadowSampler   : sampler_comparison;
// feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-7 (plan-strategy §D-1 + §D-8):
// Bindings 5 + 6 carry the cube_array shadow atlas + per-light shadow params
// buffer. URP forward consumers (this file's `forgeax_view::common`) declare
// them only when the `POINT_SHADOW_AVAILABLE` naga_oil define is true so
// material shaders that share the URP BGL but do not yet require shadows
// keep validating with the lean BGL shape (binding 0..4) — the runtime
// `viewBindGroupLayout` in createRenderer.ts is the matching SSOT.
//
// Cube_array depth atlas (binding 5):
//   `texture_depth_cube_array` with `layers = 4` (= PointLightShadow
//   cardinality cap). Sampled via `sample_shadow_cube_hw2x2`
//   (forgeax_pbr::shadow_pcf) in lighting-punctual.wgsl when
//   `PointLight.shadowAtlasLayer >= 0`.
//
// Per-light shadow params (binding 6):
//   `array<vec4<f32>, 4>` carrying the URP-side proj constants for cube
//   depth-ref reconstruction (research L0.5 + L1.13). Each lane stores the
//   shader-side reconstruction constants for one shadow-casting point light;
//   slot N matches `PointLight.shadowAtlasLayer = N`. HDRP rides the same
//   constants on `LightSlot.kind_and_pad.wyz` so binding 6 stays unbound on
//   the HDRP path.
#ifdef POINT_SHADOW_AVAILABLE
@group(0) @binding(5) var shadowAtlas : texture_depth_cube_array;
@group(0) @binding(6) var<uniform> shadowParams : array<vec4<f32>, 4>;
#endif

// feat-20260613-csm-cascaded-shadow-maps M5 / w28: shadowCasterCascade is
// a per-pass uniform consumed exclusively by `shadow_caster.wgsl`. The
// host writes `index = i` (in 0..3) before each cascade's shadow pass so
// the shadow_caster vertex shader picks the matching `view.lightViewProj_X`
// for that pass. Forward material shaders declare the binding (it lives
// in the shared view BGL) but never reference it -- WGSL accepts unused
// bindings. The `index` is a u32; the three trailing u32 lanes keep the
// struct at the 16-byte uniform-buffer alignment WebGL2 requires.
//
// Binding 7 (not 5) on 2026-06-13: bindings 5/6 went to point-shadow
// (cube_array atlas + params UBO; FRAGMENT-only) so the cascade UBO —
// which needs VERTEX|FRAGMENT visibility — moved to the next free slot.
// `pbr-pipeline.ts buildPbrViewBglEntries` is the matching SSOT.
// feat-20260625-spot-light-shadow-mapping M2 / w10 (D-1): the cascade UBO
// gains a spot-specific perspective light-view-projection matrix + an `isSpot`
// discriminant. The spot shadow pass writes its own perspective matrix into
// `spotLightViewProj` + sets `isSpot = 1u` before each tile pass; the
// shadow_caster vertex shader then routes through the spot matrix instead of
// the directional `view.lightViewProj_A..D` cascade slots. This keeps the spot
// matrix OUT of the directional View UBO (no same-frame write contention —
// directional and spot both need light-view-proj matrices in one frame). The
// `index` lane is unused on the spot path (spot tile order is tracked
// host-side via depthLoadOp clear/load counting, decoupled from directional
// cascadeIndex per D-2).
struct ShadowCasterCascade {
  index : u32,
  // feat-20260625 M2 / w10 (D-1): spot-path discriminant (0 = directional
  // cascade, 1 = spot perspective). Repurposes the former `shadowCasterPadA`
  // lane. The shadow_caster vertex shader branches on this.
  isSpot : u32,
  // Two trailing u32 pad lanes (zero-initialised host-side) keep `index`/
  // `isSpot` in the first 16 B vec4 so the `mat4x4<f32>` below starts at a
  // 16 B-aligned offset (WebGL2 GLES 3.0 requirement). Field names are unique
  // across the composed module surface so naga_oil's writeback substitution
  // does not collide with prior `pad0` / `pad1` members in other shared
  // structs (Material, SkylightUniforms).
  shadowCasterPadB : u32,
  shadowCasterPadC : u32,
  // feat-20260625 M2 / w10 (D-1): spot perspective light-view-projection
  // matrix (perspective(outerCone*2) x lookAt). Written per spot tile pass.
  // Ignored on the directional path (isSpot = 0).
  spotLightViewProj : mat4x4<f32>,
};
@group(0) @binding(7) var<uniform> shadowCasterCascade : ShadowCasterCascade;

// feat-20260625-spot-light-shadow-mapping M3 / w13 (plan-strategy D-5):
// Spot shadow atlas (single 2D depth texture; the host packs up to 4 spot
// shadows into a 2x2 tile grid — see urp-pipeline.ts spotShadowDepth). Bound
// at @group(0) binding 8 (smallest free slot after the cascade UBO at 7).
//
// ALWAYS-ON, no #ifdef gate (unlike the point cube_array atlas at binding 5,
// which rides POINT_SHADOW_AVAILABLE because cube_array is unavailable in the
// WebGPU compat profile). Spot shadows are `texture_depth_2d` only, which is
// compat-safe everywhere, so the binding is unconditionally declared — keeping
// the BGL <-> WGSL alignment surface minimal (D-5: a define axis here would be
// pure burden). The matching runtime SSOT is `buildPbrViewBglEntries`
// (pbr-pipeline.ts) which declares binding 8 unconditionally.
//
// The comparison sampler is REUSED from binding 4 (`shadowSampler`): spot
// perspective-depth sampling needs the exact same descriptor (clamp-to-edge +
// compare less) as directional/point, so no binding 9 sampler is introduced.
// The per-spot perspective lightViewProj matrices that the forward (fragment)
// shadow sample needs live in the View UBO (binding 0, `view.spotLightViewProj`)
// — folded there in feat-20260625 w25 (scope-amend) to keep the WebGL2 fallback
// fragment uniform-buffer count <= 11; binding 8 is the last view-BG binding.
@group(0) @binding(8) var spotShadowMap : texture_depth_2d;

#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(0) var<storage, read> meshes : array<Mesh>;
#else
@group(2) @binding(0) var<uniform> meshes : array<Mesh, 128>;
#endif

// feat-20260604-instances-per-instance-transform-shader-group3-bin M1 / w3:
// Per-instance local transform (column-major mat4, 64 B per entry).
// Byte-for-byte isomorphic to the record-stage packed mat4 write in
// render-system-record.ts (inst.transforms, stride-16 row-major 16-float
// per-instance) and the identity 16-float mat4 in createRenderer.ts.
// @group(3) is the per-instance storage buffer — already uploaded by
// the record stage at render-system-record.ts:2958, bound via
// setBindGroup(3, instancesBg) at :2985, and drawn with
// drawIndexed(indexCount, instanceCount, 0, 0) at :2898.
//
// Reuses the STORAGE_BUFFER_AVAILABLE axis (D-2) — the uniform fallback
// array<InstanceData, 128> caps at MAX_UNIFORM_INSTANCES=128, same as
// the meshes array. No new INSTANCE_STORAGE_AVAILABLE axis.
//
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M2 / w7
// (plan-strategy §2 D-1 + §2 D-4 + research §Q-R-4.1-4.4): the
// PER_INSTANCE_REGION axis is declared in sprite.wgsl ONLY (D-4 keeps
// pbr / unlit at their existing 2-variant count). When the sprite
// pipeline composes this module with `PER_INSTANCE_REGION = true`, the
// InstanceData struct grows from 64 B (mat4) to 80 B (mat4 + vec4) so
// the record stage can interleave per-instance UV regions into the same
// single GPU buffer that already carries the per-instance mat4 (single
// binding slot, BGL zero-modification per D-R-4). The conditional sits
// at the tail of the struct so the pre-feat 64 B layout stays
// byte-identical when PER_INSTANCE_REGION is undefined (sprite-atlas
// + every non-sprite material).
//
// Uniform-fallback safety (R-6): worst case is
//   80 B × MAX_UNIFORM_INSTANCES (128) = 10240 B
// which is below the WebGL2 UBO floor of 16384 B; the 128 cap survives
// the stride bump.
struct InstanceData {
  localFromInstance : mat4x4<f32>,
#if PER_INSTANCE_REGION == true
  // Per-instance atlas region: .xy = (uMin, vMin), .zw = (uW, vH). Pairs
  // with the legacy `material.region` UBO field (sprite.wgsl Material
  // struct, 16 B at byte offset 16). Sprite vs_main picks between the
  // material-level fallback (legacy, single-material-per-draw) and the
  // per-instance value via the same `#if PER_INSTANCE_REGION == true`
  // gate so a single sprite.wgsl source supports both shapes.
  region : vec4<f32>,
#endif
};
#if STORAGE_BUFFER_AVAILABLE == true
@group(3) @binding(0) var<storage, read> instances : array<InstanceData>;
#else
@group(3) @binding(0) var<uniform> instances : array<InstanceData, 128>;
#endif

// Fullscreen large-triangle SSOT (feat-20260519-tonemap-reinhard-mvp / T-M2.1,
// research F3 section 2.3). 3 vertices in clip-space:
//   index 0 -> (-1, -1)   bottom-left
//   index 1 -> ( 3, -1)   beyond right edge
//   index 2 -> (-1,  3)   beyond top edge
// The triangle fully covers [-1, 1]^2 NDC; the rasterizer clips the
// out-of-range portion. UV is derived from xy with Y flipped so the
// downstream textureSample returns the right-side-up image (WebGPU
// convention: UV (0, 0) is top-left of the texture).
//
// Consumers (tonemap.wgsl and any future post-process pass) call this
// in their @vertex stage:
//   @vertex fn vs(@builtin(vertex_index) i : u32) -> FullscreenOutput {
//     return fullscreen_triangle(i);
//   }
//
// Keep the TS port in
// `packages/shader/src/__tests__/fullscreen-triangle.test.ts` in lockstep.

struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

fn fullscreen_triangle(vertex_index : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (vertex_index == 1u) {
    x = 3.0;
  }
  if (vertex_index == 2u) {
    y = 3.0;
  }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}
