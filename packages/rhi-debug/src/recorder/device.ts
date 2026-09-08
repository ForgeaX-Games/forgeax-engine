// @forgeax/engine-rhi-debug/src/recorder/device -- device proxy owner.

/// <reference types="@webgpu/types" />

import type {
  BindGroupDescriptor,
  BindGroupLayoutDescriptor,
  Buffer,
  BufferDescriptor,
  CommandEncoderDescriptor,
  ComputePipelineDescriptor,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderPipelineDescriptor,
  RhiCommandEncoder,
  RhiDevice,
  SamplerDescriptor,
  Texture,
  TextureDescriptor,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err as makeErr, ok as makeOk, type Result } from '@forgeax/engine-types';
import type { HandleId, RhiBindResourceKind, RhiCallEvent } from '../types';
import type { RecorderInternal } from './core';
import {
  allocHandleId,
  ensureTextureCreateEvent,
  getHandleId,
  hasBootstrapDependency,
  isDepthOrStencilFormat,
  promoteBufferUsage,
  pushEvent,
  registerHandle,
  retainsCaptureBootstrap,
  shouldRecord,
  TEXTURE_USAGE_BINDING,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_COPY_SRC,
} from './core';
import { createCommandEncoderProxy } from './encoder';
import { createQueueProxy } from './queue';

