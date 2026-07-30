import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  createParticleRenderBatch,
  defineParticleEffectSource,
  loadParticleEffect,
  ParticleEffectPlayer,
  particleEffectPackLoader,
} from '../index.js';

const packageRoot = resolve(import.meta.dirname, '..', '..');

function productionSource(root: string): string {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(productionSource(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(readFileSync(path, 'utf8'));
    }
  }
  return files.join('\n');
}

function assets(): AssetRegistry {
  const shader = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Wave 1 scope test must not execute shader work');
      },
    },
    manifestUrl: undefined,
  });
  const registry = new AssetRegistry(shader);
  registry.loaders.registerPackLoader(particleEffectPackLoader);
  return registry;
}

describe('Wave 1 VFX negative scope', () => {
  it('keeps public contract operations data-only and side-effect free', async () => {
    const source = {
      schemaVersion: 1,
      emitters: [
        {
          id: 'spark',
          capacity: 4,
          space: 'world',
          schedule: { rate: 0, bursts: [] },
          bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
          backendPolicy: { kind: 'required', backend: 'cpu' },
          operators: {
            spawn: [{ kind: 'spawn-rate', version: 1, params: {} }],
            initialize: [{ kind: 'set-life', version: 1, params: {} }],
            update: [{ kind: 'gravity', version: 1, params: {} }],
            output: [{ kind: 'billboard', version: 1, params: {} }],
          },
          output: { kind: 'billboard', material: 'material-guid' },
        },
      ],
    };
    const originalFetch = globalThis.fetch;
    const defined = defineParticleEffectSource(source);
    const loaded = await loadParticleEffect(assets(), 'not-a-guid');
    const batch = createParticleRenderBatch([]);

    expect(defined.ok).toBe(true);
    expect(loaded.ok).toBe(false);
    expect(batch).toEqual({ ok: true, value: { batches: [] } });
    expect(ParticleEffectPlayer.schema).toEqual({
      effect: 'shared<ParticleEffectAsset>',
      playing: 'bool',
      seed: 'u32',
      timeScale: 'f32',
    });
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('contains no production path for live simulation or rendering execution', () => {
    const runtimeSource = productionSource(resolve(packageRoot, 'src'));
    const compilerSource = productionSource(resolve(packageRoot, '..', 'vfx-compiler', 'src'));

    expect(runtimeSource).not.toMatch(
      /ParticleEffectInstance|ParticleEmitterInstance|RenderGraph|RenderFeature|Renderer|Device|RHI|vfxPlugin|requestAnimationFrame|setInterval|create(Compute|Render)Pipeline|createBuffer|submit|\bdraw(Indexed|Indirect)?\b|gameplay/i,
    );
    expect(compilerSource).not.toMatch(
      /ParticleEffectInstance|ParticleEmitterInstance|RenderGraph|RenderFeature|Renderer|Device|RHI|vfxPlugin|requestAnimationFrame|setInterval|create(Compute|Render)Pipeline|createBuffer|submit|\bdraw(Indexed|Indirect)?\b|gameplay/i,
    );
  });
});
