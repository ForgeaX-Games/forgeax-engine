import type {
  GraphAccess,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { Texture, TextureView } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderTarget } from '../targets/contracts';
import { resolveRenderTargetMaterialSource } from '../targets/material-source';
import type { RenderTargetPhysical } from '../targets/physical';
import { isCanvasTextureSource } from '../textures/canvas-texture';
import type { TypedShadowTargets } from '../typed-shadow-passes';
import { buildPerFrameBindGroups } from './frame-lighting';
import { encodeMainPass } from './main-pass';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import type { ReflectionProbeGraphState } from './typed-frame-graph';

export interface CubeCaptureGraphWork {
  readonly sceneInput?: true;
  readonly target: RenderTarget;
  readonly faceIndex: number;
  readonly physical: RenderTargetPhysical;
  readonly faceCamera: import('../render-contract').CameraSnapshot;
}

export interface CubeCaptureGraphState {
  work: readonly CubeCaptureGraphWork[];
  reflectionProbes?: ReflectionProbeGraphState;
  planar?: import('../capture/planar-state').PlanarCaptureState;
}

function renderTargetMipCount(work: CubeCaptureGraphWork): number {
  const { descriptor } = work.physical;
  return descriptor.mipLevels === 1
    ? 1
    : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
}

export function addTargetCaptureGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: CubeCaptureGraphState,
  lighting?: { readonly shadows: TypedShadowTargets; readonly accesses: readonly GraphAccess[] },
): Result<GraphTextureView | undefined, RenderGraphError> {
  let planarView: GraphTextureView | undefined;
  for (let index = 0; index < state.work.length; index += 1) {
    const slot = index;
    const initial = state.work[slot];
    if (initial === undefined) continue;
    const label = initial.sceneInput
      ? 'feature-scene-depth'
      : initial.faceCamera.planarReflection === undefined
        ? 'cube-capture'
        : 'planar-reflection';
    const current = (): CubeCaptureGraphWork => state.work[slot] ?? initial;
    const texture = builder.importTexture(
      `${label}.${slot}.texture`,
      {
        format: initial.physical.descriptor.format,
        size: {
          width: initial.physical.descriptor.width,
          height: initial.physical.descriptor.height,
          depthOrArrayLayers:
            initial.physical.descriptor.sampleCount === 4 ||
            initial.physical.descriptor.shape === '2d'
              ? 1
              : 6,
        },
        mipLevelCount:
          initial.physical.descriptor.sampleCount === 4 ? 1 : renderTargetMipCount(initial),
        sampleCount: initial.physical.descriptor.sampleCount,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => current().physical.colorTextures[current().faceIndex] ?? initial.physical.texture,
    );
    if (!texture.ok) return texture;
    const color = builder.importView(
      texture.value,
      {
        label: `${label}.${slot}.color`,
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: initial.physical.descriptor.sampleCount === 4 ? 0 : initial.faceIndex,
        arrayLayerCount: 1,
      },
      () =>
        current().physical.faceViews[current().faceIndex] ??
        initial.physical.faceViews[initial.faceIndex] ??
        initial.physical.view,
    );
    if (!color.ok) return color;
    const depthTexture = builder.importTexture(
      `${label}.${slot}.depth-texture`,
      {
        format: 'depth32float-stencil8',
        size: {
          width: initial.physical.descriptor.width,
          height: initial.physical.descriptor.height,
          depthOrArrayLayers:
            initial.physical.descriptor.sampleCount === 4 ||
            initial.physical.descriptor.shape === '2d'
              ? 1
              : 6,
        },
        mipLevelCount: 1,
        sampleCount: initial.physical.descriptor.sampleCount,
        dimension: '2d',
        usage: 0x10 | (initial.physical.sampledDepth ? 0x04 : 0),
      },
      () => current().physical.depthTextures[current().faceIndex] as Texture,
    );
    if (!depthTexture.ok) return depthTexture;
    const depth = builder.importView(
      depthTexture.value,
      {
        label: `${label}.${slot}.depth`,
        dimension: '2d',
        baseArrayLayer: initial.physical.descriptor.sampleCount === 4 ? 0 : initial.faceIndex,
        arrayLayerCount: 1,
      },
      () => current().physical.depthViews[current().faceIndex] as TextureView,
    );
    if (!depth.ok) return depth;
    const resolveTexture =
      initial.physical.descriptor.sampleCount === 4
        ? builder.importTexture(
            `${label}.${slot}.resolve-texture`,
            {
              format: initial.physical.descriptor.format,
              size: {
                width: initial.physical.descriptor.width,
                height: initial.physical.descriptor.height,
                depthOrArrayLayers: initial.physical.descriptor.shape === 'cube' ? 6 : 1,
              },
              mipLevelCount: renderTargetMipCount(initial),
              sampleCount: 1,
              dimension: '2d',
              usage: 0x10 | 0x04 | 0x01,
            },
            () =>
              current().physical.resolveTexture ??
              initial.physical.resolveTexture ??
              initial.physical.texture,
          )
        : undefined;
    if (resolveTexture !== undefined && !resolveTexture.ok) return resolveTexture;
    const resolve =
      resolveTexture === undefined
        ? undefined
        : builder.importView(
            resolveTexture.value,
            {
              label: `${label}.${slot}.resolve`,
              dimension: '2d',
              baseMipLevel: 0,
              mipLevelCount: 1,
              baseArrayLayer: initial.faceIndex,
              arrayLayerCount: 1,
            },
            () =>
              current().physical.resolveFaceViews[current().faceIndex] ??
              initial.physical.resolveFaceViews[initial.faceIndex] ??
              initial.physical.resolveView,
          );
    if (resolve !== undefined && !resolve.ok) return resolve;
    if (initial.faceCamera.planarReflection !== undefined)
      planarView = resolve?.value ?? color.value;
    const added = builder.addRasterPass(`${label}-face.${slot}`, {
      accesses: [
        ...(lighting?.accesses ?? []),
        ...(lighting === undefined
          ? []
          : [
              ...(lighting.shadows.directional === undefined
                ? []
                : [
                    { resource: lighting.shadows.directional.view, usage: 'sampled-read' as const },
                  ]),
              { resource: lighting.shadows.spot.view, usage: 'sampled-read' as const },
              ...(lighting.shadows.point === undefined
                ? []
                : [{ resource: lighting.shadows.point.view, usage: 'sampled-read' as const }]),
            ]),
        { resource: color.value, usage: 'color-attachment' },
        { resource: depth.value, usage: 'depth-stencil-write' },
        ...(resolve === undefined
          ? []
          : [{ resource: resolve.value, usage: 'color-attachment' as const }]),
      ],
      colorAttachments: [
        {
          view: color.value,
          ...(resolve === undefined ? {} : { resolveTarget: resolve.value }),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: () => {
            const clear =
              current().physical.descriptor.shape === '2d'
                ? current().faceCamera.clearColor
                : [0, 0, 0, 1];
            return { r: clear[0] ?? 0, g: clear[1] ?? 0, b: clear[2] ?? 0, a: clear[3] ?? 1 };
          },
        },
      ],
      depthStencilAttachment: {
        view: depth.value,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store',
      },
      encode: ({ pass, frame, resources }) => {
        const internal = frame as _InternalRenderPipelineContext;
        const captureColor = resources.textureView(color.value);
        if (!captureColor.ok) return;
        const captureDepth = resources.textureView(depth.value);
        if (!captureDepth.ok) return;
        const captureResolve =
          resolve === undefined ? undefined : resources.textureView(resolve.value);
        if (resolve !== undefined && (captureResolve === undefined || !captureResolve.ok)) return;
        const captureResolveView = captureResolve?.ok ? captureResolve.value : null;
        const selfSampling = new Map<number, Set<number>>();
        for (const row of internal.validatedOrdered) {
          for (const material of row.source.materials) {
            if (
              ![...(material.textureSources?.values() ?? [])].some(
                (source) =>
                  !isCanvasTextureSource(source) &&
                  resolveRenderTargetMaterialSource(source)?.target === current().target,
              )
            )
              continue;
            let handles = selfSampling.get(row.renderableIndex);
            if (handles === undefined) {
              handles = new Set();
              selfSampling.set(row.renderableIndex, handles);
            }
            handles.add(material.materialHandle ?? 0);
          }
        }
        const resolveShadow = (
          target: import('../render-pipeline').RenderPipelineTarget | undefined,
        ) => {
          if (target === undefined) return undefined;
          const view = resources.textureView(target.view);
          if (!view.ok) throw view.error;
          return view.value;
        };
        const groups =
          lighting === undefined
            ? undefined
            : buildPerFrameBindGroups(
                internal.runtime as RenderSystemInternals,
                internal.frameState,
                internal.pipelineState,
                internal.validated.length > 0,
                internal.bindGroupCounts,
                {
                  directionalShadow: resolveShadow(lighting.shadows.directional),
                  spotShadow: resolveShadow(lighting.shadows.spot),
                },
                true,
                internal.standardLighting,
              );
        const captureContext = {
          ...internal,
          ...(groups === undefined ? {} : groups),
          camera: current().faceCamera,
          targetW: current().physical.descriptor.width,
          targetH: current().physical.descriptor.height,
          dispatch: (internal.captureDispatch ?? internal.dispatch).filter(
            (entry) => !selfSampling.get(entry.renderableIndex)?.has(entry.materialHandle),
          ),
          foldDispatchPlan: null,

          // Cube faces are raw scene captures, not display-camera HDR output.
          // Select the PSO against the actual target attachment so an LDR
          // cube target is rendered by a compatible forward pipeline.
          tonemapActive: false,
          skyboxActive: false,
          transparentColorFormat: initial.physical.descriptor.format as GPUTextureFormat,
          msaaActive: initial.physical.descriptor.sampleCount === 4,
          viewBindGroupDynamicOffset: 0,
          geometryColorView: captureColor.value,
          geometryDepthView: captureDepth.value,
          geometryColorResolveView: captureResolveView,
          splitLdrSprite: false,
          ldrSpritePassView: null,
        };
        delete captureContext.gpuDrivenDrawKeys;
        delete captureContext.gpuDrivenStandardPbrFrameResources;
        encodeMainPass(
          captureContext,
          pass,
          { LightMode: ['Forward'] },
          {
            colorViews: [captureColor.value],
            colorFormats: [initial.physical.descriptor.format as GPUTextureFormat],
            depthView: captureDepth.value,
            passKind: 'forward',
            recordMode: 'opaque',
            clearColor:
              current().physical.descriptor.shape === '2d'
                ? current().faceCamera.clearColor
                : [0, 0, 0, 1],
          },
        );
      },
    });
    if (!added.ok) return added;
  }
  const retained = state.planar?.current();
  if (planarView === undefined && retained !== undefined) {
    const texture = builder.importTexture(
      'planar-reflection.retained',
      {
        format: retained.physical.descriptor.format,
        size: {
          width: retained.physical.descriptor.width,
          height: retained.physical.descriptor.height,
        },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () =>
        (state.planar?.current() ?? retained).physical.resolveTexture ??
        (state.planar?.current() ?? retained).physical.texture,
    );
    if (!texture.ok) return texture;
    const view = builder.importView(
      texture.value,
      { dimension: '2d' },
      () => (state.planar?.current() ?? retained).physical.resolveView,
    );
    if (!view.ok) return view;
    planarView = view.value;
  }
  return ok(planarView);
}
