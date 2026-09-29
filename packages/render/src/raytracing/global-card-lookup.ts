import type {
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  CARD_LOOKUP_STRIDE,
  CARD_LOOKUP_WGSL,
  CardLookupStatus,
  packCardLookupProjections,
} from './card-lookup';
import type { GlobalSdfComposition } from './global-sdf';
import { type GlobalSdfQuery, GlobalSdfQueryStatus } from './global-sdf-query';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import { SDF_SAMPLE_WGSL } from './sdf-query';
import { CARD_TEXTURES, type SurfaceCapture, type SurfaceCardSource } from './surface-cards';

/** meta = retained count, refusal flags, query status, admitted count; then four instance IDs. */
export const GLOBAL_CARD_CANDIDATE_STRIDE = 32;
export const GlobalCardCandidateFlags = { missingField: 1, overflow: 2, invalidNormal: 4 } as const;
export interface GlobalSdfCardLookup {
  /** Four independent CARD_LOOKUP_STRIDE entries per ray, in candidate order. No blended material identity. */
  readonly buffer: Buffer;
  readonly candidateBuffer: Buffer;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}

const WGSL = `
${SDF_SAMPLE_WGSL}
struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct ObjectBounds { lo: vec4f, hi: vec4f, scale: vec4f }
struct Candidates { state: vec4u, ids: vec4u }
@group(0) @binding(0) var<storage,read> hits: array<SdfHit>;
@group(0) @binding(1) var<storage,read> instances: array<Instance>;
@group(0) @binding(2) var<storage,read> fields: array<u32>;
@group(0) @binding(3) var<storage,read> bounds: array<ObjectBounds>;
@group(0) @binding(4) var<uniform> grid: Grid;
@group(0) @binding(5) var<storage,read_write> candidates: array<Candidates>;
@group(0) @binding(6) var<storage,read> cards: array<Card>;
@group(0) @binding(7) var<storage,read_write> output: array<Lookup>;
@group(0) @binding(8) var<uniform> settings: vec4u;
@group(0) @binding(9) var albedo: texture_2d<f32>;
@group(0) @binding(10) var normal: texture_2d<f32>;
@group(0) @binding(11) var emission: texture_2d<f32>;
@group(0) @binding(12) var f0: texture_2d<f32>;
@group(0) @binding(13) var cardDepth: texture_depth_2d;
${CARD_LOOKUP_WGSL}
fn findCandidates(hit: SdfHit) -> Candidates {
 var out=Candidates(vec4u(0,0,hit.state.x,0),vec4u(0xffffffffu));
 if(hit.state.x!=${GlobalSdfQueryStatus.hit}u){return out;}
 if(dot(hit.normal.xyz,hit.normal.xyz)<0.5){out.state.y=${GlobalCardCandidateFlags.invalidNormal}u;return out;}
 let halfSpacing=grid.originSpacing.w*0.5;
 let world=hit.position.xyz+hit.normal.xyz*halfSpacing;
 // Association support only: this radius is not a bound on geometric error.
 let radius=3.0*halfSpacing;
 var distances=vec4f(3.402823466e+38);
 for(var i=0u;i<grid.dimensionsCount.w;i++){
  let m=instances[i];if(m.ids.w==0u){continue;}
  let b=bounds[i];let p=(m.inverse*vec4f(world,1)).xyz;
  let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
  let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
  if(boxDistance>=radius){continue;}
  if(m.field.x==0xffffffffu){out.state.y|=${GlobalCardCandidateFlags.missingField}u;continue;}
  let distance=max(sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz))*b.scale.w+max(boxDistance,0.0),boxDistance);
  if(abs(distance)>=radius){continue;}
  out.state.w++;
  // Signed-distance ordering with stable instance-ID ties, independent of roster order.
  var slot=4u;
  for(var k=0u;k<4u;k++){
   if(distance<distances[k]||(distance==distances[k]&&m.ids.x<out.ids[k])){slot=k;break;}
  }
  if(slot<4u){
   for(var k=3u;k>slot;k--){distances[k]=distances[k-1u];out.ids[k]=out.ids[k-1u];}
   distances[slot]=distance;out.ids[slot]=m.ids.x;
  }
 }
 out.state.x=min(out.state.w,4u);
 if(out.state.w>4u){out.state.y|=${GlobalCardCandidateFlags.overflow}u;}
 return out;
}
@compute @workgroup_size(64) fn selectCandidates(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x<arrayLength(&hits)){candidates[gid.x]=findCandidates(hits[gid.x]);}
}
@compute @workgroup_size(64) fn sampleCards(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=arrayLength(&hits)){return;}
 let hit=hits[gid.x];let c=candidates[gid.x];
 for(var k=0u;k<4u;k++){
  var sample=Lookup(vec4u(${CardLookupStatus.notSurface}u,hit.state.x,0xffffffffu,c.ids[k]),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
  if(hit.state.x==${GlobalSdfQueryStatus.hit}u){sample.state.x=${CardLookupStatus.unmapped}u;}
  if(k<c.state.x&&c.state.y==0u){
   // UE offsets the object-grid query; its executed Card lookup uses the original hit position.
   sample=lookupCardPoint(hit.position.xyz,hit.normal.xyz,c.ids[k],grid.originSpacing.w*1.5,hit.state.x,settings.x,settings.y);
  }
  output[gid.x*4u+k]=sample;
 }
}
`;

