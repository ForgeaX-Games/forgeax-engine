import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseParticleEffectSource } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const demoRoot = resolve(import.meta.dirname, '../..');
const packPath = resolve(demoRoot, 'assets/boss-lightning.pack.json');
const entryPath = resolve(demoRoot, 'src/main.ts');
const scenePath = resolve(demoRoot, 'src/scene.ts');
const materialsPath = resolve(demoRoot, 'assets/boss-lightning-materials.pack.json');
const bossMaterialGuids = [
  '019e9c00-0000-7000-8000-000000000003',
  '019e9c00-0000-7000-8000-000000000004',
  '019e9c00-0000-7000-8000-000000000005',
];

describe('Boss Lightning source and Pack declaration', () => {
  it('uses one source-only authored Pack entry', () => {
    const pack = JSON.parse(readFileSync(packPath, 'utf8')) as {
      schemaVersion: string;
      kind: string;
      assets: Array<{
        guid: string;
        kind: string;
        execution: 'direct' | 'cooked';
        payload: unknown;
        refs: string[];
        artifacts?: Record<string, { path: string }>;
      }>;
    };

    expect(pack).toMatchObject({ schemaVersion: '2.0.0', kind: 'internal-text-package' });
    expect(pack.assets).toHaveLength(1);
    expect(pack.assets[0]).toMatchObject({
      guid: '019e9c00-0000-7000-8000-000000000000',
      kind: 'particle-effect',
      execution: 'cooked',
    });
    const authored = parseParticleEffectSource(pack.assets[0]?.payload);
    expect(authored.ok).toBe(true);
    if (!authored.ok) throw new Error(authored.error.hint);
    expect(authored.value.emitters.map((emitter) => emitter.id)).toEqual([
      'mouth-charge',
      'impact-mesh',
    ]);
    expect(authored.value.emitters.map((emitter) => emitter.output.kind)).toEqual([
      'billboard',
      'mesh',
    ]);
    expect(authored.value.emitters.map((emitter) => emitter.operators.output[0]?.kind)).toEqual([
      'billboard',
      'mesh',
    ]);
    expect(pack.assets[0]?.refs).toEqual([]);
    expect(pack.assets[0]?.artifacts).toEqual({});
  });

  it('does not retain the former source, sidecar, or importer path', () => {
    const vite = readFileSync(resolve(demoRoot, 'vite.config.ts'), 'utf8');
    expect(vite).not.toContain('particleEffectImporter');
    expect(vite).toContain('createParticleEffectNativeCooker');
    expect(vite).toContain('cookers:');
    expect(() => readFileSync(resolve(demoRoot, 'assets/boss-lightning.particle-effect.json'), 'utf8')).toThrow();
    expect(() => readFileSync(resolve(demoRoot, 'assets/boss-lightning.particle-effect.json.meta.json'), 'utf8')).toThrow();
  });

  it('requires the public GUID-to-pixels assembly before the demo turns green', () => {
    const entry = readFileSync(entryPath, 'utf8');
    expect(entry).toContain("loadParticleEffect(assets, '019e9c00-0000-7000-8000-000000000000')");
    expect(entry).toContain('particleSimulationPlugin');
    expect(entry).toContain('particleRenderFeature');
    expect(entry).toContain('ParticleEffectPlayer');
  });

  it('requires a visible Boss, mouth light, ground warning, and strike composition', () => {
    const scene = readFileSync(scenePath, 'utf8');
    const materials = JSON.parse(readFileSync(materialsPath, 'utf8')) as {
      assets: Array<{ guid: string }>;
    };
    expect(scene).toContain('HANDLE_SPHERE');
    expect(scene).toContain('HANDLE_CYLINDER');
    expect(scene).toContain('PointLight');
    expect(scene).toContain('groundWarning');
    expect(scene).toContain('materials.body');
    expect(scene).toContain('materials.strike');
    expect(materials.assets.map(asset => asset.guid)).toEqual(expect.arrayContaining(bossMaterialGuids));
  });
});
