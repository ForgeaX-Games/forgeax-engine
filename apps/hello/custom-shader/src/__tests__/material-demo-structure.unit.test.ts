import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appRoot = new URL('../..', import.meta.url);
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const shader = readFileSync(new URL('../pulse-material.wgsl', import.meta.url), 'utf8');
const fixture = JSON.parse(
  readFileSync(new URL('../../assets/pulse-material.pack.json', import.meta.url), 'utf8'),
);

describe('material-inheritance-demo structure', () => {
  it('loads root and derived MaterialAsset records through the runtime', () => {
    expect(source).toContain('loadByGuid<MaterialAsset>');
    expect(source).toContain('createMaterialLoader');
    expect(source).toContain('loadCookedMaterial');
    expect(source).toContain('materialFromCookedRecord');
    expect(source).toContain('rootMaterialHandle');
    expect(source).toContain('derivedMaterialHandle');
    expect(source).toContain('rebindMaterialTextures');
    expect(source).toContain('world.set(derivedEntity, MeshRenderer');
    expect(source).toContain('liveMutation');
    expect(source).toContain("materials: [rootMaterialHandle]");
    expect(source).toContain("materials: [derivedMaterialHandle]");
    expect(source).not.toContain('const materialHandle');
    expect(source).not.toContain(['install', 'MaterialArtifact'].join(''));
  });

  it('keeps the derived values limited to color while sharing a dynamic shader', () => {
    const rows = fixture.assets.filter((asset: { kind?: string }) => asset.kind === 'material');
    expect(rows).toHaveLength(2);
    expect(rows.some((asset: { payload?: { role?: string } }) => asset.payload?.role === 'root')).toBe(true);
    expect(rows.some((asset: { payload?: { role?: string } }) => asset.payload?.role === 'derived')).toBe(true);
    expect(rows.every((asset: { payload?: { cooked?: { schemaVersion?: string } } }) => asset.payload?.cooked?.schemaVersion === 'material-cook/3')).toBe(true);
    expect(shader).toMatch(/sin\(/);
    expect(shader).toMatch(/time/);
  });

  it('makes per-slot coordinates and transforms observable', () => {
    expect(source).toContain('toMaterialAsset');
    expect(source).toContain('satisfies GltfMaterialIr');
    expect(source).toContain('texCoord: 0');
    expect(source).toContain('texCoord: 1');
    expect(JSON.stringify(fixture)).toContain('coordinates');
    expect(JSON.stringify(fixture)).toContain('transform');
    expect(JSON.stringify(fixture)).toContain('baseColorTexture');
    expect(JSON.stringify(fixture)).toContain('normalTexture');
    expect(appRoot.pathname).toContain('custom-shader');
  });

  it('keeps identity texture coordinates implicit and preserves cooked refs', () => {
    const root = fixture.assets.find(
      (asset: { payload?: { role?: string } }) => asset.payload?.role === 'root',
    );
    expect(root?.payload?.values?.baseColorTexture).toBe(
      '01935b00-7d8c-7c4e-9f12-345678abcd11',
    );
    expect(root?.payload?.values?.baseColorTexture).not.toEqual(
      expect.objectContaining({ coordinates: expect.anything() }),
    );
    expect(root?.payload?.cooked?.refs?.textures).toEqual([
      '01935b00-7d8c-7c4e-9f12-345678abcd11',
      '01935b00-7d8c-7c4e-9f12-345678abcd12',
    ]);
    expect(root?.payload?.cooked?.resolved?.values?.baseColorTexture).toBe(
      '01935b00-7d8c-7c4e-9f12-345678abcd11',
    );
    const derived = fixture.assets.find(
      (asset: { payload?: { role?: string } }) => asset.payload?.role === 'derived',
    );
    expect(derived?.payload?.cooked?.authored?.values).toEqual({
      baseColor: [0.2, 0.55, 0.95, 1],
    });
  });
});
