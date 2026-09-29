import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type ParticleBoundsSource,
  type ParticleChannelSource,
  type ParticleCodeSourceError,
  type ParticleEmitterSourceStructure,
  type ParticleEventSource,
  type ParticleRendererOverflowPolicy,
  parseParticleEffectSourceStructure,
} from './code-source.js';
import type { VfxParticleCoreAttribute } from './particle-layout.js';

/** Renderer sorting modes in Program v3. Segment topology order is unaffected. */
export type ParticleRendererSortingV3 =
  | 'none'
  | 'view-depth'
  | 'view-distance'
  | 'custom-ascending'
  | 'custom-descending';

export type ParticleAttributeRef =
  | { readonly source: 'core'; readonly name: VfxParticleCoreAttribute }
  | { readonly source: 'custom'; readonly name: string };

/**
 * Renderer fields with a concrete Program v3 projection. Keep this union
 * execution-backed; renderer.materialInputs is the separate material bridge.
 */
export type ParticleRendererSemantic =
  | 'position'
  | 'color'
  | 'size'
  | 'rotation'
  | 'subImage'
  | 'age'
  | 'sort'
  | 'orientation'
  | 'scale'
  | 'visibility'
  | 'width'
  | 'taper'
  | 'endpoint';

export type ParticleRendererSemanticMap = Readonly<
  Partial<Record<ParticleRendererSemantic, ParticleAttributeRef>>
>;

export interface ParticleRendererSourceV3Base {
  readonly material: string;
  readonly enabled?: boolean;
  readonly capacity?: number;
  readonly overflow?: ParticleRendererOverflowPolicy;
  readonly width?: number;
  readonly attributes?: ParticleRendererSemanticMap;
  /** Names must match the cooked MaterialShaderArtifact particleInputs declaration. */
  readonly materialInputs?: readonly string[];
}

export type ParticleRendererSourceV3 =
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'billboard';
      readonly blend?: 'additive' | 'alpha' | 'opaque-cutout';
      readonly textureSheet?: {
        readonly columns: number;
        readonly rows: number;
        readonly frameRate: number;
        readonly frameCount?: number;
      };
      readonly pivot?: readonly [number, number];
      readonly softParticle?: { readonly fadeDistance: number };
      readonly sorting?: ParticleRendererSortingV3;
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'mesh';
      readonly sorting?: ParticleRendererSortingV3;
      readonly mesh: string;
      readonly submesh?: number;
      readonly lighting?: 'unlit' | 'standard';
      readonly castShadows?: boolean;
      readonly receiveShadows?: boolean;
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'ribbon';
      readonly stripKey: 'alive-index';
      readonly capacity: number;
      readonly twist?: number;
      readonly facing?: 'camera' | 'velocity' | 'custom';
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'trail';
      readonly historyLength: number;
      readonly capacity: number;
      readonly taper?: number;
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'beam';
      readonly endpointField: 'velocity';
      readonly capacity: number;
      readonly taper?: number;
    });

export interface ParticleEmitterSourceV3 {
  readonly id: string;
  readonly capacity: number;
  readonly backend: { readonly required: 'gpu' };
  readonly space: 'local' | 'world';
  readonly bounds: ParticleBoundsSource;
  readonly schedule: ParticleEmitterSourceStructure['schedule'];
  readonly program: { readonly module: string };
  readonly renderers: readonly ParticleRendererSourceV3[];
  /** Existing channels/events are intentionally carried unchanged into v3. */
  readonly channels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
  readonly simulationWhenCulled?: ParticleEmitterSourceStructure['simulationWhenCulled'];
}

export interface ParticleEffectRootSourceV3 {
  readonly schemaVersion: 3;
  readonly emitters: readonly ParticleEmitterSourceV3[];
}

export type ParticleEffectSourceV3 = ParticleEffectRootSourceV3;

/**
 * Renderer semantic vocabulary shared by source validation and compiler
 * reflection. Keeping the allowed keys here prevents a parser/compiler drift
 * where a typo is accepted by one boundary and ignored by the other.
 */
export const PARTICLE_RENDERER_SEMANTICS: Readonly<
  Record<ParticleRendererSourceV3['kind'], readonly ParticleRendererSemantic[]>
> = Object.freeze({
  billboard: Object.freeze([
    'position',
    'color',
    'size',
    'rotation',
    'age',
    'subImage',
    'sort',
    'visibility',
  ] as const),
  mesh: Object.freeze(['position', 'color', 'orientation', 'scale', 'sort', 'visibility'] as const),
  ribbon: Object.freeze(['position', 'color', 'width'] as const),
  trail: Object.freeze(['position', 'color', 'width', 'taper'] as const),
  beam: Object.freeze(['position', 'endpoint', 'color', 'width'] as const),
});

function coreAttribute(name: VfxParticleCoreAttribute): ParticleAttributeRef {
  return { source: 'core', name };
}

