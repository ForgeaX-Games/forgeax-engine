import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

export interface EngineShaderFile {
  readonly id: string;
  readonly source: string;
  readonly reservedIdentifier?: string | undefined;
}

export interface EngineShaderEntries {
  readonly defaultStandardPbr: EngineShaderFile;
  readonly defaultStandardPbrSkin: EngineShaderFile;
  readonly singleLayerMedium: EngineShaderFile;
  readonly unlit: EngineShaderFile;
  readonly pointsLines: EngineShaderFile;
  readonly tonemap: EngineShaderFile;
  readonly analyticFog: EngineShaderFile;
  /** Renderer-owned seeded 3D cloud density and optical helpers. */
  readonly cloudLayer: EngineShaderFile;
  readonly taaResolve: EngineShaderFile;
  readonly motionBlur: EngineShaderFile;
  readonly depthOfField: EngineShaderFile;
  readonly depthOfFieldMsaa: EngineShaderFile;
  readonly shadowCaster: EngineShaderFile;
  readonly sprite: EngineShaderFile;
  readonly spriteLit: EngineShaderFile;
  readonly msdfText: EngineShaderFile;
  readonly iblEquirectToCube: EngineShaderFile;
  readonly iblIrradiance: EngineShaderFile;
  readonly iblPrefilter: EngineShaderFile;
  readonly iblBrdfLut: EngineShaderFile;
  readonly probeBackground: EngineShaderFile;
  readonly fxaa: EngineShaderFile;
  readonly bloomDownsample: EngineShaderFile;
  readonly bloomUpsample: EngineShaderFile;
  readonly bloomComposite: EngineShaderFile;
  /** Renderer-owned volumetric-fog utility entry points. */
  readonly volumeInject: EngineShaderFile;
  readonly volumeTemporal: EngineShaderFile;
  readonly volumeIntegrate: EngineShaderFile;
  readonly volumeComposite: EngineShaderFile;
  readonly skybox: EngineShaderFile;
  /** Renderer-owned analytic-atmosphere cube producer and background consumer. */
  readonly atmosphereCube: EngineShaderFile;
  readonly atmosphereBackground: EngineShaderFile;
  readonly atmosphereIbl: EngineShaderFile;
  readonly hdrpSsao: EngineShaderFile;
  /** Renderer-owned shared closest-depth pyramid producer. */
  readonly depthPyramidSeed: EngineShaderFile;
  readonly depthPyramidReduce: EngineShaderFile;
  /** Renderer-owned spatial SSR utility entry points. */
  readonly ssrTrace: EngineShaderFile;
  readonly ssrTemporal: EngineShaderFile;
  readonly ssrCompose: EngineShaderFile;
  readonly rayQuery: EngineShaderFile;
  readonly rayPathTracer: EngineShaderFile;
  readonly rayRasterSource: EngineShaderFile;
  readonly rayDiffuseComposite: EngineShaderFile;
  readonly rayDiffuseReconstruct: EngineShaderFile;
  readonly standardDeferred: EngineShaderFile;
  readonly decalProject: EngineShaderFile;
  readonly decalApply: EngineShaderFile;
  readonly imports: Record<string, string>;
}

export function extractDefineImportPath(source: string): string | undefined {
  return DEFINE_IMPORT_PATH_RE.exec(source)?.[1];
}

export const SURFACE_SLOT_MODULE = 'forgeax_material::slot::surface' as const;

/** Project the engine default Surface into the Standard slot identity. */
export function projectSurfaceSlotSource(source: string): string {
  return source.replace(
    /^\s*#define_import_path\s+[^\n]+/m,
    `#define_import_path ${SURFACE_SLOT_MODULE}`,
  );
}

function readEntry(
  srcDir: string,
  fileName: string,
  reservedIdentifier?: string,
): Promise<EngineShaderFile> {
  const id = resolve(srcDir, fileName);
  return readFile(id, 'utf8').then((source) => ({
    id,
    source,
    ...(reservedIdentifier === undefined ? {} : { reservedIdentifier }),
  }));
}

