import type { FieldVec3 } from '@forgeax/engine-geometry';
import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayGeometryKey, rayReferenceFailure } from './scene';
import { packSdfScene, SDF_SAMPLE_WGSL, type SdfMeshInstance, sdfInstanceKey } from './sdf-query';

export const GlobalSdfVoxelStatus = { unwritten: 0, complete: 1, missingField: 2 } as const;
export interface GlobalSdfGrid {
  readonly origin: FieldVec3;
  readonly dimensions: FieldVec3;
  readonly spacing: number;
  readonly maxDistance: number;
  readonly coverageDistance: number;
}
export interface GlobalSdfComposition {
  readonly grid: GlobalSdfGrid;
  readonly voxelCount: number;
  readonly sources: readonly {
    readonly instanceId: number;
    readonly key: string;
    /** Geometry/pose identity shared with Card capture, independent of field resolution. */
    readonly geometryKey: string;
  }[];
  readonly buffers: Readonly<{
    instances: Buffer;
    fields: Buffer;
    bounds: Buffer;
    settings: Buffer;
    voxels: Buffer;
  }>;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
// The output is a diagnostic composition, not a triangle hit or Card identity.
// Each voxel is { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }.
export const GLOBAL_SDF_VOXEL_STRIDE = 16;
const GLOBAL_SDF_COMPOSE_WGSL = `
${SDF_SAMPLE_WGSL}
struct ObjectBounds { lo: vec4f, hi: vec4f, scale: vec4f }
struct Settings { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct GlobalVoxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
@group(0) @binding(0) var<storage,read> instances: array<Instance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> bounds: array<ObjectBounds>;
@group(0) @binding(3) var<uniform> settings: Settings;
@group(0) @binding(4) var<storage,read_write> voxels: array<GlobalVoxel>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims=settings.dimensionsCount.xyz;
  let count=dims.x*dims.y*dims.z;if(gid.x>=count){return;}
  let cell=vec3u(gid.x%dims.x,(gid.x/dims.x)%dims.y,gid.x/(dims.x*dims.y));
  let world=settings.originSpacing.xyz+vec3f(cell)*settings.originSpacing.w;
  var distance=settings.ranges.x;var nearest=0xffffffffu;var missing=false;
  var oneSided=false;var twoSided=false;
  for(var i=0u;i<settings.dimensionsCount.w;i++){
    let m=instances[i];if(m.ids.w==0u){continue;}
    let b=bounds[i];let p=(m.inverse*vec4f(world,1)).xyz;
    let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
    let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
    if(boxDistance>=settings.ranges.x){continue;}
    if(m.field.x==0xffffffffu){missing=true;continue;}
    let local=sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz));
    let candidate=max(local*b.scale.w+max(boxDistance,0.0),boxDistance);
    if(candidate<distance||(candidate==distance&&candidate<settings.ranges.x&&m.ids.x<nearest)){
      distance=candidate;nearest=m.ids.x;
    }
    if(abs(candidate)<settings.ranges.y){
      if(b.lo.w>0.5){twoSided=true;}else{oneSided=true;}
    }
  }
  let coverage=select(1.0,0.0,twoSided&&!oneSided);
  voxels[gid.x]=GlobalVoxel(clamp(distance,-settings.ranges.x,settings.ranges.x),coverage,select(${GlobalSdfVoxelStatus.complete}u,${GlobalSdfVoxelStatus.missingField}u,missing),nearest);
}
`;

/** Frozen, single-region mesh-to-world composition. No residency, ray tracing, or GI publication. */
export async function createGlobalSdfComposition(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  source: readonly SdfMeshInstance[],
  grid: GlobalSdfGrid,
): Promise<Result<GlobalSdfComposition, RayReferenceError | RhiError>> {
  const numeric = [...grid.origin, grid.spacing, grid.maxDistance, grid.coverageDistance];
  if (
    grid.origin.length !== 3 ||
    grid.dimensions.length !== 3 ||
    !numeric.every((v) => Number.isFinite(Math.fround(v))) ||
    Math.fround(grid.spacing) <= 0 ||
    Math.fround(grid.maxDistance) <= 0 ||
    grid.coverageDistance < 0 ||
    grid.coverageDistance > grid.maxDistance ||
    grid.dimensions.some((v) => !Number.isInteger(v) || v < 1 || v > 128)
  )
    return rayReferenceFailure(
      'global SDF requires finite origin, positive spacing/range, 0..maxDistance coverage and 1..128 samples per axis',
    );
  // Match the f32 inputs used by WGSL, including rounding of its multiply.
  // Checking every center is bounded to 384 scalar samples and catches loss
  // of spacing at the far end of a grid crossing an f32 exponent boundary.
  for (let a = 0; a < 3; a++) {
    let previous = -Infinity;
    for (let i = 0; i < (grid.dimensions[a] ?? 0); i++) {
      const center = Math.fround(
        Math.fround(grid.origin[a] ?? 0) + Math.fround(i * Math.fround(grid.spacing)),
      );
      if (!Number.isFinite(center) || center <= previous)
        return rayReferenceFailure(
          'global SDF sample centers must remain distinct finite f32 positions',
        );
      previous = center;
    }
  }
  const packed = packSdfScene(source, 1024);
  if (!packed.ok) return packed;
  const sources = source.map((m) => ({
    instanceId: m.instanceId,
    key: sdfInstanceKey(m),
    geometryKey: rayGeometryKey(m, 'missing' in m.field ? 'missing' : m.field.meshDigest),
  }));
  const objectBytes = new Uint8Array(Math.max(1, source.length) * 48),
    view = new DataView(objectBytes.buffer);
  for (const [i, m] of source.entries()) {
    const t = Array.from(m.transform, Math.fround);
    const axes = [0, 4, 8].map((a) => [t[a] ?? 0, t[a + 1] ?? 0, t[a + 2] ?? 0]);
    const scales = axes.map((a) => Math.hypot(...a));
    if (
      !scales.every((v) => Math.fround(v) > 0 && Number.isFinite(Math.fround(v))) ||
      ![...m.field.bounds.min, ...m.field.bounds.max].every((v) => Number.isFinite(Math.fround(v)))
    )
      return rayReferenceFailure(
        'global SDF bounds and transform scales must be finite f32 values',
      );
    for (let a = 0; a < 3; a++)
      for (let b = a + 1; b < 3; b++) {
        const x = axes[a],
          y = axes[b];
        if (!x || !y) return rayReferenceFailure('missing transform axis');
        const dot = x.reduce((n, v, k) => n + v * (y[k] ?? 0), 0);
        if (Math.abs(dot) > 1e-5 * (scales[a] ?? 0) * (scales[b] ?? 0))
          return rayReferenceFailure(
            'global SDF composition requires orthogonal transform axes; shear is not qualified',
            true,
          );
      }
    const b =
      !('missing' in m.field) && m.field.policy.kind === 'sampled-visibility'
        ? m.field.policy.traceBounds
        : m.field.bounds;
    [
      ...b.min,
      'missing' in m.field
        ? 0
        : Number(
            m.field.policy.kind === 'sampled-visibility'
              ? m.field.policy.mostlyTwoSided
              : m.field.policy.kind === 'two-sided',
          ),
      ...b.max,
      0,
      ...scales,
      Math.min(...scales),
    ].forEach((v, k) => {
      view.setFloat32(i * 48 + k * 4, v, true);
    });
  }
  const frozen: GlobalSdfGrid = {
    origin: [Math.fround(grid.origin[0]), Math.fround(grid.origin[1]), Math.fround(grid.origin[2])],
    dimensions: [...grid.dimensions],
    spacing: Math.fround(grid.spacing),
    maxDistance: Math.fround(grid.maxDistance),
    coverageDistance: Math.fround(grid.coverageDistance),
  };
  const count = grid.dimensions[0] * grid.dimensions[1] * grid.dimensions[2];
  const settings = new Uint8Array(48),
    sv = new DataView(settings.buffer);
  [...frozen.origin, frozen.spacing].forEach((v, i) => {
    sv.setFloat32(i * 4, v, true);
  });
  [...frozen.dimensions, source.length].forEach((v, i) => {
    sv.setUint32(16 + i * 4, v, true);
  });
  sv.setFloat32(32, frozen.maxDistance, true);
  sv.setFloat32(36, frozen.coverageDistance, true);
  const data = {
    instances: packed.value.instances,
    fields: packed.value.fields,
    bounds: objectBytes,
    settings,
    voxels: new Uint8Array(count * GLOBAL_SDF_VOXEL_STRIDE),
  };
  const buffers = {} as Record<keyof typeof data, Buffer>,
    owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
  };
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const bytes = data[key];
    const made = device.createBuffer({
      label: `global-sdf.${key}`,
      size: bytes.byteLength,
      usage: (key === 'settings' ? 64 : 128) | 12,
    });
    if (!made.ok) {
      dispose();
      return made;
    }
    buffers[key] = made.value;
    owned.push(made.value);
    const wrote = device.queue.writeBuffer(made.value, 0, bytes);
    if (!wrote.ok) {
      dispose();
      return wrote;
    }
  }
  const shader = await compile(device, {
    code: GLOBAL_SDF_COMPOSE_WGSL,
    label: 'global-sdf.compose',
  });
  if (!shader.ok) {
    dispose();
    return shader;
  }
  const bgl = device.createBindGroupLayout({
    entries: [0, 1, 2, 3, 4].map((binding) => ({
      binding,
      visibility: 4,
      buffer: { type: binding === 3 ? 'uniform' : binding === 4 ? 'storage' : 'read-only-storage' },
    })),
  });
  if (!bgl.ok) {
    dispose();
    return bgl;
  }
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!layout.ok) {
    dispose();
    return layout;
  }
  const group = device.createBindGroup({
    layout: bgl.value,
    entries: Object.values(buffers).map((buffer, binding) => ({
      binding,
      resource: { kind: 'buffer' as const, value: { buffer } },
    })),
  });
  if (!group.ok) {
    dispose();
    return group;
  }
  const pipeline = device.createComputePipeline({
    layout: layout.value,
    compute: { module: shader.value, entryPoint: 'main' },
  });
  if (!pipeline.ok) {
    dispose();
    return pipeline;
  }
  return ok({
    grid: frozen,
    voxelCount: count,
    sources,
    buffers,
    record(encoder) {
      if (disposed) return rayReferenceFailure('global SDF composition is disposed');
      const pass = encoder.beginComputePass({ label: 'global-sdf.compose' });
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      return ok(undefined);
    },
    dispose,
  });
}
