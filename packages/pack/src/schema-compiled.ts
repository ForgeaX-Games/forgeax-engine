import type { PackV2 } from '@forgeax/engine-types';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import metaSchemaJson from '../schema/meta.schema.json' with { type: 'json' };
import packSchemaJson from '../schema/pack.schema.json' with { type: 'json' };

const ajv = new Ajv({ strict: true, allErrors: false });
addFormats(ajv, ['uuid']);

// Module-top-level compiled validators - compiled once on import, never recreated.
export const validateMeta = ajv.compile(metaSchemaJson);
export const validatePack = ajv.compile(packSchemaJson);

export function validatePackV2(value: unknown): value is PackV2 {
  if (!validatePack(value) || !isPackV2Shape(value)) return false;

  const seenGuids = new Set<string>();
  for (const asset of value.assets) {
    if (seenGuids.has(asset.guid)) return false;
    seenGuids.add(asset.guid);
  }
  return true;
}

function isPackV2Shape(value: unknown): value is PackV2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === '2.0.0'
  );
}

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

  const componentsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: componentsProperties,
  };
  const instanceSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: {
      // Authored scenes use a GUID string. Pack output may carry a refs[]
      // index, which is resolved by the Scene decoder before instantiation.
      source: {
        oneOf: [
          { type: 'string', minLength: 1 },
          { type: 'integer', minimum: 0 },
        ],
      },
      overrides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'components'],
          properties: {
            target: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
            components: componentsSchema,
          },
        },
      },
    },
  };
  const entitySchema = {
    type: 'object',
    additionalProperties: false,
    required: ['components'],
    properties: {
      components: componentsSchema,
      instance: instanceSchema,
    },
  };
  const sceneSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'entities'],
    properties: {
      kind: { type: 'string', const: 'scene' },
      // Skin assets are explicit scene dependencies so async catalog loading
      // can finish the joint-wiring path before the Scene is instantiated.
      // Authored producers use GUID strings; Pack output may use refs[] indices.
      skinGuids: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string', minLength: 1 },
            { type: 'integer', minimum: 0 },
          ],
        },
      },
      entities: {
        type: 'object',
        propertyNames: { type: 'string', minLength: 1 },
        additionalProperties: entitySchema,
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
//     values: object
//   }
// Each ParamSchemaEntry.type must be in the whitelist (D-ParamTypeWhitelist).
// `additionalProperties: false` at top level so ajv rejects unknown fields.
// values is free-form (object) — the runtime layer does deeper validation.
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
    required: ['materialShader', 'paramSchema', 'values'],
    properties: {
      materialShader: { type: 'string', minLength: 1 },
      paramSchema: {
        type: 'array',
        items: paramSchemaEntry,
      },
      values: { type: 'object' },
    },
  };

  return localAjv.compile(materialSchema);
}
