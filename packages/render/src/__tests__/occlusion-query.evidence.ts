import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { GPU_TEXTURE_USAGE_RENDER_ATTACHMENT } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import {
  createOcclusionQueryResources,
  recordOcclusionResolve,
} from '../scene/visibility/occlusion-pass';
import { OcclusionQueryPool } from '../scene/visibility/occlusion-query-pool';
import { resolveEvidenceCommitIdentity } from './evidence-identity';

export interface OcclusionQueryEvidenceIdentity {
  readonly commit: string;
  readonly device: string;
  readonly view: string;
}

export interface OcclusionQueryDawnEvidence {
  readonly status: 'available' | 'unavailable';
  readonly identity: OcclusionQueryEvidenceIdentity;
  readonly zeroSamples: number;
  readonly positiveSamples: number;
  readonly outOfOrder: boolean;
  readonly staleVisible: boolean;
  readonly faultVisible: boolean;
  readonly reason?: string;
}

function identity(device: string): OcclusionQueryEvidenceIdentity {
  return {
    commit: resolveEvidenceCommitIdentity(),
    device,
    view: 'occlusion-query-evidence-view:main:1',
  };
}

function unavailable(reason: string): OcclusionQueryDawnEvidence {
  return {
    status: 'unavailable',
    identity: identity('webgpu-unavailable'),
    zeroSamples: 0,
    positiveSamples: 0,
    outOfOrder: false,
    staleVisible: true,
    faultVisible: true,
    reason,
  };
}

async function requestDevice(): Promise<RhiDevice | OcclusionQueryDawnEvidence> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) return unavailable(adapter.error.code);
  const device = await adapter.value.requestDevice();
  if (!device.ok) return unavailable(device.error.code);
  return device.value;
}

function lifecycleEvidence(): Pick<
  OcclusionQueryDawnEvidence,
  'outOfOrder' | 'staleVisible' | 'faultVisible'
> {
  const pool = new OcclusionQueryPool();
  const base = {
    viewKey: 'evidence-view',
    attachmentId: 'evidence-depth',
    deviceGeneration: 1,
    worldGeneration: 2,
    primitiveSlot: 0,
    slotGeneration: 1,
  };
  const first = pool.reserve({ ...base, primitiveSlot: 1 });
  const second = pool.reserve({ ...base, primitiveSlot: 2 });
  if (first === undefined || second === undefined) {
    return { outOfOrder: false, staleVisible: true, faultVisible: true };
  }
  const firstTicket = pool.publish(first, { submitted: true, submissionGeneration: 4 });
  const secondTicket = pool.publish(second, { submitted: true, submissionGeneration: 5 });
  if (firstTicket === undefined || secondTicket === undefined) {
    return { outOfOrder: false, staleVisible: true, faultVisible: true };
  }
  const secondCompletion = pool.complete(secondTicket, 3);
  const firstCompletion = pool.complete(firstTicket, 0);
  const staleCompletion = pool.complete({ ...firstTicket, slotGeneration: 99 }, 1);
  return {
    outOfOrder: secondCompletion.status === 'accepted' && firstCompletion.status === 'accepted',
    staleVisible: staleCompletion.visible,
    faultVisible: staleCompletion.visible,
  };
}

export async function runOcclusionQueryDawnEvidence(): Promise<OcclusionQueryDawnEvidence> {
  const requested = await requestDevice();
  if (!('createQuerySet' in requested)) return requested;
  const device = requested;
  const resourcesResult = createOcclusionQueryResources(device, 0);
  if (!resourcesResult.ok) return unavailable(resourcesResult.error.code);
  const resources = resourcesResult.value;

  const shader = await createShaderModule(device, {
    label: 'occlusion-query-evidence-shader',
    code: `
@vertex fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vertex], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`,
  });
  if (!shader.ok) return unavailable(shader.error.code);
  const pipeline = device.createRenderPipeline({
    label: 'occlusion-query-evidence-pipeline',
    layout: 'auto',
    vertex: { module: shader.value, entryPoint: 'vs', buffers: [] },
    fragment: {
      module: shader.value,
      entryPoint: 'fs',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipeline.ok) return unavailable(pipeline.error.code);
  const texture = device.createTexture({
    label: 'occlusion-query-evidence-target',
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  } as never);
  if (!texture.ok) return unavailable(texture.error.code);
  const view = device.createTextureView(texture.value, {});
  if (!view.ok) return unavailable(view.error.code);
  const encoder = device.createCommandEncoder({ label: 'occlusion-query-evidence-submit' });
  if (!encoder.ok) return unavailable(encoder.error.code);
  const pass = encoder.value.beginRenderPass({
    colorAttachments: [
      {
        view: view.value,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    occlusionQuerySet: resources.querySet,
  });
  const beginZero = pass.beginOcclusionQuery(0);
  if (!beginZero.ok) return unavailable(beginZero.error.code);
  const endZero = pass.endOcclusionQuery();
  if (!endZero.ok) return unavailable(endZero.error.code);
  const beginPositive = pass.beginOcclusionQuery(1);
  if (!beginPositive.ok) return unavailable(beginPositive.error.code);
  pass.setPipeline(pipeline.value);
  pass.draw(3);
  const endPositive = pass.endOcclusionQuery();
  if (!endPositive.ok) return unavailable(endPositive.error.code);
  pass.end();
  const resolved = recordOcclusionResolve(encoder.value, resources, 0, 2);
  if (!resolved.ok) return unavailable(resolved.error.code);
  const command = encoder.value.finish();
  if (!command.ok) return unavailable(command.error.code);
  const submitted = device.queue.submit([command.value]);
  if (!submitted.ok) return unavailable(submitted.error.code);
  await device.queue.onSubmittedWorkDone();
  const mapped = await resources.stagingBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ, 0, 16);
  if (!mapped.ok) return unavailable(mapped.error.code);
  const range = mapped.value.getMappedRange(0, 16);
  if (!range.ok) return unavailable(range.error.code);
  const values = new BigUint64Array(range.value.slice(0));
  const lifecycle = lifecycleEvidence();
  mapped.value.unmap();
  return {
    status: 'available',
    identity: identity('webgpu-dawn'),
    zeroSamples: Number(values[0] ?? 0n),
    positiveSamples: Number(values[1] ?? 0n),
    ...lifecycle,
  };
}
