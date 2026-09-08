import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  type AssetDecoderContribution,
  type AssetKind,
  type AssetLoadError,
  err,
  MATERIAL_TEXTURE_SLOTS,
  type MaterialAsset,
  ok,
  type RenderPipelineAsset,
  type SamplerAsset,
} from '@forgeax/engine-types';

function invalid(guid: string, expected: string, reason: string) {
  return err({
    code: 'asset-package-invalid' as const,
    expected,
    hint: 'recook the render asset and publish its complete cooked payload',
    detail: { guid, reason },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validMaterial(value: unknown): value is MaterialAsset {
  if (!record(value) || value.kind !== 'material') return false;
  if (value.cooked !== undefined && !validateCookedMaterialRecord(value.cooked).ok) {
    return false;
  }
  if (value.passes !== undefined && !Array.isArray(value.passes)) return false;
  if (value.parameters !== undefined && !Array.isArray(value.parameters)) return false;
  return value.values === undefined || record(value.values);
}

function resolveMaterialWireRef(
  value: unknown,
  refs: readonly string[],
  field: string,
  guid: string,
): ReturnType<typeof ok<string | number>> | ReturnType<typeof err<AssetLoadError>> {
  if (typeof value !== 'number') return ok(value as string | number);
  if (!Number.isSafeInteger(value) || value < 0 || refs[value] === undefined) {
    return err<AssetLoadError>({
      code: 'asset-package-invalid',
      expected: `${field} to reference a GUID through the material Pack refs[] table`,
      hint: 'recook the material so every texture or sampler ref has a matching refs[] entry',
      detail: { guid, reason: `${field} refs[${value}] is out of bounds` },
    });
  }
  return ok(refs[value] as string);
}

function resolveMaterialWireRefs(
  value: MaterialAsset,
  refs: readonly string[],
  guid: string,
): ReturnType<typeof ok<MaterialAsset>> | ReturnType<typeof err<AssetLoadError>> {
  if (refs.length === 0) return ok(value);

  let changed = false;
  let parent = value.parent;
  if (typeof parent === 'number') {
    const resolved = resolveMaterialWireRef(parent, refs, 'parent', guid);
    if (!resolved.ok) return resolved;
    parent = resolved.value as unknown as MaterialAsset['parent'];
    changed = true;
  }

  if (value.values === undefined) {
    return changed ? ok({ ...value, ...(parent === undefined ? {} : { parent }) }) : ok(value);
  }

  const textureFields = new Set(
    value.parameters === undefined
      ? MATERIAL_TEXTURE_SLOTS
      : value.parameters
          .filter((parameter) => parameter.type === 'texture')
          .map((parameter) => parameter.name),
  );
  const values = { ...value.values };
  for (const [field, raw] of Object.entries(values)) {
    if (typeof raw === 'number' && textureFields.has(field)) {
      const resolved = resolveMaterialWireRef(raw, refs, field, guid);
      if (!resolved.ok) return resolved;
      values[field] = resolved.value as NonNullable<MaterialAsset['values']>[string];
      changed = true;
      continue;
    }
    if (!record(raw)) continue;
    const rawRecord = raw as unknown as Record<string, unknown>;
    let rewritten: Record<string, unknown> | undefined;
    for (const key of ['texture', 'sampler'] as const) {
      if (!(key in rawRecord)) continue;
      const resolved = resolveMaterialWireRef(rawRecord[key], refs, `${field}.${key}`, guid);
      if (!resolved.ok) return resolved;
      if (resolved.value !== rawRecord[key]) {
        rewritten ??= { ...rawRecord };
        rewritten[key] = resolved.value;
        changed = true;
      }
    }
    if (rewritten !== undefined) {
      values[field] = rewritten as unknown as NonNullable<MaterialAsset['values']>[string];
    }
  }
  return ok(changed ? { ...value, ...(parent === undefined ? {} : { parent }), values } : value);
}

export const materialContribution: AssetDecoderContribution<MaterialAsset, 'material'> = {
  kind: { kind: 'material' } as AssetKind<MaterialAsset, 'material'>,
  consumer: 'Render MaterialScene',
  decoder: {
    async decode({ envelope }) {
      if (!validMaterial(envelope.payload)) {
        return invalid(
          envelope.guid,
          'a material payload with cooked passes, parameters, and values',
          'material owner validation failed',
        );
      }
      return resolveMaterialWireRefs(envelope.payload, envelope.refs, envelope.guid);
    },
  },
};

export const samplerContribution: AssetDecoderContribution<SamplerAsset, 'sampler'> = {
  kind: { kind: 'sampler' } as AssetKind<SamplerAsset, 'sampler'>,
  consumer: 'Render DeviceScope',
  decoder: {
    async decode({ envelope }) {
      return envelope.payload.kind === 'sampler'
        ? ok(envelope.payload)
        : invalid(envelope.guid, 'a sampler payload', 'sampler owner validation failed');
    },
  },
};

export const renderPipelineContribution: AssetDecoderContribution<
  RenderPipelineAsset,
  'render-pipeline'
> = {
  kind: { kind: 'render-pipeline' } as AssetKind<RenderPipelineAsset, 'render-pipeline'>,
  consumer: 'Render Pipeline',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      return payload.kind === 'render-pipeline' && payload.pipelineId.trim().length > 0
        ? ok(payload)
        : invalid(
            envelope.guid,
            'a render-pipeline payload with a pipelineId',
            'render-pipeline owner validation failed',
          );
    },
  },
};
