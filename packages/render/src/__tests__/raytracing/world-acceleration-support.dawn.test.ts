import { mkdirSync, writeFileSync } from 'node:fs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RAY_QUERY_FEATURE, type RhiCommandEncoder, type Tlas } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import {
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
} from '../../raytracing/irradiance-field';
import { addWorldAccelerationPass } from '../../raytracing/irradiance-field-graph';
import { kernelGraphAccess, resolveKernelBinding } from '../../raytracing/kernel-graph-access';
import { prepareWorldAcceleration } from '../../raytracing/renderer-world-acceleration';
import { WORLD_TRAVERSAL_ROSTER, worldTraversalWgsl } from '../../raytracing/world-traversal';
import { readBuffer } from './path-tracer.fixture';

// Dawn has no native Ray Query extension. The native workflow runs this gate
// explicitly; a native device without the feature is a failure, never a skip.
it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'rejects incomplete world traversal across budgeted builds, edits and failed-submit recovery',
  async () => {
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
    ).unwrap();
    const raw = webgpu._internal_getRawDevice(device);
    if (!raw) throw new Error('native traversal support requires the real device');
    const errors: string[] = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const transform = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const geometry = (geometryId: number) => ({
      geometryId,
      positions: new Float32Array([-1, -1, -2, 1, -1, -2, 0, 1, -2]),
    });
    const instance = (id: number, x: number) => ({
      instanceId: id,
      geometryId: id,
      mask: 255,
      transform: transform(x),
    });
    const instances = Array.from({ length: 5 }, (_, i) => instance(i, i === 4 ? 0 : 20));
    const lane = prepareWorldAcceleration(
      device,
      { instances },
      instances.map((i) => geometry(i.geometryId)),
      { instances: 10, triangles: 5 },
    ).unwrap();
    const output = device.createBuffer({ size: 512, usage: 128 | 4 }).unwrap();
    // The first ray crosses only the fifth, initially absent mesh; the second
    // hits resident geometry; the third misses a complete scene.
    const rays = device.createBuffer({ size: 3 * 48, usage: 128 | 8 }).unwrap();
    const data = new ArrayBuffer(3 * 48);
    const f = new Float32Array(data),
      u = new Uint32Array(data);
    for (const [i, x] of [0, 20, 40].entries()) {
      f.set([x, 0, 0, 0, 0, 0, -1, 4], i * 12);
      u[i * 12 + 8] = 255;
    }
    device.queue.writeBuffer(rays, 0, new Uint8Array(data)).unwrap();
    const source = worldTraversalWgsl('ray-query');
    const coverageGuard = ` if(traversalInstances[0].x!=0u){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}`;
    expect(source.split(coverageGuard)).toHaveLength(2);
    // FALSIFY: the same real scene with only its coverage rejection removed.
    // Partial TLAS hits and misses must disagree with the complete-world contract.
    const modules = [];
    for (const code of [source, source.replace(coverageGuard, '')]) {
      modules.push(
        (
          await webgpu.createShaderModule(device, {
            code: `${code}
@group(0) @binding(7) var<storage,read> rays: array<Ray>;
@group(0) @binding(8) var<storage,read_write> hits: array<Hit>;
@compute @workgroup_size(1) fn verifyWorldSupport(@builtin(global_invocation_id) id:vec3u) {
  if(id.x<arrayLength(&rays)){hits[id.x]=traceWorld(rays[id.x],256u,1.0);}
}`,
          })
        ).unwrap(),
      );
    }
    const roster = WORLD_TRAVERSAL_ROSTER['ray-query'];
    const layout = device
      .createBindGroupLayout({
        entries: [
          ...roster.map(([binding, kind]) =>
            kind === 'tlas'
              ? { binding, visibility: 4, accelerationStructure: {} }
              : { binding, visibility: 4, buffer: { type: 'read-only-storage' as const } },
          ),
          { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 8, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const pipelines = modules.map((module) =>
      device
        .createComputePipeline({
          layout: pipelineLayout,
          compute: { module, entryPoint: 'verifyWorldSupport' },
        })
        .unwrap(),
    );
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const field = device
      .createBuffer({ size: IRRADIANCE_FIELD_UNIFORM_BYTES, usage: 64 | 12 })
      .unwrap();
    const fieldHandle = graph
      .importBuffer(
        'support.field',
        { size: IRRADIANCE_FIELD_UNIFORM_BYTES, usage: 64 | 12 },
        () => field,
      )
      .unwrap();
    const world = addWorldAccelerationPass(graph, lane, () => lane, fieldHandle).unwrap();
    const worldHandle = (name: keyof typeof world) => {
      const handle = world[name];
      if (handle === undefined) throw new Error(`missing native world ${name}`);
      return handle;
    };
    const destination = graph
      .importBuffer('support.hits', { size: 512, usage: 128 | 4 }, () => output)
      .unwrap();
    const input = graph
      .importBuffer('support.rays', { size: 3 * 48, usage: 128 | 8 }, () => rays)
      .unwrap();
    graph
      .addComputePass('support.trace', {
        accesses: [
          ...roster.map(([, kind, name]) =>
            kernelGraphAccess(kind, worldHandle(name as keyof typeof world), 'storage-write'),
          ),
          { resource: input, usage: 'storage-read' },
          { resource: destination, usage: 'storage-write' },
        ],
        encode: ({ pass, resources }) => {
          for (const [control, pipeline] of pipelines.entries()) {
            const group = device
              .createBindGroup({
                layout,
                entries: [
                  ...roster.map(([binding, kind, name]) => ({
                    binding,
                    resource:
                      kind === 'tlas'
                        ? {
                            kind: 'accelerationStructure' as const,
                            value: resolveKernelBinding(
                              resources,
                              kind,
                              worldHandle(name as keyof typeof world),
                            ) as Tlas,
                          }
                        : {
                            kind: 'buffer' as const,
                            value: resolveKernelBinding(
                              resources,
                              kind,
                              worldHandle(name as keyof typeof world),
                            ) as { buffer: typeof output },
                          },
                  })),
                  {
                    binding: 7,
                    resource: {
                      kind: 'buffer',
                      value: { buffer: resources.buffer(input).unwrap() },
                    },
                  },
                  {
                    binding: 8,
                    resource: {
                      kind: 'buffer',
                      value: {
                        buffer: resources.buffer(destination).unwrap(),
                        offset: control * 256,
                        size: 3 * 64,
                      },
                    },
                  },
                ],
              })
              .unwrap();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(3);
          }
        },
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const result: {
      status: string;
      frames: {
        name: string;
        states: number[];
        withoutCoverageGuard: number[];
        instances: number[];
        pending: number;
        sampledPending: number;
      }[];
      errors: string[];
      failure?: string;
    } = { status: 'running', frames: [], errors };
    const frame = async (name: string, expected: number[]) => {
      const encoder = device.createCommandEncoder({}).unwrap();
      compiled.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      lane.track(device.queue.onSubmittedWorkDone());
      lane.commit();
      const bytes = await readBuffer(device, output, 512),
        words = new DataView(bytes.buffer);
      const states = [0, 1, 2].map((i) => words.getUint32(i * 64, true));
      const withoutCoverageGuard = [0, 1, 2].map((i) => words.getUint32(256 + i * 64, true));
      const uniform = await readBuffer(device, field, IRRADIANCE_FIELD_UNIFORM_BYTES);
      const sampledPending = new DataView(uniform.buffer).getUint32(
        IRRADIANCE_FIELD_PENDING_OFFSET,
        true,
      );
      result.frames.push({
        name,
        states,
        withoutCoverageGuard,
        instances: [0, 1, 2].map((i) => words.getUint32(i * 64 + 12, true)),
        pending: lane.inspect().pending,
        sampledPending,
      });
      expect(states, name).toEqual(expected);
      if (lane.inspect().pending > 0) {
        expect(withoutCoverageGuard, `${name}:FALSIFY partial world`).toEqual([
          GlobalSdfQueryStatus.miss,
          GlobalSdfQueryStatus.hit,
          GlobalSdfQueryStatus.miss,
        ]);
        expect(withoutCoverageGuard, `${name}:FALSIFY must reject`).not.toEqual(states);
      } else {
        expect(withoutCoverageGuard, `${name}:complete world control`).toEqual(states);
      }
      expect(sampledPending, `${name}:shared sampler coverage`).toBe(lane.inspect().pending);
    };
    const missing = Array(3).fill(GlobalSdfQueryStatus.missingField);
    const complete = [
      GlobalSdfQueryStatus.hit,
      GlobalSdfQueryStatus.hit,
      GlobalSdfQueryStatus.miss,
    ];
    try {
      await frame('cold-budget', missing);
      await frame('cold-complete', complete);
      expect(result.frames[1]?.instances[0]).toBe(4);
      lane.edit({ moved: [{ index: 4, to: transform(20) }], removed: [], added: [] }).unwrap();
      await frame('moved-blocker', [
        GlobalSdfQueryStatus.miss,
        GlobalSdfQueryStatus.hit,
        GlobalSdfQueryStatus.miss,
      ]);
      lane
        .edit({
          moved: [],
          removed: [],
          added: Array.from({ length: 5 }, (_, i) => ({
            instance: instance(i + 5, i === 4 ? 0 : 20),
            geometry: geometry(i + 5),
          })),
        })
        .unwrap();
      await frame('added-budget', missing);
      const old = lane.current().tlas;
      // Encode the completion but abandon it before submit or commit.
      compiled.execute({ encoder: device.createCommandEncoder({}).unwrap() }).unwrap();
      await frame('failed-submit-recovery', missing);
      expect(lane.current().tlas).not.toBe(old);
      await frame('recovery-budget', missing);
      await frame('recovery-complete', complete);
      expect(result.frames.at(-1)?.instances[0]).toBe(9);
      lane.edit({ moved: [], removed: [{ index: 9 }], added: [] }).unwrap();
      await frame('removed-blocker', [
        GlobalSdfQueryStatus.miss,
        GlobalSdfQueryStatus.hit,
        GlobalSdfQueryStatus.miss,
      ]);
      expect(errors).toEqual([]);
      result.status = 'pass';
    } catch (cause) {
      result.status = 'fail';
      result.failure = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      const directory = 'artifacts/irradiance-field/native-world-support';
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/result.json`, JSON.stringify(result, null, 2));
      await compiled.retire();
      lane.dispose();
      device.destroyBuffer(rays).unwrap();
      device.destroyBuffer(output).unwrap();
      device.destroyBuffer(field).unwrap();
      raw.destroy();
    }
  },
  120000,
);
