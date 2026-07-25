// Runtime is the host assembly facade. Concrete Renderer construction and
// frame interpretation live in @forgeax/engine-render/internal.
import type { BundlerOptions, Renderer, RendererOptions } from '@forgeax/engine-render/internal';
import { constructRenderer } from '@forgeax/engine-render/internal/construct-renderer';
import { EngineEnvironmentError } from './errors/environment';

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: RendererOptions,
  bundler?: BundlerOptions,
): Promise<Renderer> {
  if (options !== undefined && 'rhi' in options && options.rhi === undefined) {
    throw new EngineEnvironmentError('no usable rendering backend');
  }
  try {
    return await constructRenderer(canvas, options, bundler);
  } catch (cause) {
    if (cause instanceof EngineEnvironmentError) throw cause;
    const detail = cause instanceof Error ? cause : new Error(String(cause));
    throw new EngineEnvironmentError('renderer construction failed', { webgpuError: detail });
  }
}
