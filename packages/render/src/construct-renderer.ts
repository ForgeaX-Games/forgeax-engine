import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { EngineEnvironmentError, type RhiBackendPack } from './assembly/backend-contract';
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
export { EngineEnvironmentError, loadRhiPack } from './assembly/backend-contract';
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

function describeRendererInitializationFailure(error: unknown): string {
  const candidate = error as unknown as {
    readonly code?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  const detail = candidate.detail;
  if (typeof detail === 'object' && detail !== null && 'compilerMessages' in detail) {
    const messages = (detail as { readonly compilerMessages?: unknown }).compilerMessages;
    if (Array.isArray(messages)) {
      const compilerMessages = messages.map((message) => {
        const value = message as {
          readonly message?: unknown;
          readonly type?: unknown;
          readonly lineNum?: unknown;
          readonly linePos?: unknown;
          readonly offset?: unknown;
          readonly length?: unknown;
        };
        return {
          message: value.message,
          type: value.type,
          lineNum: value.lineNum,
          linePos: value.linePos,
          offset: value.offset,
          length: value.length,
        };
      });
      return `${String(candidate.code)}: ${String(candidate.hint)}; detail=${JSON.stringify({ compilerMessages })}`;
    }
  }
  return `${String(candidate.code)}: ${String(candidate.hint)}; detail=${JSON.stringify(detail)}`;
}

export async function constructRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
  backend?: RhiBackendPack,
): Promise<RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>> {
  try {
    const implementation = await createRenderer(canvas, options, bundler, backend);
    const ready = await implementation.initialization;
    if (!ready.ok) {
      implementation.dispose();
      return {
        ok: false,
        error: new RendererContractFailureError(
          'construct',
          describeRendererInitializationFailure(ready.error),
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
    if (cause instanceof EngineEnvironmentError) {
      return { ok: false, error: cause };
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: new RendererContractFailureError('construct', detail),
    };
  }
}
