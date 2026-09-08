// Runtime is the host assembly facade. Concrete Renderer construction and
// frame interpretation live in the render owner assembly.
import type { RenderError, Renderer, RendererOptions } from '@forgeax/engine-render';
import type { BundlerOptions } from '@forgeax/engine-render/internal/construct-renderer';
import { err, ok, type Result } from '@forgeax/engine-types';
import { EngineEnvironmentError } from './errors/environment';
import { constructRuntimeRendererHost } from './renderer-host';

/**
 * Assemble the sole public renderer host.
 *
 * Runtime owns backend selection and partial-construction cleanup. Render owns
 * the scene/frame contract; successful construction returns the host that
 * exposes attach, draw, inspect, observe, and recover. Expected failures are
 * structured Result errors at the owning boundary; environment failures retain
 * EngineEnvironmentError recovery guidance for the caller.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: RendererOptions,
  bundler?: BundlerOptions,
): Promise<Result<Renderer, EngineEnvironmentError | RenderError>> {
  if (options !== undefined && 'rhi' in options && options.rhi === undefined) {
    return err(new EngineEnvironmentError('no usable rendering backend'));
  }
  const rendererOptions: RendererOptions | undefined =
    options === undefined
      ? undefined
      : {
          ...(options.rhi === undefined ? {} : { rhi: options.rhi }),
          ...(options.features === undefined ? {} : { features: options.features }),
          ...(options.profiler === undefined ? {} : { profiler: options.profiler }),
          ...(options.rhiInstrumentation === undefined
            ? {}
            : { rhiInstrumentation: options.rhiInstrumentation }),
          ...(options.standardProfile === undefined
            ? {}
            : { standardProfile: options.standardProfile }),
        };
  try {
    const constructed = await constructRuntimeRendererHost(canvas, rendererOptions, bundler);
    if (!constructed.ok) return err(constructed.error);
    return ok(constructed.value.renderer);
  } catch (cause) {
    if (cause instanceof EngineEnvironmentError) return err(cause);
    const detail = cause instanceof Error ? cause : new Error(String(cause));
    return err(new EngineEnvironmentError('renderer construction failed', { webgpuError: detail }));
  }
}
