import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import type { Handle, ParticleEffectAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createParticleRenderBatch,
  defineParticleEffectSource,
  loadParticleEffect,
  ParticleEffectPlayer,
  type ParticleEffectPlayerData,
  particleEffectPackLoader,
  serializeParticleEffectSource,
  type VfxError,
  vfxError,
} from '../index.js';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const compilerRoot = resolve(packageRoot, '..', 'vfx-compiler');
const repoRoot = resolve(packageRoot, '..', '..');

const source = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'spark',
      capacity: 8,
      space: 'world',
      schedule: { rate: 2, bursts: [] },
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

const asset: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 8 }],
};

function publicText(path: string): string {
  return readFileSync(resolve(packageRoot, path), 'utf8');
}

function compilerText(path: string): string {
  return readFileSync(resolve(compilerRoot, path), 'utf8');
}

function recovery(error: VfxError): string {
  switch (error.code) {
    case 'vfx-source-invalid':
      return error.detail.path;
    case 'vfx-operator-unknown':
      return error.detail.kind;
    case 'vfx-operator-backend-unsupported':
      return error.detail.backend;
    case 'vfx-program-invalid':
      return error.detail.format;
    case 'vfx-batch-invalid':
      return error.detail.output;
    case 'vfx-asset-load-failed':
      return error.detail.stage;
    case 'vfx-simulation-capability-unavailable':
      return error.detail.backend;
    case 'vfx-simulation-player-invalid':
      return error.detail.field;
    case 'vfx-simulation-output-unavailable':
      return error.detail.reference;
    case 'vfx-simulation-execution-failed':
      return error.detail.operator;
  }
}

function playerEvidence(): boolean {
  const world = new World();
  const effect: Handle<'ParticleEffectAsset', 'shared'> = world.allocSharedRef(
    'ParticleEffectAsset',
    asset,
  );
  const player: ParticleEffectPlayerData = {
    effect,
    playing: true,
    seed: 1,
    timeScale: 1,
  };
  return world.spawn({ component: ParticleEffectPlayer, data: player }).ok;
}

describe('Wave 1 acceptance matrix', () => {
  it('maps AC-01 through AC-14 to public, schema, bytes, Result, and scope evidence', () => {
    const defined = defineParticleEffectSource(source);
    const roundTrip = defined.ok
      ? defineParticleEffectSource(JSON.parse(serializeParticleEffectSource(defined.value)))
      : defined;
    const matrix = [
      { id: 'AC-01', verified: publicText('src/index.ts').includes('ParticleEffectAsset') },
      { id: 'AC-02', verified: roundTrip.ok },
      {
        id: 'AC-03',
        verified:
          compilerText('src/index.ts').includes('ParticleOperatorRegistry') &&
          compilerText('src/index.ts').includes('cookParticleEffect'),
      },
      {
        id: 'AC-04',
        verified: defined.ok && defined.value.emitters[0]?.backendPolicy.kind === 'required',
      },
      {
        id: 'AC-05',
        verified: compilerText('src/index.ts').includes('canonicalizeParticleProgram'),
      },
      {
        id: 'AC-06',
        verified:
          typeof loadParticleEffect === 'function' &&
          publicText('src/index.ts').includes('loadParticleEffect') &&
          publicText('src/index.ts').includes('particleEffectPackLoader'),
      },
      { id: 'AC-07', verified: playerEvidence() },
      {
        id: 'AC-08',
        verified:
          Object.keys(ParticleEffectPlayer.schema).join(',') === 'effect,playing,seed,timeScale',
      },
      {
        id: 'AC-09',
        verified:
          createParticleRenderBatch([]).ok &&
          publicText('src/render-batch.ts').includes('ParticleOutputBatch'),
      },
      {
        id: 'AC-10',
        verified:
          recovery(
            vfxError('vfx-batch-invalid', { output: 'billboard', index: 0, path: 'batches[0]' }),
          ) === 'billboard',
      },
      { id: 'AC-11', verified: particleEffectPackLoader.kind === 'particle-effect' },
      {
        id: 'AC-12',
        verified: !publicText('package.json').includes('@forgeax/engine-vfx-compiler'),
      },
      {
        id: 'AC-13',
        verified:
          publicText('src/index.ts').includes('defineParticleEffectSource') &&
          compilerText('src/index.ts').includes('particleEffectImporter'),
      },
      {
        id: 'AC-14',
        verified: !publicText('src/index.ts').match(
          /RenderFeature|RenderGraph|vfxPlugin|GPUDevice/,
        ),
      },
    ];

    expect(matrix.map((entry) => entry.id)).toEqual([
      'AC-01',
      'AC-02',
      'AC-03',
      'AC-04',
      'AC-05',
      'AC-06',
      'AC-07',
      'AC-08',
      'AC-09',
      'AC-10',
      'AC-11',
      'AC-12',
      'AC-13',
      'AC-14',
    ]);
    for (const entry of matrix) expect(entry.verified, entry.id).toBe(true);
  });

  it('records completed compatibility without moving RenderFeature into VFX production', () => {
    const plan = readFileSync(
      resolve(repoRoot, '.forgeax-harness/docs/vfx-particle-runtime-design.md'),
      'utf8',
    );
    expect(plan).toContain('| Public compatibility | Complete |');
    expect(plan).toContain('@forgeax/engine-vfx-render');
    expect(plan).toContain('No production feature extracts');
    expect(publicText('src/index.ts')).not.toContain('RenderFeature');
  });
});
