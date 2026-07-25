import type {
  Result,
  RhiCanvasContext,
  RhiDevice,
  RhiError,
  RhiInstance,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError as RhiErrorClass } from '@forgeax/engine-rhi';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import type { RendererOptions } from '../renderer';

export interface RhiBackendPack {
  readonly rhi: RhiInstance & {
    readonly acquireCanvasContext: (
      canvas: HTMLCanvasElement | OffscreenCanvas,
    ) => Result<RhiCanvasContext, RhiError>;
  };
  readonly createShaderModule?: (
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ) => Promise<Result<ShaderModule, RhiError>>;
  readonly translateErrorEventToRhiError?: (event: unknown) => {
    readonly ok: false;
    readonly error: RhiError;
  };
  /** @internal */
  readonly _internal_getRawDevice?: (device: RhiDevice) => unknown | undefined;
}

export function loadRhiPack(mod: Record<string, unknown>): RhiBackendPack {
  return {
    rhi: mod.rhi as RhiBackendPack['rhi'],
    ...(mod.createShaderModule !== undefined
      ? {
          createShaderModule: mod.createShaderModule as NonNullable<
            RhiBackendPack['createShaderModule']
          >,
        }
      : {}),
    ...(mod.translateErrorEventToRhiError !== undefined
      ? {
          translateErrorEventToRhiError: mod.translateErrorEventToRhiError as NonNullable<
            RhiBackendPack['translateErrorEventToRhiError']
          >,
        }
      : {}),
    ...(mod._internal_getRawDevice !== undefined
      ? {
          _internal_getRawDevice: mod._internal_getRawDevice as NonNullable<
            RhiBackendPack['_internal_getRawDevice']
          >,
        }
      : {}),
  };
}

export async function loadBackendPack(
  options: RendererOptions | undefined,
): Promise<Result<RhiBackendPack, RhiError>> {
  const explicit = options?.rhi;
  if (explicit !== undefined && explicit !== null) {
    const extras = explicit as unknown as Record<string, unknown>;
    return ok(loadRhiPack({ rhi: explicit, ...extras }));
  }
  const nav =
    typeof globalThis === 'undefined'
      ? undefined
      : (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (nav?.gpu !== undefined && nav.gpu !== null)
    return ok(loadRhiPack(rhiWebgpu as unknown as Record<string, unknown>));
  try {
    const mod = (await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>;
    await (mod.ensureReady as () => Promise<unknown>)();
    return ok(loadRhiPack(mod));
  } catch (cause) {
    return err(
      new RhiErrorClass({
        code: 'rhi-not-available',
        expected: 'a usable RHI backend is available',
        hint: `failed to load wgpu backend: ${String(cause)}`,
      }),
    );
  }
}
