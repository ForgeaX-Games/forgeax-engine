import type { BindGroupLayout, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import type { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { PipelineState } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';

const receipt = createStandardPbrArtifactReceipt();
const materialShaderId = 'forgeax::default-standard-pbr';

/** Receipt-backed fixture for tests of scene identity and raster resource routing. */
export function preparedPbrSnapshot(source: RenderableSnapshot): RenderableSnapshot {
  const material = { ...source.material, materialShaderId: materialShaderId };
  return {
    ...source,
    material,
    materials: source.materials.map((value) => ({ ...value, materialShaderId: materialShaderId })),
    gpuDrivenDraws: (source.gpuDrivenDraws ?? []).map((draw) => ({
      ...draw,
      pipelineClass: `${materialShaderId}|${draw.topology}|rigid`,
      materialResourceClass: 'standard-pbr-resources',
      prepared: {
        identity: { material: materialShaderId, geometry: 'fixture', deformation: 'rigid' },
        receiptGeneration: receipt.generation,
        directEntry: receipt.directEntry,
        sceneIndexEntry: receipt.sceneIndexEntry,
        materialRow: receipt.materialRow,
        resourceSlots: receipt.resourceSlots,
        uvSets: receipt.uvSets,
        vertexInputs: receipt.vertexInputs,
        alphaMask: receipt.alphaMask,
        skinPaletteAddress: receipt.skinPaletteAddress,
        topology: draw.topology,
        indexed: draw.kind === 'indexed',
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
      },
    })),
  };
}

export function standardPbrInputs(
  device: RhiDevice,
  shader: ShaderModule,
  viewLayout: BindGroupLayout,
): Pick<
  Parameters<GpuDrivenProduction['prepare']>[0],
  'standardPbrArtifact' | 'standardPbrPipelineState'
> {
  const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const meshLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } }],
    })
    .unwrap();
  const instancesLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const pbrPipelineLayout = device
    .createPipelineLayout({
      bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
    })
    .unwrap();
  const programKey = standardPbrProgramKey(materialShaderId);
  if (programKey === undefined) throw new Error(`unsupported fixture material ${materialShaderId}`);
  const artifact = {
    material: materialShaderId,
    pass: 'forward',
    program: createMaterialShaderProgram('synthetic'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: receipt.vertexInputs as unknown as readonly Readonly<Record<string, unknown>>[],
    receipt,
  };
  return {
    standardPbrArtifact: artifact,
    // These tests stop before material binding; only the raster layout is consumed.
    standardPbrPipelineState: {
      pbrPipelineLayout,
      meshBindGroupLayout: meshLayout,
      instancesBindGroupLayout: instancesLayout,
      gpuDrivenInstancesBindGroupLayout: instancesLayout,
      gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
      standardPbrShaderModule: shader,
      gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
      standardPbrShaderUvSetCount: 1,
    } as unknown as PipelineState,
  };
}
