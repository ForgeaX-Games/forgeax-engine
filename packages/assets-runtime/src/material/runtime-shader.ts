import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialParameter, ParamSchemaEntry } from '@forgeax/engine-types';
import type { MaterialReady } from './loader';

const ENGINE_INJECTED_TEXTURE_FIELDS = new Set(['emissiveTexture', 'occlusionTexture']);

function isStandardPbrMaterialShader(shaderId: string): boolean {
  return (
    shaderId === 'forgeax::default-standard-pbr' ||
    shaderId === 'forgeax::pbr-skin' ||
    shaderId === 'forgeax::default-standard-pbr-skin'
  );
}

/** Project authored MaterialAsset parameters into the runtime shader schema. */
export function materialParametersToParamSchema(
  parameters: readonly MaterialParameter[],
  shaderId: string | undefined,
): readonly ParamSchemaEntry[] {
  const engineInjectedTextureFields =
    shaderId !== undefined && isStandardPbrMaterialShader(shaderId)
      ? ENGINE_INJECTED_TEXTURE_FIELDS
      : undefined;
  return parameters.flatMap((parameter): ParamSchemaEntry[] => {
    if (parameter.type === 'bool') return [];
    if (parameter.type === 'texture') {
      if (engineInjectedTextureFields?.has(parameter.name) === true) return [];
      return [{ name: parameter.name, type: 'texture2d' }];
    }
    const defaultValue = parameter.default;
    const numericDefault =
      typeof defaultValue === 'number' ||
      (Array.isArray(defaultValue) && defaultValue.every((item) => typeof item === 'number'))
        ? { default: defaultValue }
        : {};
    return [
      {
        name: parameter.name,
        type: parameter.type,
        ...(parameter.colorSpace === undefined ? {} : { colorSpace: parameter.colorSpace }),
        ...numericDefault,
      },
    ];
  });
}

/** Project authored pass module ids onto the renderer's canonical ids. */
export function runtimeMaterialShaderId(
  module: string | undefined,
  passName?: string,
): string | undefined {
  if (
    passName === 'shadow-caster' &&
    (module === 'forgeax_material::standard' ||
      module === 'forgeax_material::unlit' ||
      module === 'forgeax::default-standard-pbr' ||
      module === 'forgeax::default-unlit')
  ) {
    return 'forgeax::default-shadow-caster';
  }
  switch (module) {
    case 'forgeax_material::standard':
      return 'forgeax::default-standard-pbr';
    case 'forgeax_material::unlit':
      return 'forgeax::default-unlit';
    case 'forgeax_material::sprite':
      return 'forgeax::sprite';
    case 'forgeax_material::sprite-lit':
      return 'forgeax::sprite-lit';
    default:
      return module;
  }
}

function sameSchema(
  left: readonly ParamSchemaEntry[],
  right: readonly ParamSchemaEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isManifestVariantSource(
  shaderRegistry: ShaderRegistry,
  identifier: string,
  source: string,
): boolean {
  const entry = Array.from(shaderRegistry.materialShaderManifestEntries()).find(
    (candidate) => candidate.identifier === identifier,
  );
  return (
    entry?.composedWgsl === source ||
    entry?.variants.some((variant) => variant.composedWgsl === source) === true
  );
}

/**
 * Install every authored pass module from one validated MaterialReady tuple.
 * The publication artifact is the only runtime shader source; no host entry
 * point is allowed to assemble or register the material separately.
 */
export function installMaterialReadyShaders(
  shaderRegistry: ShaderRegistry,
  readiness: MaterialReady,
): void {
  const source = new TextDecoder().decode(readiness.artifact.bytes);
  if (source.length === 0) {
    throw new Error(
      `MaterialReady ${readiness.guid} published an empty ${readiness.artifact.mediaType} shader artifact`,
    );
  }
  for (const pass of readiness.record.resolved.passes) {
    const identifier = runtimeMaterialShaderId(pass.program.module, pass.name);
    if (identifier === undefined) continue;
    const paramSchema = materialParametersToParamSchema(
      readiness.parameterContract.parameters,
      identifier,
    );
    const existing = shaderRegistry.findMaterialArtifact(identifier);
    if (existing.ok) {
      if (
        !sameSchema(existing.value.paramSchema, paramSchema) ||
        (existing.value.source !== source &&
          !isManifestVariantSource(shaderRegistry, identifier, source))
      ) {
        throw new Error(
          `MaterialReady ${readiness.guid} conflicts with the registered shader '${identifier}'`,
        );
      }
      continue;
    }
    shaderRegistry.installMaterialArtifact(identifier, { source, paramSchema });
  }
}
