import { readFileSync } from 'node:fs';
import type { ParticleRendererSource } from '@forgeax/engine-vfx';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  createVfxRenderInspectSnapshot,
  topologyRecoveryHint,
  VfxRenderInspectInput,
} from '../feature/gpu-particle-feature.js';
import type {
  ParticleMaterialPass,
  particleMaterialPass,
  TopologyResourcePlan,
} from '../feature/particle-resources.js';
import type { VfxStagePlanObservation } from '../feature/stage-plan.js';

type RendererKind = ParticleRendererSource['kind'];
type TopologyRenderer = Extract<ParticleRendererSource, { readonly capacity: number }>;
type TopologyKind = TopologyRenderer['kind'];
type StageOutput = VfxStagePlanObservation['stageOutput'];

const gpuFeatureSource = readFileSync(
  new URL('../feature/gpu-particle-feature.ts', import.meta.url),
  'utf8',
);
const particleResourcesSource = readFileSync(
  new URL('../feature/particle-resources.ts', import.meta.url),
  'utf8',
);
const normalizedGpuFeatureSource = gpuFeatureSource.replace(/\s+/g, ' ');
const normalizedParticleResourcesSource = particleResourcesSource.replace(/\s+/g, ' ');

describe('VFX render vocabulary owners', () => {
  it('keeps the full renderer vocabulary exact and bilateral', () => {
    expectTypeOf<RendererKind>().toEqualTypeOf<
      'billboard' | 'mesh' | 'ribbon' | 'trail' | 'beam'
    >();
    expectTypeOf<RendererKind>().toEqualTypeOf<VfxRenderInspectInput['topology']>();
    expectTypeOf<VfxRenderInspectInput['topology']>().toEqualTypeOf<RendererKind>();
    expectTypeOf<
      Parameters<typeof createVfxRenderInspectSnapshot>[0]['topology']
    >().toEqualTypeOf<RendererKind>();
    expectTypeOf<Parameters<typeof particleMaterialPass>[0]>().toEqualTypeOf<RendererKind>();
    expectTypeOf<ParticleMaterialPass>().toEqualTypeOf<ReturnType<typeof particleMaterialPass>>();
  });

  it('derives topology-only views from required-capacity renderers', () => {
    expectTypeOf<TopologyKind>().toEqualTypeOf<'ribbon' | 'trail' | 'beam'>();
    expectTypeOf<TopologyKind>().toEqualTypeOf<Parameters<typeof topologyRecoveryHint>[0]>();
    expectTypeOf<Parameters<typeof topologyRecoveryHint>[0]>().toEqualTypeOf<TopologyKind>();
    expectTypeOf<TopologyResourcePlan['topology']>().toEqualTypeOf<TopologyKind>();
    expectTypeOf<TopologyKind>().toEqualTypeOf<TopologyResourcePlan['topology']>();
  });

  it('derives stage output and keeps the private emitter state projection', () => {
    expectTypeOf<StageOutput>().toEqualTypeOf<'active' | 'last-known-good' | 'empty'>();
    expect(normalizedGpuFeatureSource).toContain(
      "type VfxStageOutput = VfxStagePlanObservation['stageOutput'];",
    );
    expect(gpuFeatureSource).toContain('stageOutput: VfxStageOutput;');
    expect(gpuFeatureSource).not.toContain("stageOutput: 'active' | 'last-known-good' | 'empty';");
  });

  it('keeps both production projections derived from the source owner', () => {
    expect(normalizedGpuFeatureSource).toContain(
      "type ParticleRendererKind = ParticleRendererSource['kind'];",
    );
    expect(normalizedParticleResourcesSource).toContain(
      "type ParticleRendererKind = ParticleRendererSource['kind'];",
    );
    expect(normalizedGpuFeatureSource).toContain(
      'type ParticleTopologyRenderer = Extract<ParticleRendererSource, { readonly capacity: number }>;',
    );
    expect(normalizedParticleResourcesSource).toContain(
      'type ParticleTopologyRenderer = Extract<ParticleRendererSource, { readonly capacity: number }>;',
    );
    expect(gpuFeatureSource).toContain('readonly topology: ParticleRendererKind;');
    expect(gpuFeatureSource).toContain('topology: ParticleTopologyKind,');
    expect(particleResourcesSource).toContain('readonly topology: ParticleTopologyKind;');
    expect(particleResourcesSource).toContain('kind: ParticleRendererKind,');
  });
});
