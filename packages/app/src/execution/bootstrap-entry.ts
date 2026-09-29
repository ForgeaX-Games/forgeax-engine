import {
  type Context,
  type Fiber,
  mountPluginAsset,
  type Plugin,
  type PluginPrograms,
  startNativePlugin,
} from '@forgeax/engine-plugin';
import type { Renderer, RenderFeature, RenderTargetAuthoring } from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import type { RuntimePackOptions } from '../runtime-packs.js';
import type { ExecutionBootstrapValue } from './types';

/** Realm-local engine assembly returned by an execution bootstrap module. */
export interface PreparedExecutionBootstrap {
  readonly pluginPrograms?: PluginPrograms;
  readonly runtimePacks?: RuntimePackOptions;
  readonly root?: { readonly guid: string };
  /** Render features constructed in the realm that will own the Renderer. */
  readonly features?: readonly RenderFeature<unknown>[];
  /** Runs in the actual Renderer realm, before source plugins and the first draw. */
  readonly configureRenderer?: (renderer: Renderer) => void | Promise<void>;
  /** Plugins constructed in the realm that will own the World. */
  readonly plugins?: readonly Plugin[];
}

/** Realm-local Host bridge available to execution bootstrap plugins. */
export interface ExecutionBootstrapHost {
  /** Logical target authoring; physical resources always belong to the Renderer. */
  readonly renderTargets?: RenderTargetAuthoring;
  /** Canvas owned by the selected execution realm (HTMLCanvasElement or OffscreenCanvas). */
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas;
  readonly port?: MessagePort;
  setPointerLockAllowed(allowed: boolean): void;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    executionBootstrapHost: ExecutionBootstrapHost;
  }
}

/** Borrow the session-owned Host transport for this World bootstrap. */
export function executionBootstrapHostPlugin(host: ExecutionBootstrapHost): Plugin {
  return {
    name: 'execution-bootstrap-host',
    provide: 'executionBootstrapHost',
    apply(ctx) {
      ctx.provide('executionBootstrapHost', host);
    },
  };
}

/** Default export contract for `ExecutionOptions.bootstrap`. */
export type ExecutionBootstrapEntry = (
  data: ExecutionBootstrapValue | undefined,
) => PreparedExecutionBootstrap | Promise<PreparedExecutionBootstrap>;

function bootstrapError(
  phase: 'import' | 'export' | 'prepare' | 'bootstrap' | 'data',
  moduleUrl: string,
  cause: unknown,
): AppErrorType {
  return new AppError({
    code: 'app-execution-bootstrap-failed',
    expected: APP_EXPECTED['app-execution-bootstrap-failed'],
    hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
    detail: { phase, moduleUrl, cause },
  });
}

export function validateExecutionBootstrapData(
  data: ExecutionBootstrapValue | undefined,
  moduleUrl: string,
): Result<void, AppErrorType> {
  if (data === undefined) return ok(undefined);
  try {
    structuredClone(data);
    return ok(undefined);
  } catch (cause) {
    return err(bootstrapError('data', moduleUrl, cause));
  }
}

export async function loadBootstrapEntry(
  moduleUrl: string,
): Promise<Result<ExecutionBootstrapEntry, AppErrorType>> {
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ moduleUrl);
  } catch (cause) {
    return err(bootstrapError('import', moduleUrl, cause));
  }
  const entry = (loaded as { default?: unknown }).default;
  if (typeof entry !== 'function') {
    return err(
      bootstrapError(
        'export',
        moduleUrl,
        new TypeError('default export is not an ExecutionBootstrapEntry function'),
      ),
    );
  }
  return ok(entry as ExecutionBootstrapEntry);
}

export async function prepareBootstrapEntry(
  moduleUrl: string,
  data: ExecutionBootstrapValue | undefined,
): Promise<Result<PreparedExecutionBootstrap, AppErrorType>> {
  const valid = validateExecutionBootstrapData(data, moduleUrl);
  if (!valid.ok) return valid;
  const loaded = await loadBootstrapEntry(moduleUrl);
  if (!loaded.ok) return loaded;
  try {
    const prepared = await loaded.value(data);
    if (
      typeof prepared !== 'object' ||
      prepared === null ||
      (prepared.features !== undefined && !Array.isArray(prepared.features)) ||
      (prepared.plugins !== undefined && !Array.isArray(prepared.plugins)) ||
      (prepared.configureRenderer !== undefined && typeof prepared.configureRenderer !== 'function')
    ) {
      return err(
        bootstrapError(
          'prepare',
          moduleUrl,
          new TypeError('execution bootstrap must return an object with feature and plugin arrays'),
        ),
      );
    }
    return ok(prepared);
  } catch (cause) {
    return err(bootstrapError('prepare', moduleUrl, cause));
  }
}

/** Start outside apply so children may inject services provided by their parent. */
export async function activateExecutionRoot(
  context: Context,
  root: NonNullable<PreparedExecutionBootstrap['root']>,
  signal?: AbortSignal,
): Promise<{ readonly fiber: Fiber }> {
  const result = await startNativePlugin(
    context,
    {
      name: 'forgeax:project-root',
      inject: ['assets', 'pluginPrograms'],
      async apply(ctx) {
        const mounted = await mountPluginAsset(ctx, root.guid, signal);
        if (!mounted.ok) throw mounted.error;
      },
    },
    undefined,
    signal === undefined ? {} : { signal },
  );
  if (!result.ok) throw result.error;
  return { fiber: result.value };
}