/** Load canonical Engine shader entries and their import closure. */
export async function loadEngineShaderEntries(): Promise<EngineShaderEntries> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@forgeax/engine-shader/package.json');
  const srcDir = resolve(dirname(packageJsonPath), 'src');
  const entries = await Promise.all([
    readEntry(srcDir, 'default-standard-pbr.wgsl', 'forgeax::default-standard-pbr'),
    readEntry(srcDir, 'default-standard-pbr-skin.wgsl', 'forgeax::pbr-skin'),
    readEntry(srcDir, 'single-layer-medium.wgsl', 'forgeax::single-layer-medium'),
    readEntry(srcDir, 'unlit.wgsl', 'forgeax::default-unlit'),
    readEntry(srcDir, 'points-lines.wgsl', 'forgeax::points-lines'),
    readEntry(srcDir, 'tonemap.wgsl'),
    readEntry(srcDir, 'analytic-fog.wgsl', 'forgeax::analytic-fog'),
    readEntry(srcDir, 'cloud.wgsl'),
    readEntry(srcDir, 'taa-resolve.wgsl'),
    readEntry(srcDir, 'motion-blur.wgsl'),
    readEntry(srcDir, 'depth-of-field.wgsl'),
    readEntry(srcDir, 'depth-of-field-msaa.wgsl'),
    readEntry(srcDir, 'shadow_caster.wgsl', 'forgeax::default-shadow-caster'),
    readEntry(srcDir, 'sprite.wgsl', 'forgeax::sprite'),
    readEntry(srcDir, 'sprite-lit.wgsl', 'forgeax::sprite-lit'),
    readEntry(srcDir, 'msdf-text.wgsl', 'forgeax::msdf-text'),
    readEntry(srcDir, 'ibl-equirect-to-cube.wgsl'),
    readEntry(srcDir, 'ibl-irradiance.wgsl'),
    readEntry(srcDir, 'ibl-prefilter.wgsl'),
    readEntry(srcDir, 'ibl-brdf-lut.wgsl'),
    readEntry(srcDir, 'ibl-probe-background.wgsl'),
    readEntry(srcDir, 'fxaa.wgsl'),
    readEntry(srcDir, 'bloom-downsample.wgsl'),
    readEntry(srcDir, 'bloom-upsample.wgsl'),
    readEntry(srcDir, 'bloom-composite.wgsl'),
    readEntry(srcDir, 'volume/volume-inject.wgsl'),
    readEntry(srcDir, 'volume/volume-temporal.wgsl'),
    readEntry(srcDir, 'volume/volume-integrate.wgsl'),
    readEntry(srcDir, 'volume/volume-composite.wgsl'),
    readEntry(srcDir, 'skybox.wgsl'),
    readEntry(srcDir, 'atmosphere-cubemap.wgsl'),
    readEntry(srcDir, 'atmosphere-background.wgsl'),
    readEntry(srcDir, 'atmosphere-ibl.wgsl'),
    readEntry(srcDir, 'hdrp-ssao.wgsl'),
    readEntry(srcDir, 'depth-pyramid-seed.wgsl'),
    readEntry(srcDir, 'depth-pyramid-reduce.wgsl'),
    readEntry(srcDir, 'ssr-trace.wgsl'),
    readEntry(srcDir, 'ssr-temporal.wgsl'),
    readEntry(srcDir, 'ssr-compose.wgsl'),
    readEntry(srcDir, 'ray-query.wgsl'),
    readEntry(srcDir, 'ray-path-tracer.wgsl'),
    readEntry(srcDir, 'ray-raster-source.wgsl'),
    readEntry(srcDir, 'ray-diffuse-composite.wgsl'),
    readEntry(srcDir, 'ray-diffuse-reconstruct.wgsl'),
    readEntry(
      srcDir,
      'standard-deferred-lighting.wgsl',
      'forgeax::engine-standard-deferred-lighting',
    ),
    readEntry(srcDir, 'decal-project.wgsl', 'forgeax::engine-decal-project'),
    readEntry(srcDir, 'decal-apply.wgsl', 'forgeax::engine-decal-apply'),
    readFile(resolve(srcDir, 'common.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'output-encoding.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'brdf.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'pbr-temporal.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'scene-temporal.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'fog.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'standard-cluster.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-shared.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-equirect-to-cube.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-irradiance.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-prefilter.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-brdf-lut.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-sampling.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'tbn.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-directional.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-punctual.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-spot-modifiers.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-rect-area.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-probe.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-attenuation.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-spot-projector.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'fxaa.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'bloom-downsample.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'bloom-upsample.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'bloom-composite.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'skybox.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'atmosphere-daylight.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'hdrp-ssao.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'shadow-pcf.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/clearcoat.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/anisotropy.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/sheen.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/iridescence.wgsl'), 'utf8'),
  ]);
  const [
    surfaceV1,
    defaultStandardSurface,
    surfaceSampling,
    singleLayerMediumSurface,
    defaultSingleLayerMediumSurface,
  ] = await Promise.all([
    readFile(resolve(srcDir, 'surface_v1.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'default_standard_surface.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'surface-sampling.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'single-layer-medium-surface_v1.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'default_single_layer_medium_surface.wgsl'), 'utf8'),
  ]);
  const [
    defaultStandardPbr,
    defaultStandardPbrSkin,
    singleLayerMedium,
    unlit,
    pointsLines,
    tonemap,
    analyticFog,
    cloudLayer,
    taaResolve,
    motionBlur,
    depthOfField,
    depthOfFieldMsaa,
    shadowCaster,
    sprite,
    spriteLit,
    msdfText,
    iblEquirectToCube,
    iblIrradiance,
    iblPrefilter,
    iblBrdfLut,
    probeBackground,
    fxaa,
    bloomDownsample,
    bloomUpsample,
    bloomComposite,
    volumeInject,
    volumeTemporal,
    volumeIntegrate,
    volumeComposite,
    skybox,
    atmosphereCube,
    atmosphereBackground,
    atmosphereIbl,
    hdrpSsao,
    depthPyramidSeed,
    depthPyramidReduce,
    ssrTrace,
    ssrTemporal,
    ssrCompose,
    rayQuery,
    rayPathTracer,
    rayRasterSource,
    rayDiffuseComposite,
    rayDiffuseReconstruct,
    standardDeferred,
    decalProject,
    decalApply,
    common,
    outputEncoding,
    brdf,
    temporal,
    sceneTemporal,
    fog,
    standardCluster,
    iblShared,
    iblEquirectToCubeImport,
    iblIrradianceImport,
    iblPrefilterImport,
    iblBrdfLutImport,
    iblSampling,
    tbn,
    lightingDirectional,
    lightingPunctual,
    lightingSpotModifiers,
    lightingRectArea,
    lightingProbe,
    lightingAttenuation,
    lightingSpotProjector,
    fxaaImport,
    bloomDownsampleImport,
    bloomUpsampleImport,
    bloomCompositeImport,
    skyboxImport,
    atmosphereDaylight,
    hdrpSsaoImport,
    shadowPcf,
    clearcoat,
    anisotropy,
    sheen,
    iridescence,
  ] = entries;
  return {
    defaultStandardPbr,
    defaultStandardPbrSkin,
    singleLayerMedium,
    unlit,
    pointsLines,
    tonemap,
    analyticFog,
    cloudLayer,
    taaResolve,
    motionBlur,
    depthOfField,
    depthOfFieldMsaa,
    shadowCaster,
    sprite,
    spriteLit,
    msdfText,
    iblEquirectToCube,
    iblIrradiance,
    iblPrefilter,
    iblBrdfLut,
    probeBackground,
    fxaa,
    bloomDownsample,
    bloomUpsample,
    bloomComposite,
    volumeInject,
    volumeTemporal,
    volumeIntegrate,
    volumeComposite,
    skybox,
    atmosphereCube,
    atmosphereBackground,
    atmosphereIbl,
    hdrpSsao,
    depthPyramidSeed,
    depthPyramidReduce,
    ssrTrace,
    ssrTemporal,
    ssrCompose,
    rayQuery,
    rayPathTracer,
    rayRasterSource,
    rayDiffuseComposite,
    rayDiffuseReconstruct,
    standardDeferred,
    decalProject,
    decalApply,
    imports: {
      'forgeax_ray::traversal': await readFile(resolve(srcDir, 'ray-traversal.wgsl'), 'utf8'),
      'forgeax_material::ray_abi': await readFile(resolve(srcDir, 'ray-material-abi.wgsl'), 'utf8'),
      'forgeax_pbr::ray_bsdf': await readFile(resolve(srcDir, 'ray-bsdf.wgsl'), 'utf8'),
      'forgeax_material::displacement': await readFile(
        resolve(srcDir, 'standard-displacement.wgsl'),
        'utf8',
      ),
      'forgeax_material::standard_surface': await readFile(
        resolve(srcDir, 'standard-surface.wgsl'),
        'utf8',
      ),
      'forgeax_clipping::planes': await readFile(resolve(srcDir, 'clipping.wgsl'), 'utf8'),
      'forgeax_shadow::surface': await readFile(resolve(srcDir, 'shadow-surface.wgsl'), 'utf8'),
      'forgeax_view::common': common,
      'forgeax_view::output_encoding': outputEncoding,
      'forgeax_pbr::brdf': brdf,
      'forgeax_pbr::specular_aa': await readFile(resolve(srcDir, 'specular-aa.wgsl'), 'utf8'),
      'forgeax_pbr::temporal': temporal,
      forgeax_scene_temporal: sceneTemporal,
      'forgeax_view::fog': fog,
      'forgeax_cloud::layer': cloudLayer.source,
      'forgeax_standard::cluster': standardCluster,
      'forgeax_pbr::ibl_shared': iblShared,
      'forgeax_pbr::ibl_equirect_to_cube': iblEquirectToCubeImport,
      'forgeax_pbr::ibl_irradiance': iblIrradianceImport,
      'forgeax_pbr::ibl_prefilter': iblPrefilterImport,
      'forgeax_pbr::ibl_brdf_lut': iblBrdfLutImport,
      'forgeax_pbr::ibl_sampling': iblSampling,
      'forgeax_pbr::tbn': tbn,
      'forgeax_pbr::lighting_directional': lightingDirectional,
      'forgeax_pbr::lighting_punctual': lightingPunctual,
      'forgeax_pbr::lighting_spot_modifiers': lightingSpotModifiers,
      'forgeax_pbr::lighting_rect_area': lightingRectArea,
      'forgeax_pbr::lighting_probe': lightingProbe,
      'forgeax_pbr::lighting_attenuation': lightingAttenuation,
      'forgeax_pbr::lighting_spot_projector': lightingSpotProjector,
      'forgeax_view::fxaa': fxaaImport,
      'forgeax_view::bloom_downsample': bloomDownsampleImport,
      'forgeax_view::bloom_upsample': bloomUpsampleImport,
      'forgeax_view::bloom_composite': bloomCompositeImport,
      'forgeax_view::skybox': skyboxImport,
      'forgeax_environment::daylight': atmosphereDaylight,
      'forgeax_hdrp::ssao': hdrpSsaoImport,
      'forgeax_pbr::standard_lighting': await readFile(
        resolve(srcDir, 'standard-lighting.wgsl'),
        'utf8',
      ),
      'forgeax_pbr::gbuffer': await readFile(resolve(srcDir, 'standard-gbuffer.wgsl'), 'utf8'),
      'forgeax_pbr::gbuffer_output': await readFile(
        resolve(srcDir, 'standard-gbuffer-output.wgsl'),
        'utf8',
      ),
      'forgeax_pbr::shadow_pcf': shadowPcf,
      'forgeax_pbr::clearcoat': clearcoat,
      'forgeax_pbr::anisotropy': anisotropy,
      'forgeax_pbr::sheen': sheen,
      'forgeax_pbr::iridescence': iridescence,
      'forgeax_material::alpha_hash': await readFile(resolve(srcDir, 'alpha-hash.wgsl'), 'utf8'),
      'forgeax_material::oit': await readFile(resolve(srcDir, 'oit.wgsl'), 'utf8'),
      'forgeax_material::surface_v1': surfaceV1,
      'forgeax_material::single_layer_medium_surface_v1': singleLayerMediumSurface,
      'forgeax_material::default_single_layer_medium_surface': defaultSingleLayerMediumSurface,
      'forgeax_material::default_standard_surface': defaultStandardSurface,
      'forgeax_material::surface_sampling': surfaceSampling,
      [SURFACE_SLOT_MODULE]: projectSurfaceSlotSource(defaultStandardSurface),
    },
  };
}

/** Load package-owned shader entries into the shared Engine input shape. */
export async function loadPackageMaterialShaderEntries(
  packageName: string,
): Promise<EngineShaderFile[]> {
  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const prefix = '@forgeax/engine-';
    if (!packageName.startsWith(prefix)) return [];
    const workspaceName = packageName.slice(prefix.length);
    let current = process.cwd();
    while (true) {
      const candidate = resolve(current, 'packages', workspaceName);
      if (existsSync(resolve(candidate, 'package.json'))) {
        packageRoot = candidate;
        break;
      }
      const parent = dirname(current);
      if (parent === current) return [];
      current = parent;
    }
  }
  const shaderRoot = resolve(packageRoot, 'src', 'shaders');
  let names: string[];
  try {
    names = await readdir(shaderRoot);
  } catch {
    return [];
  }
  const result: EngineShaderFile[] = [];
  for (const name of names.filter((value) => value.endsWith('.wgsl')).sort()) {
    const id = resolve(shaderRoot, name);
    const source = await readFile(id, 'utf8');
    const identifier = extractDefineImportPath(source);
    if (identifier === undefined) continue;
    result.push({ id, source, reservedIdentifier: identifier });
  }
  return result;
}
