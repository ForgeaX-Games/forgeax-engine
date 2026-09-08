import type { Plugin } from '@forgeax/engine-plugin';
import type { RenderError, Renderer, RenderFeature, RenderResult } from '@forgeax/engine-render';
import type { RendererFeatureAssemblyHost } from '@forgeax/engine-render/internal/construct-renderer';

export interface RenderFeatureHost {
  installFeature(
    feature: RenderFeature<unknown>,
  ): Promise<RenderResult<RenderFeatureLease, RenderError>>;
}

export interface RenderFeatureLease {
  release(): Promise<RenderResult<void, RenderError>>;
}

export function createRenderFeatureHost(host: RendererFeatureAssemblyHost): RenderFeatureHost {
  return {
    async installFeature(feature) {
      const installed = await host.installRenderFeature(feature);
      if (!installed.ok) return installed;
      let released = false;
      return {
        ok: true,
        value: {
          release: async () => {
            if (released) return { ok: true, value: undefined };
            released = true;
            return host.uninstallRenderFeature(feature);
          },
        },
      };
    },
  };
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    renderer?: Renderer;
    renderFeatureHost?: RenderFeatureHost;
  }
}

/** Provide the renderer without transferring its host-owned lifetime. */
export function rendererPlugin(renderer: Renderer): Plugin {
  return {
    name: 'renderer',
    provide: 'renderer',
    apply(ctx) {
      ctx.provide('renderer', renderer);
    },
  };
}

/** Provide an App/Worker-owned Renderer and release it after dependent Fibers. */
export function ownedRendererPlugin(renderer: Renderer): Plugin {
  return {
    name: 'renderer',
    provide: 'renderer',
    apply(ctx) {
      ctx.provide('renderer', renderer);
      ctx.effect(() => () => renderer.dispose(), 'render/renderer');
    },
  };
}

/** Provide the App-owned late RenderFeature assembly capability. */
export function renderFeatureHostPlugin(host: RenderFeatureHost): Plugin {
  return {
    name: 'render-feature-host',
    provide: 'renderFeatureHost',
    apply(ctx) {
      ctx.provide('renderFeatureHost', host);
    },
  };
}

/** Install a producer feature under the same Cordis Fiber that owns the caller. */
export function renderFeaturePlugin(feature: RenderFeature<unknown>): Plugin {
  return {
    name: `render-feature:${feature.identity}`,
    inject: ['renderFeatureHost'],
    async apply(ctx) {
      if (ctx.renderFeatureHost === undefined) {
        throw new Error('render-feature host capability is unavailable in this App realm');
      }
      const installed = await ctx.renderFeatureHost.installFeature(feature);
      if (!installed.ok) throw installed.error;
      ctx.effect(
        () => async () => {
          const removed = await installed.value.release();
          if (!removed.ok) throw removed.error;
        },
        `render-feature/${feature.identity}`,
      );
    },
  };
}
