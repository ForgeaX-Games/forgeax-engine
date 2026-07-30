import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Result } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import { type VfxCause, type VfxError, vfxError } from './errors.js';
import type { LoadedParticleEffect } from './runtime-program.js';

const DEFAULT_PACK_INDEX_URL = '/pack-index.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function causeOf(value: unknown): VfxCause {
  if (!isRecord(value)) {
    return {
      code: 'asset-load-failed',
      expected: 'the particle effect dependencies to be ready',
      hint: 'repair the reported asset dependency and retry the load',
    };
  }
  return {
    code: typeof value.code === 'string' ? value.code : 'asset-load-failed',
    expected:
      typeof value.expected === 'string'
        ? value.expected
        : 'the particle effect dependencies to be ready',
    hint:
      typeof value.hint === 'string'
        ? value.hint
        : 'repair the reported asset dependency and retry the load',
  };
}

function packageUrlOf(registry: AssetRegistry, guid: string): string {
  return registry.packageOf(guid)?.path ?? DEFAULT_PACK_INDEX_URL;
}

function loadError(registry: AssetRegistry, guid: string, value: unknown): VfxError {
  const detail = isRecord(value) && isRecord(value.detail) ? value.detail : undefined;
  const errorCause = causeOf(value);
  if (
    isRecord(value) &&
    value.code === 'vfx-asset-load-failed' &&
    detail !== undefined &&
    typeof detail.guid === 'string' &&
    typeof detail.stage === 'string'
  ) {
    if (detail.stage === 'reference' && typeof detail.reference === 'string') {
      return vfxError('vfx-asset-load-failed', {
        guid: detail.guid,
        stage: 'reference',
        reference: detail.reference,
        cause: causeOf(detail.cause),
      });
    }
    if (detail.stage === 'artifact' && typeof detail.artifact === 'string') {
      return vfxError('vfx-asset-load-failed', {
        guid: detail.guid,
        stage: 'artifact',
        packageUrl:
          typeof detail.packageUrl === 'string' ? detail.packageUrl : DEFAULT_PACK_INDEX_URL,
        artifact: detail.artifact,
        cause: causeOf(detail.cause),
      });
    }
    if (detail.stage === 'package' && typeof detail.packageUrl === 'string') {
      return vfxError('vfx-asset-load-failed', {
        guid: detail.guid,
        stage: 'package',
        packageUrl: detail.packageUrl,
        cause: causeOf(detail.cause),
      });
    }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    (value as { code: string }).code.startsWith('asset-artifact-')
  ) {
    const artifact =
      detail !== undefined && typeof detail.artifactKey === 'string'
        ? detail.artifactKey
        : 'unknown';
    return vfxError('vfx-asset-load-failed', {
      guid,
      stage: 'artifact',
      packageUrl: packageUrlOf(registry, guid),
      artifact,
      cause: errorCause,
    });
  }
  if (detail !== undefined && typeof detail.subAssetGuid === 'string') {
    return vfxError('vfx-asset-load-failed', {
      guid,
      stage: 'reference',
      reference: detail.subAssetGuid,
      cause: errorCause,
    });
  }
  return vfxError('vfx-asset-load-failed', {
    guid,
    stage: 'package',
    packageUrl: packageUrlOf(registry, guid),
    cause: errorCause,
  });
}

export async function loadParticleEffect(
  registry: AssetRegistry,
  guid: string,
): Promise<Result<LoadedParticleEffect, VfxError>> {
  let parsed: ReturnType<AssetRegistry['parseGuid']>;
  try {
    parsed = registry.parseGuid(guid);
  } catch (error) {
    return err(loadError(registry, guid, error));
  }
  const loaded = await registry.loadByGuid<LoadedParticleEffect>(parsed);
  if (!loaded.ok) return err(loadError(registry, guid, loaded.error));
  return loaded;
}
