import type { RendererOptions } from '@forgeax/engine-render';
import type { RhiBackendPack } from '@forgeax/engine-render/internal/construct-renderer';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';

export function loadRhiPack(
  mod: Record<string, unknown>,
  instrumentation?: RhiBackendPack['instrumentation'],
): RhiBackendPack {
  const rhi = mod.rhi as unknown as RhiBackendPack['rhi'];
  const createShaderModule = mod.createShaderModule as
    | RhiBackendPack['createShaderModule']
    | undefined;
  const translateErrorEventToRhiError = mod.translateErrorEventToRhiError as
    | RhiBackendPack['translateErrorEventToRhiError']
    | undefined;
  const rawDeviceAccessor = mod._internal_getRawDevice as unknown as
    | RhiBackendPack['_internal_getRawDevice']
    | undefined;
  const backendInstrumentation = mod.instrumentation as
    | RhiBackendPack['instrumentation']
    | undefined;
  const pack: RhiBackendPack = {
    rhi,
    ...(createShaderModule === undefined ? {} : { createShaderModule }),
    ...(translateErrorEventToRhiError === undefined ? {} : { translateErrorEventToRhiError }),
    ...(rawDeviceAccessor === undefined ? {} : { _internal_getRawDevice: rawDeviceAccessor }),
  };
  const resolvedInstrumentation = instrumentation ?? backendInstrumentation;
  return resolvedInstrumentation === undefined
    ? pack
    : { ...pack, instrumentation: resolvedInstrumentation };
}

/** Selects one backend pack; render receives only this typed owner contract. */
export async function loadBackendPack(
  options: RendererOptions | undefined,
  preferWgpu = false,
): Promise<
  | { readonly ok: true; readonly value: RhiBackendPack }
  | { readonly ok: false; readonly error: RhiError }
> {
  const explicit = options?.rhi;
  if (explicit !== undefined && explicit !== null) {
    return ok(loadRhiPack({ rhi: explicit, ...(explicit as object) }, options?.rhiInstrumentation));
  }
  const nav =
    typeof globalThis === 'undefined'
      ? undefined
      : (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (!preferWgpu && nav?.gpu !== undefined && nav.gpu !== null) {
    return ok(
      loadRhiPack(rhiWebgpu as unknown as Record<string, unknown>, options?.rhiInstrumentation),
    );
  }
  try {
    const mod = (await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>;
    await (mod.ensureReady as () => Promise<unknown>)();
    return ok(loadRhiPack(mod, options?.rhiInstrumentation));
  } catch (cause) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'a usable RHI backend is available',
        hint: `failed to load wgpu backend: ${String(cause)}`,
      }),
    );
  }
}