/** Frozen association diagnostic. Borrowed composition/query/cache must outlive the submitted work. */
export async function createGlobalSdfCardLookup(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  composition: GlobalSdfComposition,
  query: GlobalSdfQuery,
  cache: SurfaceCapture,
  expected: readonly SurfaceCardSource[],
): Promise<Result<GlobalSdfCardLookup, RayReferenceError | RhiError>> {
  if (cache.kind !== 'cards')
    return rayReferenceFailure('global Card lookup requires an offline card layout');
  if (
    query.buffers.voxels !== composition.buffers.voxels ||
    query.buffers.grid !== composition.buffers.settings
  )
    return rayReferenceFailure(
      'global Card lookup requires the composition that produced the query',
    );
  const { bytes, count } = packCardLookupProjections(
    cache,
    composition.sources.map((s) => ({ instanceId: s.instanceId, key: s.geometryKey })),
    expected,
  );
  const owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
  };
  const fail = <E>(r: Result<never, E>) => {
    dispose();
    return r;
  };
  const make = (name: string, data: Uint8Array, uniform = false) => {
    const b = device.createBuffer({
      label: `global-sdf.cards.${name}`,
      size: data.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!b.ok) return b;
    owned.push(b.value);
    const w = device.queue.writeBuffer(b.value, 0, data);
    return w.ok ? b : w;
  };
  const projections = make('projections', bytes);
  if (!projections.ok) return fail(projections);
  const candidates = make(
    'candidates',
    new Uint8Array(query.rayCount * GLOBAL_CARD_CANDIDATE_STRIDE),
  );
  if (!candidates.ok) return fail(candidates);
  const output = make('samples', new Uint8Array(query.rayCount * 4 * CARD_LOOKUP_STRIDE));
  if (!output.ok) return fail(output);
  const settings = make(
    'settings',
    new Uint8Array(new Uint32Array([count, cache.resolution, 0, 0]).buffer),
    true,
  );
  if (!settings.ok) return fail(settings);
  const views = [];
  for (const name of CARD_TEXTURES) {
    const v = device.createTextureView(cache.textures[name], {});
    if (!v.ok) return fail(v);
    views.push(v.value);
  }
  const bgl = device.createBindGroupLayout({
    entries: Array.from({ length: 14 }, (_, binding) => ({
      binding,
      visibility: 4,
      ...(binding >= 9
        ? {
            texture: {
              sampleType: binding === 13 ? ('depth' as const) : ('unfilterable-float' as const),
            },
          }
        : {
            buffer: {
              type:
                binding === 4 || binding === 8
                  ? ('uniform' as const)
                  : binding === 5 || binding === 7
                    ? ('storage' as const)
                    : ('read-only-storage' as const),
            },
          }),
    })),
  });
  if (!bgl.ok) return fail(bgl);
  const group = device.createBindGroup({
    layout: bgl.value,
    entries: [
      ...[
        query.buffers.hits,
        composition.buffers.instances,
        composition.buffers.fields,
        composition.buffers.bounds,
        composition.buffers.settings,
        candidates.value,
        projections.value,
        output.value,
        settings.value,
      ].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer } },
      })),
      ...views.map((value, i) => ({
        binding: 9 + i,
        resource: { kind: 'textureView' as const, value },
      })),
    ],
  });
  if (!group.ok) return fail(group);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!layout.ok) return fail(layout);
  const shader = await compile(device, { code: WGSL, label: 'global-sdf.cards' });
  if (!shader.ok) return fail(shader);
  const pipelines: { entryPoint: string; pipeline: ComputePipeline }[] = [];
  for (const entryPoint of ['selectCandidates', 'sampleCards']) {
    const pipeline = device.createComputePipeline({
      layout: layout.value,
      compute: { module: shader.value, entryPoint },
    });
    if (!pipeline.ok) return fail(pipeline);
    pipelines.push({ entryPoint, pipeline: pipeline.value });
  }
  return ok({
    buffer: output.value,
    candidateBuffer: candidates.value,
    dispose,
    record(encoder) {
      if (disposed) return rayReferenceFailure('global Card lookup is disposed');
      for (const { entryPoint, pipeline } of pipelines) {
        const pass = encoder.beginComputePass({ label: `global-sdf.cards.${entryPoint}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group.value);
        pass.dispatchWorkgroups(Math.ceil(query.rayCount / 64));
        pass.end();
      }
      return ok(undefined);
    },
  });
}
