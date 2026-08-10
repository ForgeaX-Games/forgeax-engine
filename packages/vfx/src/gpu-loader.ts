import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { LoadContext, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import {
  VFX_GPU_PROGRAM_ARTIFACT_KEY,
  VFX_GPU_PROGRAM_FORMAT,
  type VfxGpuEffectAsset,
  type VfxGpuEmitterProgram,
} from './gpu-program.js';

export interface VfxGpuAssetError {
  readonly code:
    | 'vfx-asset-v2-invalid'
    | 'vfx-asset-v2-program-missing'
    | 'vfx-asset-v2-fingerprint-mismatch';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly guid: string; readonly path: string };
}

interface PackLoaderInput {
  readonly guid: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly artifacts: Readonly<
    Record<
      string,
      {
        readonly descriptor: { readonly path: string; readonly mediaType: string };
        readonly bytes: Uint8Array;
      }
    >
  >;
}

function failure(
  code: VfxGpuAssetError['code'],
  guid: string,
  path: string,
  expected: string,
  hint: string,
): Result<never, VfxGpuAssetError> {
  return err({ code, expected, hint, detail: { guid, path } });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return hex(await globalThis.crypto.subtle.digest('SHA-256', source));
}

function validReflectionLayout(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || value.version !== 1) return false;
  if (!record(value.parameters) || !Array.isArray(value.parameters.fields)) return false;
  if (!record(value.custom) || !Array.isArray(value.custom.fields)) return false;
  return typeof value.fingerprint === 'string' && value.fingerprint.startsWith('sha256:');
}

function stableLayouts(emitters: readonly VfxGpuEmitterProgram[]): boolean {
  const fingerprints = emitters
    .map((emitter) => emitter.reflection.layout?.fingerprint)
    .filter((fingerprint): fingerprint is string => fingerprint !== undefined);
  return fingerprints.every((fingerprint) => fingerprint === fingerprints[0]);
}

function validEmitter(value: unknown): value is VfxGpuEmitterProgram {
  const reflection = record(value) && record(value.reflection) ? value.reflection : undefined;
  const layout = reflection !== undefined ? reflection.layout : undefined;
  return (
    record(value) &&
    typeof value.id === 'string' &&
    Number.isInteger(value.capacity) &&
    (value.capacity as number) > 0 &&
    record(value.backend) &&
    value.backend.required === 'gpu' &&
    Object.keys(value.backend).length === 1 &&
    typeof value.wgsl === 'string' &&
    value.wgsl.length > 0 &&
    record(value.reflection) &&
    validReflectionLayout(layout) &&
    Array.isArray(value.reflection.entryPoints) &&
    value.reflection.entryPoints.includes('forgeax_vfx_spawn_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_compact_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_billboard_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_mesh_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_ribbon_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_trail_main') &&
    value.reflection.entryPoints.includes('forgeax_vfx_beam_main')
  );
}

export const vfxGpuEffectPackLoader = {
  kind: 'particle-effect',
  async load(
    input: PackLoaderInput,
    _context: LoadContext,
  ): Promise<Result<VfxGpuEffectAsset, VfxGpuAssetError>> {
    if (
      input.payload.kind !== 'particle-effect' ||
      input.payload.schemaVersion !== 2 ||
      !Array.isArray(input.payload.emitters) ||
      typeof input.payload.programFingerprint !== 'string'
    ) {
      return failure(
        'vfx-asset-v2-invalid',
        input.guid,
        'payload',
        'a schemaVersion 2 particle payload with its program fingerprint',
        'migrate behavior to WGSL and recook; the runtime does not interpret v1',
      );
    }
    const artifact = input.artifacts[VFX_GPU_PROGRAM_ARTIFACT_KEY];
    if (artifact === undefined) {
      return failure(
        'vfx-asset-v2-program-missing',
        input.guid,
        VFX_GPU_PROGRAM_ARTIFACT_KEY,
        'the asset-local cooked VFX program',
        'recook the particle effect and retry the load',
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(artifact.bytes));
    } catch {
      return failure(
        'vfx-asset-v2-invalid',
        input.guid,
        VFX_GPU_PROGRAM_ARTIFACT_KEY,
        'canonical JSON program bytes',
        'recook the particle effect and retry the load',
      );
    }
    if (
      !record(decoded) ||
      decoded.format !== VFX_GPU_PROGRAM_FORMAT ||
      !Array.isArray(decoded.emitters) ||
      !decoded.emitters.every(validEmitter) ||
      !stableLayouts(decoded.emitters as VfxGpuEmitterProgram[])
    ) {
      return failure(
        'vfx-asset-v2-invalid',
        input.guid,
        VFX_GPU_PROGRAM_ARTIFACT_KEY,
        `a ${VFX_GPU_PROGRAM_FORMAT} managed GPU program`,
        'recook with the current VFX compiler ABI',
      );
    }
    const decodedEmitters = decoded.emitters as VfxGpuEmitterProgram[];
    const actualFingerprint = await fingerprint(artifact.bytes);
    if (actualFingerprint !== input.payload.programFingerprint) {
      return failure(
        'vfx-asset-v2-fingerprint-mismatch',
        input.guid,
        'payload.programFingerprint',
        'payload and program artifact fingerprints to match',
        'cold-cook the particle asset so payload and artifact publish atomically',
      );
    }
    const emitters = input.payload.emitters.map((value) => {
      if (!record(value) || typeof value.id !== 'string' || !Number.isInteger(value.capacity)) {
        return undefined;
      }
      return { id: value.id, capacity: value.capacity as number };
    });
    if (
      emitters.some((value) => value === undefined) ||
      emitters.length !== decodedEmitters.length ||
      emitters.some(
        (value, index) =>
          value?.id !== decodedEmitters[index]?.id ||
          value?.capacity !== decodedEmitters[index]?.capacity,
      )
    ) {
      return failure(
        'vfx-asset-v2-invalid',
        input.guid,
        'payload.emitters',
        'payload emitter identities and capacities to match the program',
        'recook the particle effect atomically',
      );
    }
    return ok(
      Object.freeze({
        kind: 'particle-effect',
        schemaVersion: 2,
        programFingerprint: actualFingerprint,
        emitters: Object.freeze(emitters as { id: string; capacity: number }[]),
        program: Object.freeze({
          format: VFX_GPU_PROGRAM_FORMAT,
          fingerprint: actualFingerprint,
          emitters: Object.freeze(decodedEmitters),
        }),
      }),
    );
  },
};

export async function loadVfxGpuEffect(
  registry: AssetRegistry,
  guid: string,
): Promise<Result<VfxGpuEffectAsset, unknown>> {
  let parsed: ReturnType<AssetRegistry['parseGuid']>;
  try {
    parsed = registry.parseGuid(guid);
  } catch (error) {
    return err(error);
  }
  return registry.loadByGuid<VfxGpuEffectAsset>(parsed);
}
