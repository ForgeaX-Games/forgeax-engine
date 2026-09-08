import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { resolveMeshMaterialBindings } from '../mesh-material-bindings';

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw new Error(`invalid fixture guid: ${value}`);
  return parsed.value;
}

const DEFAULT_A = guid('019d0000-0000-7000-8000-000000000001');
const DEFAULT_B = guid('019d0000-0000-7000-8000-000000000002');

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(0),
    attributes: {},
    submeshes: [
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 0 },
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 1 },
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [
      { slotName: 'Body', defaultMaterial: DEFAULT_A },
      { slotName: 'Trim', defaultMaterial: DEFAULT_B },
    ],
  };
}

describe('resolveMeshMaterialBindings', () => {
  it('fails closed instead of throwing when a runtime producer omits materialSlots', () => {
    const result = resolveMeshMaterialBindings(
      { ...mesh(), materialSlots: undefined } as unknown as MeshAsset,
      [],
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'mesh-material-slots-missing' });
  });
  const deps = {
    isValidOverride: (handle: number) => handle === 11,
    resolveMeshDefault: (guid: typeof DEFAULT_A) =>
      AssetGuid.format(guid) === AssetGuid.format(DEFAULT_A) ? 21 : 22,
  };

  it('inherits every mesh default for an empty override vector', () => {
    expect(resolveMeshMaterialBindings(mesh(), [], deps)).toEqual({
      ok: true,
      bindings: [
        { handle: 21, source: 'mesh-default' },
        { handle: 22, source: 'mesh-default' },
      ],
      diagnostics: [],
    });
  });

  it('supports partial overrides and treats zero as inherit', () => {
    expect(resolveMeshMaterialBindings(mesh(), [11, 0], deps)).toMatchObject({
      ok: true,
      bindings: [
        { handle: 11, source: 'renderer-override' },
        { handle: 22, source: 'mesh-default' },
      ],
    });
  });

  it('falls back from an invalid override and reports overflow without changing slot count', () => {
    expect(resolveMeshMaterialBindings(mesh(), [99, 0, 11], deps)).toEqual({
      ok: true,
      bindings: [
        { handle: 21, source: 'mesh-default' },
        { handle: 22, source: 'mesh-default' },
      ],
      diagnostics: [
        { code: 'mesh-renderer-material-override-overflow', slotIndex: 2 },
        { code: 'mesh-renderer-material-override-invalid', slotIndex: 0, handle: 99 },
      ],
    });
  });

  it('fails closed when a declared mesh default is unavailable', () => {
    const result = resolveMeshMaterialBindings(mesh(), [], {
      isValidOverride: () => false,
      resolveMeshDefault: () => undefined,
    });
    expect(result).toMatchObject({ ok: false, slotIndex: 0 });
  });
});
