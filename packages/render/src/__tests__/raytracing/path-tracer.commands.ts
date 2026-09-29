import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createMaterialLoader,
  materialParametersToParamSchema,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import { serializeCookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { type RaySurfaceProgram, rayMaterialContract } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import type {} from 'vitest/browser';
import { normaliseForPack } from '../../../../import/src/import-runner';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
  cookRayMaterial,
  createMaterialPackCooker,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { prepareDiffuseReconstructionFixture } from './diffuse-reconstruction.commands';
import { prepareRasterRayFixture } from './raster-source.commands';

/** Node-only fixture producer; browser and runtime receive cooked WGSL. */
export async function prepareRayPathFixture() {
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const imports = Object.fromEntries(
    [
      'forgeax_material::ray_abi',
      'forgeax_ray::traversal',
      'forgeax_pbr::ray_bsdf',
      'forgeax_pbr::brdf',
      'forgeax_pbr::lighting_attenuation',
    ].map((id) => [id, sources.get(id).unwrap().source]),
  );
  const kernel = (
    await compileShader(sources.get('forgeax_ray::path_tracer').unwrap().source, {
      id: 'reference-path-tracer',
      imports,
    })
  ).unwrap().wgsl;
  const assets = {
    cutout: Materials.standard({
      renderState: { cullMode: 'none' },
      baseColor: [1, 1, 1, 1],
      roughness: 0.65,
      specular: 0,
      alphaCutoff: 0.5,
      baseColorTexture: { texture: 'coverage', sampler: 'nearest' },
    }),
    matte: Materials.standard({ baseColor: [0.8, 0.4, 0.2, 1], roughness: 0.65, specular: 0 }),
    white: Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.65, specular: 0 }),
    emission: Materials.standard({
      baseColor: [0, 0, 0, 1],
      emissive: [1, 0.5, 0.25],
      emissiveIntensity: 2,
      specular: 0,
    }),
    textured: Materials.standard({
      baseColor: [0.8, 0.4, 0.2, 1],
      roughness: 0.65,
      specular: 0,
      baseColorTexture: { texture: 'checker', sampler: 'linear', coordinates: { set: 1 } },
    }),
    normalMapped: Materials.standard({
      baseColor: [0.8, 0.4, 0.2, 1],
      roughness: 0.65,
      specular: 0,
      normalScale: [1.2, 0.5],
      normalTexture: { texture: 'normal', sampler: 'linear', coordinates: { set: 1 } },
    }),
    metal: Materials.standard({ baseColor: [0.8, 0.7, 0.5, 1], metallic: 1, roughness: 0.5 }),
  };
  const cooker = createMaterialPackCooker([directory]);
  const materials = await Promise.all(
    Object.entries(assets).map(async ([id, asset]) => {
      const draft = await cooker.cook({ guid: id, source: asset });
      // Exercise the publication transport and complete loader gate before the
      // existing GPU reference consumes the selected bytes. No fixture cook of
      // a second ray material stands in for the ordinary publication.
      const record = validateCookedMaterialRecord(
        JSON.parse(JSON.stringify(normaliseForPack((draft.payload as { cooked: unknown }).cooked))),
      ).unwrap();
      const ready = await createMaterialLoader({
        loadPublication: async () => ({ guid: id, record, artifacts: draft.artifacts }),
      }).load({ guid: id, specializationKey: record.specializationKey ?? '' });
      if (ready.status !== 'Ready')
        throw new Error(`ray fixture publication failed: ${JSON.stringify(ready)}`);
      const selected = selectMaterialPassProgram(projectMaterialRecord(ready.record), 'forward', {
        backend: 'webgpu',
        capability: 'storage-buffer',
        pipeline: 'ray',
        geometry: 'mesh',
        pass: 'ray-hit',
        profile: 'forgeax-material-ray-v1',
        toolchain: 'naga-oil',
        instrumentation: 'none',
      });
      const artifact = ready.programs.find(
        (program) => program.specializationKey === selected.specializationKey,
      )?.artifact;
      if (artifact === undefined) throw new Error('selected ray artifact is absent');
      const [firstPass, ...remainingPasses] = ready.record.resolved.passes;
      if (firstPass === undefined || asset.parent !== undefined)
        throw new Error('ray fixture requires a complete root material');
      const resolved: MaterialAsset = {
        ...asset,
        ...ready.record.resolved,
        passes: [firstPass, ...remainingPasses],
      };
      const program: RaySurfaceProgram = {
        context: 'ray-hit',
        wgsl: new TextDecoder().decode(artifact.bytes),
        paramSchema: materialParametersToParamSchema(ready.parameterContract.parameters, id),
        contract: rayMaterialContract(resolved),
        sourceClosureDigest: ready.record.receipt.identity.sourceClosureDigest,
      };
      return {
        name: id,
        asset: resolved,
        program,
        // BrowserCommands is JSON transport, not structured clone.
        cookedPublication: {
          record: serializeCookedMaterialRecord(ready.record),
          artifacts: Object.fromEntries(
            ready.programs.map(({ artifact }) => [artifact.path, Array.from(artifact.bytes)]),
          ),
        },
        publication: {
          program: selected.specializationKey,
          artifactDigest: artifact.digest,
          cookIdentity: ready.record.receipt.identity.cookIdentity,
        },
      };
    }),
  );
  const raster = (
    await cookRayMaterial({ material: 'textured', table: assets, sources, context: 'raster-probe' })
  ).unwrap();
  const bsdf = (
    await compileShader(await readFile(new URL('./bsdf-probe.wgsl', import.meta.url), 'utf8'), {
      id: 'bsdf-probe',
      imports,
    })
  ).unwrap().wgsl;
  const normalRaster = (
    await cookRayMaterial({
      material: 'normalMapped',
      table: assets,
      sources,
      context: 'raster-probe',
    })
  ).unwrap();
  return { kernel, materials, raster, normalRaster, bsdf };
}
export type RayPathFixture = Awaited<ReturnType<typeof prepareRayPathFixture>>;
declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareRayPathFixture(): Promise<RayPathFixture>;
  }
}
export const rayPathCommands = {
  prepareRayPathFixture,
  prepareRasterRayFixture,
  prepareDiffuseReconstructionFixture,
};
