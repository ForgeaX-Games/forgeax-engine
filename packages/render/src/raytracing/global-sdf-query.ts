import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { GlobalSdfComposition } from './global-sdf';
import {
  packReferenceRays,
  type RayReferenceError,
  type ReferenceRay,
  rayReferenceFailure,
} from './scene';

/** A frozen world region supplies approximate visibility, never a triangle or Card identity. */
export const GlobalSdfQueryStatus = {
  miss: 0,
  hit: 1,
  negativeStart: 2,
  stepBudget: 3,
  missingField: 4,
  outsideRegion: 5,
} as const;
export const GLOBAL_SDF_HIT_STRIDE = 64;
export interface GlobalSdfQuery {
  readonly rayCount: number;
  /** voxels/grid are borrowed; dispose releases only rays/hits/settings. */
  readonly buffers: Readonly<{
    voxels: Buffer;
    grid: Buffer;
    rays: Buffer;
    hits: Buffer;
    settings: Buffer;
  }>;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}

export const GLOBAL_SDF_QUERY_WGSL = `
struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct Voxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
// state: status, unavailable voxel status, steps, reserved.
// metrics: ray t, surface expansion, first sampled distance, geometry coverage.
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
struct Sample { distance: f32, coverage: f32, status: u32 }
@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage,read> rays: array<Ray>;
@group(0) @binding(3) var<storage,read_write> hits: array<Hit>;
@group(0) @binding(4) var<uniform> settings: vec4u;
fn sampleGlobal(p: vec3f) -> Sample {
 let dims=grid.dimensionsCount.xyz;
 let q=clamp((p-grid.originSpacing.xyz)/grid.originSpacing.w,vec3f(0),vec3f(dims-vec3u(1u)));
 let cell=vec3u(min(floor(q),vec3f(dims-vec3u(2u))));let f=q-vec3f(cell);
 var result=Sample(0,0,1u);
 for(var z=0u;z<2u;z++){for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
  let offset=vec3u(x,y,z);let w=select(vec3f(1)-f,f,offset>vec3u(0));let weight=w.x*w.y*w.z;
  if(weight>0.0){
   let c=cell+offset;let v=voxels[(c.z*dims.y+c.y)*dims.x+c.x];
   if(v.status!=1u){return Sample(0,0,v.status);}
   result.distance+=v.distance*weight;result.coverage+=v.coverage*weight;
  }
 }}}
 return result;
}
fn queryGlobal(ray: Ray) -> Hit {
 var result=Hit(vec4u(${GlobalSdfQueryStatus.miss}u,0,0,0),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
 if(ray.mask.x==0u){return result;}
 let h=grid.originSpacing.w*0.5;
 // Keep one stored sample border for hit-normal differences.
 let lo=grid.originSpacing.xyz+vec3f(grid.originSpacing.w);
 let hi=grid.originSpacing.xyz+vec3f(grid.dimensionsCount.xyz-vec3u(2u))*grid.originSpacing.w;
 let start=ray.origin+ray.direction*ray.tMin;
 if(any(start<lo)||any(start>hi)){
  result.state.x=${GlobalSdfQueryStatus.outsideRegion}u;result.metrics.x=ray.tMin;result.position=vec4f(start,1);return result;
 }
 var far=ray.tMax;
 for(var a=0u;a<3u;a++){
  if(ray.direction[a]>0.0){far=min(far,(hi[a]-ray.origin[a])/ray.direction[a]);}
  else if(ray.direction[a]<0.0){far=min(far,(lo[a]-ray.origin[a])/ray.direction[a]);}
 }
 let scale=max(abs(ray.direction.x),max(abs(ray.direction.y),abs(ray.direction.z)));
 let speed=scale*length(ray.direction/scale);
 var t=ray.tMin;var maxDistance=0.0;var expansion=0.0;
 for(var step=0u;step<settings.x;step++){
  result.state.z=step+1u;let p=ray.origin+ray.direction*t;let sample=sampleGlobal(p);
  result.metrics.x=t;result.position=vec4f(p,1);
  if(sample.status!=1u){result.state.x=${GlobalSdfQueryStatus.missingField}u;result.state.y=sample.status;return result;}
  if(step==0u){result.metrics.z=sample.distance;}
  result.metrics.w=sample.coverage;
  if(step==0u && sample.distance<0.0){result.state.x=${GlobalSdfQueryStatus.negativeStart}u;return result;}
  maxDistance=max(maxDistance,sample.distance);
  expansion=h*clamp(maxDistance/(2.0*h),0.0,1.0);result.metrics.y=expansion;
  if(sample.distance<expansion){
   t=clamp(t+(sample.distance-expansion)/speed,ray.tMin,far);
   let hitPosition=ray.origin+ray.direction*t;
   var gradient=vec3f(0);
   for(var a=0u;a<3u;a++){
    var offset=vec3f(0);offset[a]=h;
    let positive=sampleGlobal(hitPosition+offset);let negative=sampleGlobal(hitPosition-offset);
    if(positive.status!=1u || negative.status!=1u){
     result.state.x=${GlobalSdfQueryStatus.missingField}u;result.state.y=select(negative.status,positive.status,positive.status!=1u);return result;
    }
    gradient[a]=positive.distance-negative.distance;
   }
   result.state.x=${GlobalSdfQueryStatus.hit}u;result.metrics.x=t;result.position=vec4f(hitPosition,1);
   result.normal=vec4f(gradient/max(length(gradient),1e-20),0);return result;
  }
  let next=t+max(sample.distance,h*bitcast<f32>(settings.y))/speed;
  if(next<=t){result.state.x=${GlobalSdfQueryStatus.stepBudget}u;return result;}
  if(next>far){
   // Only a fully covered requested interval can report an approximate miss.
   result.state.x=select(${GlobalSdfQueryStatus.outsideRegion}u,${GlobalSdfQueryStatus.miss}u,far==ray.tMax);
   result.metrics.x=far;result.position=vec4f(ray.origin+ray.direction*far,1);return result;
  }
  t=next;
 }
 result.state.x=${GlobalSdfQueryStatus.stepBudget}u;return result;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x<arrayLength(&rays)){hits[id.x]=queryGlobal(rays[id.x]);}
}
`;

