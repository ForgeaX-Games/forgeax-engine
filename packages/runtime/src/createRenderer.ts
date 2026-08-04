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
  const rendererOptions: RendererOptions | undefined =
    options === undefined
      ? undefined
      : {
          ...(options.rhi === undefined ? {} : { rhi: options.rhi }),
          ...(options.rawDeviceForContextConfigure === undefined
            ? {}
            : { rawDeviceForContextConfigure: options.rawDeviceForContextConfigure }),
          ...(options.features === undefined ? {} : { features: options.features }),
          ...(options.profiler === undefined ? {} : { profiler: options.profiler }),
        };
  try {
    return await constructRenderer(canvas, rendererOptions, bundler);
  } catch (cause) {
    if (isStructuredRenderError(cause)) throw cause;
    if (cause instanceof EngineEnvironmentError) throw cause;
    const detail = cause instanceof Error ? cause : new Error(String(cause));
    throw new EngineEnvironmentError('renderer construction failed', { webgpuError: detail });
  }
}

function isStructuredRenderError(value: unknown): value is Error & {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
} {
  if (!(value instanceof Error)) return false;
  const candidate = value as Partial<{
    code: unknown;
    expected: unknown;
    hint: unknown;
    detail: unknown;
  }>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.expected === 'string' &&
    typeof candidate.hint === 'string' &&
    candidate.detail !== undefined
  );
}
