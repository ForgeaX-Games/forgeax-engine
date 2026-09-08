// @forgeax/engine-rhi-debug/src/recorder/closure -- transitive handle closure owner.

import type { HandleId, RhiCallEvent } from '../types';

export function _collectFrameReferencedHandleIds(events: readonly RhiCallEvent[]): Set<HandleId> {
  const refs = new Set<HandleId>();
  for (const e of events) {
    switch (e.kind) {
      case 'writeBuffer':
      case 'clearBuffer':
      // initialData seeds a pre-arm resource's bytes; its handleId must be
      // prefix-pulled so the resource's create* event lands in the bootstrap
      // closure (otherwise the tape references a handle with no create event ->
      // tape-invalid on deserialize).
      case 'initialData': {
        const we = e as { handleId: HandleId };
        refs.add(we.handleId);
        break;
      }
      case 'setVertexBuffer': {
        const we = e as { passHandleId: HandleId; bufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.bufferHandleId);
        break;
      }
      case 'setIndexBuffer': {
        const we = e as { passHandleId: HandleId; bufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.bufferHandleId);
        break;
      }
      case 'setPipeline': {
        const we = e as { passHandleId: HandleId; pipelineHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.pipelineHandleId);
        break;
      }
      case 'setComputePipeline': {
        const we = e as { passHandleId: HandleId; pipelineHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.pipelineHandleId);
        break;
      }
      case 'setBindGroup': {
        const we = e as { passHandleId: HandleId; bindGroupHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.bindGroupHandleId);
        break;
      }
      case 'draw': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'drawIndexed': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setViewport': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setScissorRect': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setBlendConstant': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'setStencilReference': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'drawIndirect': {
        const we = e as { passHandleId: HandleId; indirectBufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.indirectBufferHandleId);
        break;
      }
      case 'drawIndexedIndirect': {
        const we = e as { passHandleId: HandleId; indirectBufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.indirectBufferHandleId);
        break;
      }
      case 'passPushDebugGroup': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'passPopDebugGroup': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'passInsertDebugMarker': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'endRenderPass': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'dispatchWorkgroups': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'dispatchWorkgroupsIndirect': {
        const we = e as { passHandleId: HandleId; indirectBufferHandleId: HandleId };
        refs.add(we.passHandleId);
        refs.add(we.indirectBufferHandleId);
        break;
      }
      case 'endComputePass': {
        const we = e as { passHandleId: HandleId };
        refs.add(we.passHandleId);
        break;
      }
      case 'submit': {
        const we = e as { cmdHandleIds: readonly HandleId[] };
        for (const id of we.cmdHandleIds) refs.add(id);
        break;
      }
      case 'beginRenderPass': {
        const we = e as {
          cmdHandleId: HandleId;
          colorAttachmentViewHandleIds: readonly (HandleId | undefined)[];
          depthStencilViewHandleId?: HandleId;
        };
        refs.add(we.cmdHandleId);
        for (const vhId of we.colorAttachmentViewHandleIds) {
          if (vhId !== undefined) refs.add(vhId);
        }
        if (we.depthStencilViewHandleId !== undefined) refs.add(we.depthStencilViewHandleId);
        break;
      }
      case 'beginComputePass': {
        const we = e as { cmdHandleId: HandleId };
        refs.add(we.cmdHandleId);
        break;
      }
      case 'finish': {
        const we = e as { cmdHandleId: HandleId };
        refs.add(we.cmdHandleId);
        break;
      }
      case 'pushDebugGroup':
      case 'popDebugGroup':
      case 'insertDebugMarker': {
        const we = e as { cmdHandleId: HandleId };
        refs.add(we.cmdHandleId);
        break;
      }
      case 'writeTexture': {
        const we = e as { destination: { textureHandleId: HandleId } };
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'copyExternalImageToTexture': {
        const we = e as { destination: { textureHandleId: HandleId } };
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'copyBufferToBuffer': {
        const we = e as { sourceHandleId: HandleId; destinationHandleId: HandleId };
        refs.add(we.sourceHandleId);
        refs.add(we.destinationHandleId);
        break;
      }
      case 'copyBufferToTexture': {
        const we = e as {
          source: { bufferHandleId: HandleId };
          destination: { textureHandleId: HandleId };
        };
        refs.add(we.source.bufferHandleId);
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'copyTextureToBuffer': {
        const we = e as {
          source: { textureHandleId: HandleId };
          destination: { bufferHandleId: HandleId };
        };
        refs.add(we.source.textureHandleId);
        refs.add(we.destination.bufferHandleId);
        break;
      }
      case 'copyTextureToTexture': {
        const we = e as {
          source: { textureHandleId: HandleId };
          destination: { textureHandleId: HandleId };
        };
        refs.add(we.source.textureHandleId);
        refs.add(we.destination.textureHandleId);
        break;
      }
      case 'createBindGroup':
      case 'createPipelineLayout':
      case 'createRenderPipeline':
      case 'createComputePipeline':
      case 'createTextureView': {
        // An in-frame-created resource may reference a PRE-ARM resource via its
        // backward edges (e.g. a composite/FXAA bind group built mid-frame that
        // samples a scratch TextureView created at setup; or an in-frame
        // createTextureView of a pre-arm texture). Those pre-arm handles are
        // reachable ONLY through this create* event's backward refs — no usage
        // event names them directly — so without collecting them here they never
        // become prefix seeds and the tape deserializes as non-self-contained
        // (tape-invalid). Collect the edges; getTape's prefixSeedIds
        // filter then drops entries that are themselves in-frame declared, leaving
        // only the genuinely pre-arm dependencies to seed the bootstrap closure.
        for (const ref of _getCreateEventReferencedHandleIds(e)) refs.add(ref);
        break;
      }
      case 'destroyBuffer':
      case 'destroyTexture':
        refs.add(e.handleId);
        break;
      case 'frameMark':
      case 'createBuffer':
      case 'createTexture':
      case 'createSampler':
      case 'createBindGroupLayout':
      case 'createShaderModule':
      case 'createCommandEncoder':
        // Leaf declaration events — no backward references to collect.
        break;
      default: {
        // Exhaustiveness guard: if a new RhiCallEvent member is added to the
        // union without a corresponding handle-collection case, tsc fails here.
        // This prevents silent omission of handle references (tape-invalid).
        const _exhaustive: never = e;
        void _exhaustive;
        break;
      }
    }
  }
  return refs;
}

/**
 * @internal
 * Return handleIds referenced by a create* event for transitive closure traversal.
 *
 * The edge set follows D-3 (plan-strategy 2):
 *   - createBindGroup → layoutHandleId + resourceHandleIds
 *   - createPipelineLayout → bglHandleIds
 *   - createRenderPipeline → layoutHandleId (if != 'layout:auto') + vertex/fragmentShaderModuleHandleId (R-1)
 *   - createComputePipeline → layoutHandleId (if != 'layout:auto') + computeShaderModuleHandleId (R-1)
 *   - createTextureView → sourceHandleId
 * Leaf resources (buffer / texture / sampler / BGL / shaderModule) return empty.
 */
export function _getCreateEventReferencedHandleIds(event: RhiCallEvent): HandleId[] {
  switch (event.kind) {
    case 'createBindGroup': {
      const e = event as { layoutHandleId: HandleId; resourceHandleIds: readonly HandleId[] };
      return [e.layoutHandleId, ...e.resourceHandleIds];
    }
    case 'createPipelineLayout': {
      const e = event as { bglHandleIds: readonly HandleId[] };
      return [...e.bglHandleIds];
    }
    case 'createRenderPipeline': {
      const e = event as {
        layoutHandleId: HandleId;
        vertexShaderModuleHandleId?: HandleId;
        fragmentShaderModuleHandleId?: HandleId;
      };
      const refs: HandleId[] = [];
      if (e.layoutHandleId !== 'layout:auto') refs.push(e.layoutHandleId);
      if (e.vertexShaderModuleHandleId !== undefined) refs.push(e.vertexShaderModuleHandleId);
      if (e.fragmentShaderModuleHandleId !== undefined) refs.push(e.fragmentShaderModuleHandleId);
      return refs;
    }
    case 'createComputePipeline': {
      const e = event as { layoutHandleId: HandleId; computeShaderModuleHandleId?: HandleId };
      const refs: HandleId[] = [];
      if (e.layoutHandleId !== 'layout:auto') refs.push(e.layoutHandleId);
      if (e.computeShaderModuleHandleId !== undefined) refs.push(e.computeShaderModuleHandleId);
      return refs;
    }
    case 'createTextureView': {
      const e = event as { sourceHandleId: HandleId };
      return [e.sourceHandleId];
    }
    case 'createBuffer':
    case 'createTexture':
    case 'createSampler':
    case 'createBindGroupLayout':
    case 'createShaderModule':
    case 'createCommandEncoder':
      return [];
    default:
      return [];
  }
}

/**
 * @internal
 * Compute the transitive closure of handleIds from bootstrapCreates.
 *
 * Starting from the given seed set, recursively walks all referenced handleIds
 * via _getCreateEventReferencedHandleIds. Returns the set of all handleIds
 * whose create events must be included in the tape prefix for self-containment.
 *
 * If a referenced handleId is not found in bootstrapCreates, returns
 * `null` for that id — the caller should produce a structured tape error.
 */
export function _computeClosure(
  seedHandleIds: Set<HandleId>,
  bootstrapCreates: Map<HandleId, RhiCallEvent>,
  inFrameHandleIds: Set<HandleId>,
): { closure: Set<HandleId>; missing: HandleId | null } {
  const closure = new Set(seedHandleIds);
  const queue = [...seedHandleIds];

  while (queue.length > 0) {
    const current: HandleId | undefined = queue.shift();
    if (current === undefined) break;
    const createEvent = bootstrapCreates.get(current);
    if (createEvent === undefined) {
      // The handle is not in bootstrapCreates. If it is declared in
      // s.events (e.g. swapchain textures from getCurrentTexture), treat it
      // as a leaf — no further expansion needed.
      if (inFrameHandleIds.has(current)) continue;
      return { closure, missing: current };
    }
    const edges = _getCreateEventReferencedHandleIds(createEvent);
    for (const target of edges) {
      if (!closure.has(target)) {
        closure.add(target);
        queue.push(target);
      }
    }
  }
  return { closure, missing: null };
}

/**
 * @internal
 * Topologically sort the closure set so that dependencies appear before dependents.
 *
 * Builds a dep-graph: if event A references handleId of event B, then B must
 * appear before A. Uses Kahn's algorithm.
 */
export function _topoSortClosure(
  closure: Set<HandleId>,
  bootstrapCreates: Map<HandleId, RhiCallEvent>,
): RhiCallEvent[] {
  const inDegree = new Map<HandleId, number>();
  const dependents = new Map<HandleId, HandleId[]>();

  for (const hId of closure) {
    inDegree.set(hId, 0);
    dependents.set(hId, []);
  }

  for (const hId of closure) {
    const event = bootstrapCreates.get(hId);
    if (event === undefined) continue;
    const edges = _getCreateEventReferencedHandleIds(event);
    for (const target of edges) {
      if (closure.has(target)) {
        // hId depends on target
        const current = dependents.get(target);
        if (current !== undefined) current.push(hId);
        inDegree.set(hId, (inDegree.get(hId) ?? 0) + 1);
      }
    }
  }

  const queue: HandleId[] = [];
  for (const [hId, deg] of inDegree) {
    if (deg === 0) queue.push(hId);
  }

  const sorted: RhiCallEvent[] = [];
  while (queue.length > 0) {
    const current: HandleId | undefined = queue.shift();
    if (current === undefined) break;
    const event = bootstrapCreates.get(current);
    if (event !== undefined) sorted.push(event);

    const deps = dependents.get(current);
    if (deps !== undefined) {
      for (const dep of deps) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }
  }

  return sorted;
}

// ============================================================================
// DebugRhiInstance — public interface
// ============================================================================
