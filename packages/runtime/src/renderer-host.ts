import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { RenderError, RendererOptions, RenderResult } from '@forgeax/engine-render';
import type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';
import { constructRendererHost } from '@forgeax/engine-render/internal/construct-renderer';
import { loadBackendPack } from './backend-selection';

export type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';

/** Assemble renderer plus asset services in the Runtime-owned backend host. */
export async function constructRuntimeRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
): Promise<RenderResult<RendererHostAssembly, RenderError>> {
  const first = await loadBackendPack(options);
  if (!first.ok) throw first.error;
  const constructed = await constructRendererHost(canvas, options, bundler, first.value);
  if (constructed.ok || options?.rhi !== undefined || typeof globalThis === 'undefined') {
    return constructed;
  }
  const fallback = await loadBackendPack(options, true);
  if (!fallback.ok) return constructed;
  return constructRendererHost(canvas, options, bundler, fallback.value);
}

export { loadRhiPack } from './backend-selection';
export type { AssetRegistry };
