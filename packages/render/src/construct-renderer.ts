import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { RhiBackendPack } from './assembly/backend-contract';
import type { BundlerOptions } from './assembly/factory';
import { createRenderer, exposeRenderer } from './assembly/factory';
import type {
  RendererHostImplementation,
  RendererLegacyHostAdapter,
} from './assembly/host-contract';
import { type RenderError, RendererContractFailureError } from './errors/render';
import type { Renderer, RendererOptions, RenderResult } from './render-contract';

export type {
  EngineEnvironmentErrorDetail,
  RhiBackendInstrumentation,
  RhiBackendPack,
} from './assembly/backend-contract';
export { EngineEnvironmentError } from './assembly/backend-contract';
export type { RendererLegacyHostAdapter } from './assembly/host-contract';
export type { BundlerOptions };

export type RendererFeatureAssemblyHost = Pick<
  RendererLegacyHostAdapter,
  'installRenderFeature' | 'uninstallRenderFeature'
>;

export interface RendererHostAssembly {
  readonly renderer: Renderer;
  readonly debugDrawHost: RendererHostImplementation;
  readonly featureHost: RendererFeatureAssemblyHost;
  readonly assets: AssetRegistry;
}

export async function constructRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
  backend?: RhiBackendPack,
): Promise<RenderResult<RendererHostAssembly, RenderError>> {
  try {
    const implementation = await createRenderer(canvas, options, bundler, backend);
    const ready = await implementation.initialization;
    if (!ready.ok) {
      return {
        ok: false,
        error: new RendererContractFailureError(
          'construct',
          `${ready.error.code}: ${ready.error.hint}`,
        ),
      };
    }
    return {
      ok: true,
      value: {
        renderer: exposeRenderer(implementation),
        debugDrawHost: implementation,
        featureHost: implementation,
        assets: implementation.assetRegistry,
      },
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: new RendererContractFailureError('construct', detail),
    };
  }
}