/** Caller records composition before query, retains its buffers, then retires both after submission. */
export async function createGlobalSdfQuery(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  composition: GlobalSdfComposition,
  rays: readonly ReferenceRay[],
  options: {
    readonly maxSteps?: number;
    /** Minimum advance relative to half spacing; lower values sample narrow field minima. */
    readonly minStepFactor?: number;
  } = {},
): Promise<Result<GlobalSdfQuery, RayReferenceError | RhiError>> {
  const packed = packReferenceRays(rays);
  if (!packed.ok) return packed;
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return rayReferenceFailure('global SDF query options must be an object');
  const maxSteps = options.maxSteps ?? 256;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1024)
    return rayReferenceFailure('global SDF query allows 1..1024 steps', true);
  const minStepFactor = Math.fround(options.minStepFactor ?? 1);
  if (
    !Number.isFinite(minStepFactor) ||
    minStepFactor <= 0 ||
    minStepFactor > 1 ||
    Math.fround(composition.grid.spacing * 0.5 * minStepFactor) < 2 ** -126
  )
    return rayReferenceFailure(
      'global SDF minimum step factor must be in (0, 1] and produce a normal f32 world advance',
    );
  if (
    composition.grid.dimensions.some((n) => n < 4) ||
    Math.fround(composition.grid.spacing * 0.5) <= 0
  )
    return rayReferenceFailure(
      'global SDF tracing requires 4..128 centers per axis and a finite positive half spacing',
    );
  if (
    rays.some(
      (r) =>
        (r.mask !== 0 && r.mask !== 255) ||
        // WGSL may flush subnormals. Validate the rounded inputs, including
        // intermediate products, before they can form an invalid sample position.
        !Number.isFinite(Math.fround(Math.hypot(...r.direction.map(Math.fround)))) ||
        Math.hypot(...r.direction.map(Math.fround)) < 2 ** -126 ||
        r.origin.some((origin, axis) =>
          [r.tMin, r.tMax].some(
            (t) =>
              !Number.isFinite(
                Math.fround(
                  Math.fround(origin) +
                    Math.fround(Math.fround(r.direction[axis] ?? 0) * Math.fround(t)),
                ),
              ),
          ),
        ),
    )
  )
    return rayReferenceFailure(
      'a composed world region requires mask 255 or 0, a finite normal f32 ray length and finite f32 endpoints',
    );
  const owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const buffer of owned) device.destroyBuffer(buffer);
    owned.length = 0;
  };
  const settings = new Uint8Array(16);
  const settingsView = new DataView(settings.buffer);
  settingsView.setUint32(0, maxSteps, true);
  settingsView.setFloat32(4, minStepFactor, true);
  const data = {
    rays: packed.value,
    hits: new Uint8Array(rays.length * GLOBAL_SDF_HIT_STRIDE),
    settings,
  };
  const buffers = {
    voxels: composition.buffers.voxels,
    grid: composition.buffers.settings,
  } as Record<keyof GlobalSdfQuery['buffers'], Buffer>;
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const bytes = data[key];
    const made = device.createBuffer({
      label: `global-sdf.query.${key}`,
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
  const fail = <T>(result: Result<never, T>) => {
    dispose();
    return result;
  };
  const shader = await compile(device, { code: GLOBAL_SDF_QUERY_WGSL, label: 'global-sdf.query' });
  if (!shader.ok) return fail(shader);
  const bgl = device.createBindGroupLayout({
    entries: [0, 1, 2, 3, 4].map((binding) => ({
      binding,
      visibility: 4,
      buffer: {
        type:
          binding === 1 || binding === 4
            ? 'uniform'
            : binding === 3
              ? 'storage'
              : 'read-only-storage',
      },
    })),
  });
  if (!bgl.ok) return fail(bgl);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!layout.ok) return fail(layout);
  const group = device.createBindGroup({
    layout: bgl.value,
    entries: [buffers.voxels, buffers.grid, buffers.rays, buffers.hits, buffers.settings].map(
      (buffer, binding) => ({ binding, resource: { kind: 'buffer' as const, value: { buffer } } }),
    ),
  });
  if (!group.ok) return fail(group);
  const pipeline = device.createComputePipeline({
    layout: layout.value,
    compute: { module: shader.value, entryPoint: 'main' },
  });
  if (!pipeline.ok) return fail(pipeline);
  return ok({
    buffers,
    rayCount: packed.value.byteLength / 48,
    dispose,
    record(encoder) {
      if (disposed) return rayReferenceFailure('global SDF query is disposed');
      const pass = encoder.beginComputePass({ label: 'global-sdf.query' });
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(packed.value.byteLength / 48 / 64));
      pass.end();
      return ok(undefined);
    },
  });
}