/** Default mapping for fields with implicit runtime behavior; overrides merge in the compiler. */
export function defaultParticleRendererAttributes(
  kind: ParticleRendererSourceV3['kind'],
): ParticleRendererSemanticMap {
  switch (kind) {
    case 'billboard':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
        size: coreAttribute('sprite_size'),
        rotation: coreAttribute('sprite_rotation'),
        age: coreAttribute('age'),
        visibility: coreAttribute('alive'),
      };
    case 'mesh':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
        orientation: coreAttribute('mesh_orientation'),
        scale: coreAttribute('mesh_scale'),
        visibility: coreAttribute('alive'),
      };
    case 'ribbon':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
      };
    case 'trail':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
      };
    case 'beam':
      return {
        position: coreAttribute('position'),
        endpoint: coreAttribute('velocity'),
        color: coreAttribute('color'),
      };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string): Result<never, ParticleCodeSourceError> {
  return err({
    code: 'vfx-source-invalid',
    expected,
    hint: `repair ${path} and recook the Program v3 particle effect`,
    detail: { path },
  });
}

function extra(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const keys = new Set(allowed);
  return Object.keys(value).find((key) => !keys.has(key));
}

const CORE_NAMES = new Set<VfxParticleCoreAttribute>([
  'position',
  'age',
  'velocity',
  'lifetime',
  'color',
  'sprite_size',
  'sprite_rotation',
  'sub_image',
  'mesh_orientation',
  'mesh_scale',
  'material_random',
  'id',
  'alive',
]);

function validateAttributes(
  value: unknown,
  path: string,
): Result<ParticleRendererSemanticMap | undefined, ParticleCodeSourceError> {
  if (value === undefined) return ok(undefined);
  if (!record(value)) return fail(path, 'a semantic-to-attribute object');
  for (const [semantic, reference] of Object.entries(value)) {
    if (!record(reference) || (reference.source !== 'core' && reference.source !== 'custom')) {
      return fail(`${path}.${semantic}`, "{ source: 'core' | 'custom', name: string }");
    }
    if (typeof reference.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.name)) {
      return fail(`${path}.${semantic}.name`, 'a non-empty identifier');
    }
    if (
      reference.source === 'core' &&
      !CORE_NAMES.has(reference.name as VfxParticleCoreAttribute)
    ) {
      return fail(`${path}.${semantic}.name`, 'a VfxParticle core attribute');
    }
    const referenceExtra = extra(reference, ['source', 'name']);
    if (referenceExtra !== undefined)
      return fail(`${path}.${semantic}.${referenceExtra}`, 'source and name only');
  }
  return ok(value as ParticleRendererSemanticMap);
}

function validateMaterialInputs(
  value: unknown,
  path: string,
): Result<readonly string[] | undefined, ParticleCodeSourceError> {
  if (value === undefined) return ok(undefined);
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))
  ) {
    return fail(path, 'at most four unique particle input names');
  }
  if (new Set(value).size !== value.length) return fail(path, 'unique particle input names');
  return ok(Object.freeze([...value]));
}

function rendererAllowed(kind: string): readonly string[] {
  const common = [
    'kind',
    'material',
    'enabled',
    'capacity',
    'overflow',
    'width',
    'attributes',
    'materialInputs',
  ];
  switch (kind) {
    case 'billboard':
      return [...common, 'blend', 'textureSheet', 'pivot', 'softParticle', 'sorting'];
    case 'mesh':
      return [
        'kind',
        'material',
        'mesh',
        'submesh',
        'sorting',
        'enabled',
        'attributes',
        'materialInputs',
        'lighting',
        'castShadows',
        'receiveShadows',
      ];
    case 'ribbon':
      return [...common, 'stripKey', 'twist', 'facing'];
    case 'trail':
      return [...common, 'historyLength', 'taper'];
    case 'beam':
      return [...common, 'endpointField', 'taper'];
    default:
      return ['kind'];
  }
}

function asStructureRenderer(value: Record<string, unknown>): Record<string, unknown> {
  const common = ['kind', 'material', 'enabled', 'capacity', 'overflow', 'width'] as const;
  const result: Record<string, unknown> = {};
  for (const key of common) if (value[key] !== undefined) result[key] = value[key];
  switch (value.kind) {
    case 'billboard':
      for (const key of ['blend', 'textureSheet', 'pivot', 'softParticle'] as const)
        if (value[key] !== undefined) result[key] = value[key];
      if (value.sorting === 'view-depth' || value.sorting === 'view-distance')
        result.sorting = 'back-to-front';
      else if (value.sorting === 'custom-ascending' || value.sorting === 'custom-descending')
        result.sorting = 'emitter';
      else if (value.sorting !== undefined) result.sorting = value.sorting;
      break;
    case 'mesh':
      for (const key of ['mesh', 'submesh'] as const)
        if (value[key] !== undefined) result[key] = value[key];
      break;
    case 'ribbon':
      result.stripKey = value.stripKey;
      break;
    case 'trail':
      result.historyLength = value.historyLength;
      break;
    case 'beam':
      result.endpointField = value.endpointField;
      break;
  }
  return result;
}

