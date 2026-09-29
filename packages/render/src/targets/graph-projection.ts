import type {
  GraphTexture,
  GraphTextureView,
  GraphTextureViewDescriptor,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Texture, TextureFormat, TextureView } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import { RenderTargetOperationFailedError, RenderTargetStateInvalidError } from '../errors/render';
import type { RenderResult } from '../render-contract';
import type { RenderTarget, RenderTargetDescriptor } from './contracts';

export interface RenderTargetGraphInput {
  readonly target: RenderTarget;
  readonly generation: number;
  readonly descriptor: RenderTargetDescriptor;
  readonly texture: Texture;
  readonly view: TextureView;
  readonly resolveView?: TextureView | undefined;
}

export interface RenderTargetGraphSubresource {
  readonly mipLevel?: number;
  readonly face?: number;
}

export interface RenderTargetGraphProjection {
  readonly ownership: 'imported';
  readonly generation: number;
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly sampleView: GraphTextureView;
  readonly resolveView?: GraphTextureView | undefined;
  readonly viewDescriptor: GraphTextureViewDescriptor;
  readonly usage: readonly ('sampled-read' | 'copy-src')[];
}

function operationFailed(generation: number, cause: unknown): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetOperationFailedError({
      operation: 'source',
      stage: 'copy',
      generation,
      cause,
      recovery: 'retry',
    }),
  };
}

function mipCount(descriptor: RenderTargetDescriptor): number {
  if (descriptor.mipLevels === 1) return 1;
  return Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
}

function viewDescriptor(
  descriptor: RenderTargetDescriptor,
  subresource: RenderTargetGraphSubresource,
): GraphTextureViewDescriptor {
  const mipLevel = subresource.mipLevel ?? 0;
  return {
    dimension: descriptor.shape,
    baseMipLevel: mipLevel,
    mipLevelCount: 1,
    ...(descriptor.shape === 'cube' && subresource.face === undefined
      ? {}
      : subresource.face === undefined
        ? {}
        : { baseArrayLayer: subresource.face, arrayLayerCount: 1 }),
  };
}

function validateSubresource(
  descriptor: RenderTargetDescriptor,
  subresource: RenderTargetGraphSubresource,
): RenderResult<void, RenderError> {
  const mipLevel = subresource.mipLevel ?? 0;
  if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= mipCount(descriptor)) {
    return {
      ok: false,
      error: new RenderTargetStateInvalidError({
        operation: 'source',
        reason: 'uninitialized',
        state: 'uninitialized',
        generation: 0,
      }),
    };
  }
  if (
    subresource.face !== undefined &&
    (!Number.isInteger(subresource.face) || subresource.face < 0 || subresource.face > 5)
  ) {
    return {
      ok: false,
      error: new RenderTargetStateInvalidError({
        operation: 'source',
        reason: 'uninitialized',
        state: 'uninitialized',
        generation: 0,
      }),
    };
  }
  return { ok: true, value: undefined };
}

export function projectRenderTargetGraph<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  input: RenderTargetGraphInput,
  subresource: RenderTargetGraphSubresource = {},
): RenderResult<RenderTargetGraphProjection, RenderError> {
  const valid = validateSubresource(input.descriptor, subresource);
  if (!valid.ok) return valid;
  if (input.descriptor.sampleCount === 4 && input.resolveView === undefined) {
    return operationFailed(
      input.generation,
      new Error('multisample target requires a single-sample resolve view before sampling'),
    );
  }
  const descriptor = viewDescriptor(input.descriptor, subresource);
  const imported = graph.importTexture(
    `render-target.${input.generation}`,
    {
      format: input.descriptor.format as TextureFormat,
      size: {
        width: input.descriptor.width,
        height: input.descriptor.height,
        depthOrArrayLayers: input.descriptor.shape === 'cube' ? 6 : 1,
      },
      mipLevelCount: mipCount(input.descriptor),
      sampleCount: input.descriptor.sampleCount,
      dimension: '2d',
      usage: 0x10 | 0x04 | (input.descriptor.readback ? 0x01 : 0),
    },
    () => input.texture,
  );
  if (!imported.ok) return operationFailed(input.generation, imported.error);
  const view = graph.importView(imported.value, descriptor, () => input.view);
  if (!view.ok) return operationFailed(input.generation, view.error);
  let resolveView: GraphTextureView | undefined;
  if (input.resolveView !== undefined) {
    const resolved = graph.importView(
      imported.value,
      descriptor,
      () => input.resolveView as TextureView,
    );
    if (!resolved.ok) return operationFailed(input.generation, resolved.error);
    resolveView = resolved.value;
  }
  const sampleView = input.descriptor.sampleCount === 4 ? resolveView : view.value;
  if (sampleView === undefined)
    return operationFailed(input.generation, new Error('missing sample view'));
  return {
    ok: true,
    value: {
      ownership: 'imported',
      generation: input.generation,
      texture: imported.value,
      view: view.value,
      sampleView,
      resolveView,
      viewDescriptor: descriptor,
      usage: [
        ...(input.descriptor.sampled ? (['sampled-read'] as const) : []),
        ...(input.descriptor.readback ? (['copy-src'] as const) : []),
      ],
    },
  };
}