export function createDeviceProxy(s: RecorderInternal, realDevice: RhiDevice): RhiDevice {
  const proxiedQueue = createQueueProxy(s, realDevice.queue);

  // Expose the real RhiDevice for standalone createShaderModule calls.
  // engine-rhi-webgpu's createShaderModule uses RAW_DEVICE_MAP (WeakMap)
  // to reverse-lookup the GPUDevice. The proxy is a different JS object
  // from the RhiDevice that makeRhiDevice registered, so WeakMap.get(proxy)
  // returns undefined and createShaderModule returns shader-compile-failed.
  // The _realDevice property lets callers pass the real RhiDevice directly.
  type RhiDeviceWithReal = RhiDevice & { _realDevice: RhiDevice };

  const d: RhiDeviceWithReal = {
    _realDevice: realDevice,

    get caps() {
      return realDevice.caps;
    },
    get features() {
      return realDevice.features;
    },
    get limits() {
      return realDevice.limits;
    },
    get queue() {
      return proxiedQueue;
    },
    get lost() {
      return realDevice.lost;
    },

    createBuffer(desc: BufferDescriptor) {
      // COPY_SRC promotion (D-5): every recorded resource must be readable
      // back via copyBufferToBuffer so snapshotResource can capture its GPU
      // bytes at frame-header time. Promote the live resource's usage too,
      // not just the recorded event — a buffer created without COPY_SRC is
      // an invalid copy source on the real device. Mappable buffers are
      // skipped (MAP_READ|COPY_SRC is invalid) — they are staging buffers,
      // never snapshot targets.
      const promotedUsage = promoteBufferUsage(desc.usage ?? 0);
      const res = realDevice.createBuffer({ ...desc, usage: promotedUsage });
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createBuffer',
        handleId: '' as HandleId,
        desc: {
          size: desc.size ?? 0,
          usage: promotedUsage,
          mappedAtCreation: desc.mappedAtCreation,
        },
      };
      const bufResource = res.value as object;
      const bufHandleId = registerHandle(s, bufResource, 'buffer', event);
      s.descriptorTable.set(bufHandleId, {
        kind: 'buffer',
        size: desc.size ?? 0,
        usage: promotedUsage,
        resource: bufResource,
      });
      pushEvent(s, event);
      return res;
    },

    createTexture(desc: TextureDescriptor) {
      // Snapshot promotion (D-5): a texture needs COPY_SRC for GPU readback
      // and COPY_DST for queue.writeTexture bootstrap seeding. Promote the
      // live resource's usage as well as the recorded event's so replay can
      // restore the captured color bytes on a fresh device.
      const promotedUsage =
        (desc.usage ?? 0) |
        TEXTURE_USAGE_COPY_SRC |
        TEXTURE_USAGE_COPY_DST |
        (isDepthOrStencilFormat(desc.format) ? TEXTURE_USAGE_BINDING : 0);
      const res = realDevice.createTexture({ ...desc, usage: promotedUsage });
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createTexture',
        handleId: '' as HandleId,
        desc: {
          size: desc.size ?? { width: 1, height: 1 },
          mipLevelCount: desc.mipLevelCount,
          sampleCount: desc.sampleCount,
          dimension: desc.dimension,
          format: desc.format ?? ('bgra8unorm' as GPUTextureFormat),
          usage: promotedUsage,
          viewFormats: desc.viewFormats,
          textureBindingViewDimension: desc.textureBindingViewDimension,
        },
      };
      const texResource = res.value as object;
      const texHandleId = registerHandle(s, texResource, 'texture', event);
      s.descriptorTable.set(texHandleId, {
        kind: 'texture',
        size: desc.size ?? { width: 1, height: 1 },
        format: desc.format ?? ('bgra8unorm' as GPUTextureFormat),
        ...(desc.sampleCount !== undefined ? { sampleCount: desc.sampleCount } : {}),
        ...(desc.mipLevelCount !== undefined ? { mipLevelCount: desc.mipLevelCount } : {}),
        usage: promotedUsage,
        resource: texResource,
      });
      pushEvent(s, event);
      return res;
    },

    createTextureView(texture: Texture, desc: TextureViewDescriptor) {
      const res = realDevice.createTextureView(texture, desc);
      if (!res.ok) return res;
      const srcId = getHandleId(s, texture as object, 'texture');
      const textureError = ensureTextureCreateEvent(s, texture as object, srcId, desc.format);
      if (textureError !== undefined) {
        return makeErr(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'texture-view creation to remain representable in the capture graph',
            hint: textureError.hint,
            detail: {
              error: {
                code: textureError.code,
                message: textureError.hint,
                name: 'RhiDebugError',
              },
            },
          }),
        );
      }
      const viewId = registerHandle(s, res.value as object, 'textureView');
      s.textureViewHandleMap.set(res.value, viewId);

      const event: RhiCallEvent = {
        kind: 'createTextureView',
        sourceHandleId: srcId,
        resultHandleId: viewId,
        desc: {
          format: desc.format,
          dimension: desc.dimension,
          usage: desc.usage,
          aspect: desc.aspect,
          baseMipLevel: desc.baseMipLevel,
          mipLevelCount: desc.mipLevelCount,
          baseArrayLayer: desc.baseArrayLayer,
          arrayLayerCount: desc.arrayLayerCount,
        },
      };
      s.bootstrapCreates.set(viewId, event);
      pushEvent(s, event);
      return res;
    },

    createSampler(desc?: SamplerDescriptor | undefined) {
      const res = realDevice.createSampler(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createSampler',
        handleId: '' as HandleId,
        desc: desc as Partial<GPUSamplerDescriptor> | undefined,
      };
      registerHandle(s, res.value as object, 'sampler', event);
      pushEvent(s, event);
      return res;
    },

    createBindGroupLayout(desc: BindGroupLayoutDescriptor) {
      const res = realDevice.createBindGroupLayout(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createBindGroupLayout',
        handleId: '' as HandleId,
        desc: { label: desc.label, entries: desc.entries ?? [] },
      };
      registerHandle(s, res.value as object, 'bindGroupLayout', event);
      pushEvent(s, event);
      return res;
    },

    createBindGroup(desc: BindGroupDescriptor) {
      const res = realDevice.createBindGroup(desc);
      if (!res.ok) return res;
      const layoutId = getHandleId(s, desc.layout as object, 'bindGroupLayout');
      const entries = Array.from(desc.entries);
      const resourceKinds: RhiBindResourceKind[] = entries.map((e) => e.resource.kind);
      const resourceHandleIds: HandleId[] = entries.map((e) => {
        const r = e.resource;
        switch (r.kind) {
          case 'sampler':
            return getHandleId(s, r.value as object, 'sampler');
          case 'buffer':
            return getHandleId(s, r.value.buffer as object, 'buffer');
          case 'textureView':
            return getHandleId(s, r.value as object, 'textureView');
          case 'externalTexture':
            return 'externalTexture:unknown';
        }
        return 'externalTexture:unknown' as HandleId;
      });
      const event: RhiCallEvent = {
        kind: 'createBindGroup',
        handleId: '' as HandleId,
        layoutHandleId: layoutId,
        entries: entries.map((e, idx) => {
          const entry: {
            binding: number;
            resourceKind: RhiBindResourceKind;
            bufferOffset?: number;
            bufferSize?: number;
          } = {
            binding: e.binding,
            resourceKind: resourceKinds[idx] as RhiBindResourceKind,
          };
          // Capture the bound sub-range for buffer entries so a
          // dynamic-offset slice (e.g. a 256 B view of a 256 KiB pool)
          // replays as that slice, not the whole buffer.
          if (e.resource.kind === 'buffer') {
            const { offset, size } = e.resource.value;
            if (offset !== undefined) entry.bufferOffset = offset;
            if (size !== undefined) entry.bufferSize = size;
          }
          return entry;
        }),
        resourceHandleIds,
      };
      registerHandle(s, res.value as object, 'bindGroup', event);
      pushEvent(s, event);
      return res;
    },

    createPipelineLayout(desc: PipelineLayoutDescriptor) {
      const res = realDevice.createPipelineLayout(desc);
      if (!res.ok) return res;
      const bglIds = Array.from(desc.bindGroupLayouts).map((bgl) =>
        getHandleId(s, bgl as object, 'bindGroupLayout'),
      );
      const event: RhiCallEvent = {
        kind: 'createPipelineLayout',
        handleId: '' as HandleId,
        bglHandleIds: bglIds,
      };
      registerHandle(s, res.value as object, 'pipelineLayout', event);
      pushEvent(s, event);
      return res;
    },

    createRenderPipeline(desc: RenderPipelineDescriptor) {
      const res = realDevice.createRenderPipeline(desc);
      if (!res.ok) return res;
      let layoutId: HandleId;
      if (typeof desc.layout === 'string') {
        layoutId = 'layout:auto';
      } else {
        layoutId = getHandleId(s, desc.layout as object, 'pipelineLayout');
      }
      let vertexShaderModuleHandleId: HandleId | undefined;
      if (desc.vertex !== undefined) {
        vertexShaderModuleHandleId = getHandleId(s, desc.vertex.module as object, 'shaderModule');
      }
      let fragmentShaderModuleHandleId: HandleId | undefined;
      if (desc.fragment !== undefined) {
        fragmentShaderModuleHandleId = getHandleId(
          s,
          desc.fragment.module as object,
          'shaderModule',
        );
      }
      const { module: _vertexModule, constants: vertexConstants, ...vertexFields } = desc.vertex;
      const recordedVertex =
        vertexConstants === undefined
          ? vertexFields
          : { ...vertexFields, constants: vertexConstants };
      const recordedFragment =
        desc.fragment === undefined
          ? undefined
          : (() => {
              const {
                module: _fragmentModule,
                constants: fragmentConstants,
                ...fragmentFields
              } = desc.fragment;
              return fragmentConstants === undefined
                ? fragmentFields
                : { ...fragmentFields, constants: fragmentConstants };
            })();
      const event: RhiCallEvent = {
        kind: 'createRenderPipeline',
        handleId: '' as HandleId,
        desc: {
          vertex: recordedVertex,
          primitive: desc.primitive,
          depthStencil: desc.depthStencil,
          multisample: desc.multisample,
          ...(recordedFragment === undefined ? {} : { fragment: recordedFragment }),
        },
        layoutHandleId: layoutId,
        vertexShaderModuleHandleId,
        fragmentShaderModuleHandleId,
      };
      registerHandle(s, res.value as object, 'renderPipeline', event);
      pushEvent(s, event);
      return res;
    },

    createComputePipeline(desc: ComputePipelineDescriptor) {
      const res = realDevice.createComputePipeline(desc);
      if (!res.ok) return res;
      let layoutId: HandleId;
      if (typeof desc.layout === 'string') {
        layoutId = 'layout:auto';
      } else {
        layoutId = getHandleId(s, desc.layout as object, 'pipelineLayout');
      }
      const computeShaderModuleHandleId = getHandleId(
        s,
        desc.compute.module as object,
        'shaderModule',
      );
      const event: RhiCallEvent = {
        kind: 'createComputePipeline',
        handleId: '' as HandleId,
        desc: { compute: JSON.parse(JSON.stringify(desc.compute)) },
        layoutHandleId: layoutId,
        computeShaderModuleHandleId,
      };
      registerHandle(s, res.value as object, 'computePipeline', event);
      pushEvent(s, event);
      return res;
    },

    createQuerySet(desc: QuerySetDescriptor) {
      return realDevice.createQuerySet(desc);
    },

    destroyBuffer(buf: Buffer) {
      const hId = s.handleMap.get(buf as object);
      const res = realDevice.destroyBuffer(buf);
      if (!res.ok) return res;
      if (hId !== undefined) {
        s.descriptorTable.delete(hId);
        // Bound bootstrapCreates growth: an idle-destroyed resource can never
        // be referenced by a future frame's events, so drop its create event.
        // Only when NOT recording — mid-capture, an earlier frame event may
        // still reference this handle, and the tape prefix needs its create
        // event to stay self-contained (tape-invalid otherwise).
        //
        // Known bounded residual: a resource destroyed DURING a capture keeps
        // its bootstrapCreates entry forever — the entry is only ever revisited
        // by another destroy* of the SAME handle, which can't recur after the
        // resource is gone. This leaks one create event per resource that is
        // both created and destroyed inside a recording window (a narrow set;
        // most resources are long-lived). Fixing it needs a defer-delete list
        // swept at the next arm() — deliberately not added: the extra state
        // costs more than the leak it plugs (see PR discussion).
        //
        // Separate, wider residual: bootstrapCreates entries for
        // textureView / bindGroup / pipeline / sampler are NEVER pruned,
        // because RhiDevice exposes destroy only for buffer / texture -- a
        // faithful mirror of WebGPU, whose spec puts .destroy() solely on
        // GPUBuffer / GPUTexture (the objects holding large, eagerly-freeable
        // backing memory); views / bind groups / pipelines / samplers are
        // lightweight reference objects left to GC. So there is no destroy
        // signal to hook for them. An app that rebuilds these per frame grows
        // bootstrapCreates under a long idle run. The GC-aligned fix is a
        // WeakRef + FinalizationRegistry over the create-event objects (same
        // spirit as handleMap's WeakMap, but keyed by handleId so it needs the
        // WeakRef wrapper) -- a finalization-semantics change, out of scope here.
        if (
          !retainsCaptureBootstrap(s) &&
          !s.snapshotSeededHandles.has(hId) &&
          !hasBootstrapDependency(s, hId)
        ) {
          s.bootstrapCreates.delete(hId);
        }
        pushEvent(s, { kind: 'destroyBuffer', handleId: hId });
      }
      return res;
    },

    destroyQuerySet(querySet: QuerySet) {
      return realDevice.destroyQuerySet(querySet);
    },

    destroyTexture(tex: Texture) {
      const hId = s.handleMap.get(tex as object);
      const res = realDevice.destroyTexture(tex);
      if (!res.ok) return res;
      if (hId !== undefined) {
        s.descriptorTable.delete(hId);
        // Same gate + same bounded residual as destroyBuffer above.
        if (
          !retainsCaptureBootstrap(s) &&
          !s.snapshotSeededHandles.has(hId) &&
          !hasBootstrapDependency(s, hId)
        ) {
          s.bootstrapCreates.delete(hId);
        }
        pushEvent(s, { kind: 'destroyTexture', handleId: hId });
      }
      return res;
    },

    createCommandEncoder(desc?: CommandEncoderDescriptor | undefined) {
      const res = realDevice.createCommandEncoder(desc);
      if (!res.ok) return res;
      // Idle fast-path: return the real (un-proxied) encoder when not
      // recording. One gate here elides the proxy wrapper AND every
      // beginRenderPass/draw/setBindGroup/copy* call that would otherwise
      // route through proxyCmdEncoder + proxyRenderPass only to be dropped
      // by the pushEvent gate. Safe because a frame body runs synchronously
      // in one rAF callback: createCommandEncoder -> passes -> queue.submit
      // all observe the same recorder state (arm() only fires between frames),
      // so an idle-created encoder's whole frame is consistently un-recorded,
      // matching the now-gated queue.submit which skips its handle lookup.
      if (!shouldRecord(s)) {
        return res;
      }
      const cmdId = allocHandleId('commandEncoder');
      pushEvent(s, {
        kind: 'createCommandEncoder',
        cmdHandleId: cmdId,
        desc: desc as Partial<GPUCommandEncoderDescriptor> | undefined,
      });
      const proxyEnc = createCommandEncoderProxy(s, res.value, cmdId);
      return makeOk(proxyEnc as RhiCommandEncoder) as Result<
        RhiCommandEncoder,
        import('@forgeax/engine-rhi').RhiError
      >;
    },
  };
  return d;
}

// --------------------------------------------------
// wrap RhiInstance
// --------------------------------------------------
