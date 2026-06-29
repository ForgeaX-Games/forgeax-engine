import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import metaSchemaJson from '../schema/meta.schema.json' with { type: 'json' };
import packSchemaJson from '../schema/pack.schema.json' with { type: 'json' };

const ajv = new Ajv({ strict: true, allErrors: false });
addFormats(ajv, ['uuid']);

// Module-top-level compiled validators - compiled once on import, never recreated.
export const validateMeta = ajv.compile(metaSchemaJson);
export const validatePack = ajv.compile(packSchemaJson);

// === SceneAsset payload validator factory (feat-20260514 w5 / D-P4) =============
//
// Decision anchors:
//   - plan-strategy §D-P4 (per-component additionalProperties:false, path a;
//     path b "extend PackErrorDetail" rejected to keep the 8-member
//     PackErrorCode closed union frozen)
//   - requirements §AC-08(b) (typo field name fail-fast through ajv with the
//     verbatim 'additional properties' message wording)
//   - requirements §AC-10 (no new SceneErrorCode / PackErrorCode introduced)
//
// `buildSceneAssetValidator(componentSchemas)` returns a fresh ajv
// `ValidateFunction` whose JSON Schema sub-tree describes:
//   {
//     kind: 'scene',
//     nodes: SceneEntity[]
//   }
// where each SceneEntity has the closed shape
//   { localId: integer, components: <closed map keyed by registered tokens> }
// and the per-component sub-schema is composed verbatim from the caller's
// `componentSchemas[name]` entry. `additionalProperties: false` is applied
// at three layers: top-level SceneAsset, SceneEntity, and SceneEntity.components,
// so ajv emits an `additional properties` ajvError on any typo or unknown
// component token (AC-08(b)).
//
// The runtime layer feeds `componentSchemas` from the live `defineComponent`
// registry; this factory itself stays ECS-free (charter proposition 5
// consistent abstraction: pack package is layered below ecs and runtime,
// the per-component schemas arrive as plain ajv-compatible JSON Schema
// objects).
export function buildSceneAssetValidator(
  componentSchemas: Readonly<Record<string, object>>,
): ValidateFunction {
  // Use a separate ajv instance so the dynamically registered closed map of
  // component sub-schemas does not pollute the module-top-level validators
  // above (they may be re-built across test fixtures with different
  // component sets).
  const localAjv = new Ajv({ strict: true, allErrors: false });
  addFormats(localAjv, ['uuid']);

  const componentsProperties: Record<string, object> = {};
  for (const [name, sub] of Object.entries(componentSchemas)) {
    componentsProperties[name] = sub;
  }

  // MountOverride schema (feat-20260608-scene-nesting-ecs-fication M1 / w11;
  // requirements §S-10): validates each entry in mounts[].overrides[] —
  // localId / comp / field / value (free-form). Field-level type validation
  // (matching the schema vocab) is enforced at runtime via setSceneOverride
  // (D-9 / EcsErrorCode 'scene-override-type-mismatch').
  const mountOverrideSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['localId', 'comp', 'field', 'value'],
    properties: {
      localId: { type: 'integer', minimum: 0 },
      comp: { type: 'string', minLength: 1 },
      field: { type: 'string', minLength: 1 },
      value: {},
    },
  };

  // SceneInstanceMount schema (feat-20260608-scene-nesting-ecs-fication
  // M1 / w11; requirements §S-10): validates each mounts[] entry. parent /
  // components / overrides are optional; cross-mount window collision and
  // mount.source / mount.memberCount agreement with referenced child
  // SceneAsset are checked at the build-time scanner (D-1, w14), not here.
  const mountSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['localId', 'source', 'memberFirst', 'memberCount'],
    properties: {
      localId: { type: 'integer', minimum: 0 },
      source: { type: 'integer', minimum: 0 },
      memberFirst: { type: 'integer', minimum: 0 },
      memberCount: { type: 'integer', minimum: 0 },
      parent: { type: 'integer', minimum: 0 },
      components: {
        type: 'object',
        additionalProperties: false,
        properties: componentsProperties,
      },
      overrides: {
        type: 'array',
        items: mountOverrideSchema,
      },
    },
  };

  const sceneSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'entities'],
    properties: {
      kind: { type: 'string', const: 'scene' },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['localId', 'components'],
          properties: {
            localId: { type: 'integer', minimum: 0 },
            components: {
              type: 'object',
              additionalProperties: false,
              properties: componentsProperties,
            },
          },
        },
      },
      // Optional top-level mounts[] (feat-20260608-scene-nesting-ecs-fication
      // M1 / w11). Missing mounts is semantically equivalent to mounts: []
      // (plan-strategy §6.3 back-compat); ajv default produces the empty
      // array on absent input.
      mounts: {
        type: 'array',
        items: mountSchema,
      },
    },
  };

  return localAjv.compile(sceneSchema);
}

// === MaterialAsset payload validator factory (feat-20260523-shader-template-instance-split M1-T06) ===
//
// Decision anchors:
//   - plan-strategy D-PackKind (factory pattern, same shape as buildSceneAssetValidator)
//   - plan-strategy D-ParamTypeWhitelist (paramTypeWhitelist consumed here)
//   - requirements AC-04 (v1 type set SSOT; validator covers all param type boundaries)
//
// `buildMaterialAssetValidator(paramTypeWhitelist)` returns an ajv
// `ValidateFunction` that validates:
//   {
//     materialShader: string,
//     paramSchema: ParamSchemaEntry[],
//     paramValues: object
//   }
// Each ParamSchemaEntry.type must be in the whitelist (D-ParamTypeWhitelist).
// `additionalProperties: false` at top level so ajv rejects unknown fields.
// paramValues is free-form (object) — the runtime layer does deeper validation.
//
// Uses a separate ajv instance per call so different whitelists across
// test fixtures do not pollute the module-top-level validators.
export function buildMaterialAssetValidator(
  paramTypeWhitelist: ReadonlySet<string>,
): ValidateFunction {
  const localAjv = new Ajv({ strict: true, allErrors: false });

  const whitelistEnum = Array.from(paramTypeWhitelist);

  const paramSchemaEntry = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: whitelistEnum },
      default: {},
    },
  };

  const materialSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['materialShader', 'paramSchema', 'paramValues'],
    properties: {
      materialShader: { type: 'string', minLength: 1 },
      paramSchema: {
        type: 'array',
        items: paramSchemaEntry,
      },
      paramValues: { type: 'object' },
    },
  };

  return localAjv.compile(materialSchema);
}