function validateRenderer(
  value: unknown,
  emitterIndex: number,
  index: number,
): Result<ParticleRendererSourceV3, ParticleCodeSourceError> {
  const path = `emitters[${emitterIndex}].renderers[${index}]`;
  if (!record(value) || typeof value.kind !== 'string' || typeof value.material !== 'string') {
    return fail(path, 'a Program v3 renderer object');
  }
  const unknown = extra(value, rendererAllowed(value.kind));
  if (unknown !== undefined)
    return fail(`${path}.${unknown}`, 'a supported Program v3 renderer field');
  if (value.lighting !== undefined && value.lighting !== 'unlit' && value.lighting !== 'standard')
    return fail(`${path}.lighting`, 'unlit or standard');
  for (const field of ['castShadows', 'receiveShadows'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean')
      return fail(`${path}.${field}`, 'a boolean');
  }
  for (const field of ['twist', 'taper'] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== 'number' || !Number.isFinite(value[field]))
    )
      return fail(`${path}.${field}`, 'a finite number');
  }
  if (
    value.facing !== undefined &&
    value.facing !== 'camera' &&
    value.facing !== 'velocity' &&
    value.facing !== 'custom'
  )
    return fail(`${path}.facing`, 'camera, velocity, or custom');
  if (
    value.sorting !== undefined &&
    (value.kind === 'billboard' || value.kind === 'mesh') &&
    !['none', 'view-depth', 'view-distance', 'custom-ascending', 'custom-descending'].includes(
      value.sorting as string,
    )
  )
    return fail(`${path}.sorting`, 'a Program v3 sorting mode');
  const attrs = validateAttributes(value.attributes, `${path}.attributes`);
  if (!attrs.ok) return attrs;
  if (attrs.value !== undefined) {
    for (const semantic of Object.keys(attrs.value)) {
      if (
        !PARTICLE_RENDERER_SEMANTICS[value.kind as ParticleRendererSourceV3['kind']]?.includes(
          semantic as ParticleRendererSemantic,
        )
      ) {
        return fail(
          `${path}.attributes.${semantic}`,
          'a semantic supported by this renderer topology',
        );
      }
    }
  }
  const inputs = validateMaterialInputs(value.materialInputs, `${path}.materialInputs`);
  if (!inputs.ok) return inputs;
  return ok({
    ...(value as unknown as ParticleRendererSourceV3),
    ...(attrs.value === undefined ? {} : { attributes: attrs.value }),
    ...(inputs.value === undefined ? {} : { materialInputs: inputs.value }),
  });
}

/** Parse the single Program v3 source shape. Older source versions are rejected. */
export function parseParticleEffectSourceV3(
  value: unknown,
): Result<ParticleEffectSourceV3, ParticleCodeSourceError> {
  if (!record(value)) return fail('$', 'a Program v3 particle effect source object');
  if (value.schemaVersion !== 3) {
    return err({
      code: 'vfx-source-version-unsupported',
      expected: 'ParticleEffectSource schemaVersion 3',
      hint: 'cold-cook the source with the Program v3 compiler; older versions are not executable',
      detail: { path: 'schemaVersion' },
    });
  }
  const rootExtra = extra(value, ['schemaVersion', 'emitters']);
  if (rootExtra !== undefined) return fail(rootExtra, 'schemaVersion and emitters only');
  if (!Array.isArray(value.emitters) || value.emitters.length === 0)
    return fail('emitters', 'at least one Program v3 emitter');
  const renderers = new Map<string, readonly ParticleRendererSourceV3[]>();
  for (const [emitterIndex, emitter] of value.emitters.entries()) {
    if (record(emitter) && Array.isArray(emitter.renderers)) {
      const parsed: ParticleRendererSourceV3[] = [];
      for (const [index, renderer] of emitter.renderers.entries()) {
        const result = validateRenderer(renderer, emitterIndex, index);
        if (!result.ok) return result;
        parsed.push(result.value);
      }
      renderers.set(typeof emitter.id === 'string' ? emitter.id : String(renderers.size), parsed);
    }
  }
  // Reuse the established bounds/schedule/channel/event validator after removing
  // renderer-only v3 fields. Renderer semantics have already been checked above.
  const structuralInput = {
    schemaVersion: 3,
    emitters: value.emitters.map((emitter) => {
      if (!record(emitter)) return emitter;
      return {
        ...emitter,
        renderers: Array.isArray(emitter.renderers)
          ? emitter.renderers.map((renderer) =>
              record(renderer) ? asStructureRenderer(renderer) : renderer,
            )
          : emitter.renderers,
      };
    }),
  };
  const parsed = parseParticleEffectSourceStructure(structuralInput);
  if (!parsed.ok) return parsed;
  const emitters: ParticleEmitterSourceV3[] = parsed.value.emitters.map((emitter) => ({
    ...emitter,
    renderers: renderers.get(emitter.id) ?? [],
  }));
  return ok(Object.freeze({ schemaVersion: 3, emitters: Object.freeze(emitters) }));
}

export function defineParticleEffectSourceV3<T extends ParticleEffectSourceV3>(source: T): T {
  const parsed = parseParticleEffectSourceV3(source);
  if (!parsed.ok) throw new TypeError(`${parsed.error.code}: ${parsed.error.expected}`);
  return source;
}
