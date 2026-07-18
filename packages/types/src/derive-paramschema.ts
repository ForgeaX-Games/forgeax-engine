// derive(schema) — paramSchema -> { bglEntries, uboLayout, textureFieldNames,
//                                    samplerForTexture, userRegionBindingEnd }
// feat-20260613-material-paramschema-driven-binding M1 / w3
//
// Decision anchors (plan-strategy §2):
//   - D-2  single pure function, no side effect; one signature consumed by 3
//          downstream paths (BGL build / UBO record / loader-extract).
//   - D-3  consecutive numeric entries are run-merged into one UBO entry at
//          one binding slot (uniform buffer); std140-aligned offsets.
//   - D-4  every texture* family entry auto-pairs a filtering sampler at
//          binding-1 (sampler emitted FIRST, then texture); sampler /
//          sampler_comparison stay user-declared.
//   - D-7  type set is the 14-literal MaterialParamType union.
//   - D-12 empty schema is graceful: bglEntries=[] / totalBytes=0 / fields empty.
//
// std140 alignment table (WGSL uniform):
//   - f32 / i32 / u32     size 4   align 4
//   - vec2<f32>           size 8   align 8
//   - vec3<f32>           size 12  align 16
//   - vec4 / color (rgba) size 16  align 16
//   - struct round-up: totalBytes is rounded up to 16-byte alignment.

import type {
  BindGroupLayoutEntry,
  MaterialParamType,
  NumericParamType,
  ParamSchemaEntry,
  TextureBindingParamType,
} from './index.js';

const FRAGMENT = 0x2 as GPUShaderStageFlags;

const NUMERIC_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'color',
]);

const TEXTURE_VIEW_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'texture2d',
  'texture_cube',
  'texture_depth_2d',
  'texture_cube_array',
]);

const SAMPLER_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'sampler',
  'sampler_comparison',
]);

const ALL_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  ...NUMERIC_TYPES,
  ...TEXTURE_VIEW_TYPES,
  ...SAMPLER_TYPES,
  'storage_buffer',
]);

interface NumericFootprint {
  readonly size: number;
  readonly align: number;
}

function numericFootprint(t: NumericParamType): NumericFootprint {
  switch (t) {
    case 'f32':
    case 'i32':
    case 'u32':
      return { size: 4, align: 4 };
    case 'vec2':
      return { size: 8, align: 8 };
    case 'vec3':
      return { size: 12, align: 16 };
    case 'vec4':
    case 'color':
      return { size: 16, align: 16 };
  }
}

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

interface TextureBglDescriptor {
  readonly sampleType: GPUTextureSampleType;
  readonly viewDimension: GPUTextureViewDimension;
}

function textureBglDescriptor(t: TextureBindingParamType): TextureBglDescriptor {
  switch (t) {
    case 'texture2d':
      return { sampleType: 'float', viewDimension: '2d' };
    case 'texture_cube':
      return { sampleType: 'float', viewDimension: 'cube' };
    case 'texture_depth_2d':
      return { sampleType: 'depth', viewDimension: '2d' };
    case 'texture_cube_array':
      return { sampleType: 'float', viewDimension: 'cube-array' };
    case 'sampler':
    case 'sampler_comparison':
      // Not a texture view — caller must dispatch separately. Falling through
      // here is a defensive guard; numericFootprint / sampler handler covers
      // these branches before this function is reached.
      throw new Error(`derive: textureBglDescriptor called on sampler-family type '${t}'`);
  }
}

function samplerBindingType(t: 'sampler' | 'sampler_comparison'): GPUSamplerBindingType {
  return t === 'sampler' ? 'filtering' : 'comparison';
}

/** Single UBO sub-entry — one merged std140 slot. */
export interface UboFieldLayout {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly type: NumericParamType;
}

export interface UboLayout {
  readonly entries: readonly UboFieldLayout[];
  readonly totalBytes: number;
}

export interface DeriveOutput {
  readonly bglEntries: readonly BindGroupLayoutEntry[];
  readonly uboLayout: UboLayout;
  readonly textureFieldNames: ReadonlySet<string>;
  readonly samplerForTexture: ReadonlyMap<string, string>;
  readonly userRegionBindingEnd: number;
}

/**
 * Pure derivation: paramSchema -> BGL entries + UBO byte layout + field maps.
 *
 * The function has no side effects and is the SSOT for BGL / UBO / loader
 * lookup tables (D-2). Runtime / vite-plugin-shader / loader all call into
 * this single entry point; in particular, `userRegionBindingEnd` is the
 * post-user-region binding index that engine-injected groups (shadow / IBL
 * / lightmap, see D-6) must start from.
 *
 * Throws on schema authoring errors:
 *   - duplicate entry name (numeric or non-numeric)
 *   - unrecognised type literal (not in the 14-member union)
 *   - empty entry name
 *   - user-declared name collides with the auto-paired `<tex>_sampler`
 */
export function derive(schema: readonly ParamSchemaEntry[]): DeriveOutput {
  const bglEntries: BindGroupLayoutEntry[] = [];
  const uboFields: UboFieldLayout[] = [];
  const textureFieldNames = new Set<string>();
  const samplerForTexture = new Map<string, string>();
  const seenNames = new Set<string>();
  const reservedSamplerNames = new Set<string>();

  let nextBinding = 0;
  let uboCursor = 0;
  // The first numeric run reserves binding(0) for the merged UBO. We need to
  // decide on first numeric encounter whether to claim a fresh binding slot
  // (a new run) or extend the in-progress run.
  let activeRunBinding: number | null = null;

  const finalizeRun = (): void => {
    activeRunBinding = null;
  };

  for (const rawEntry of schema) {
    const entry = rawEntry as ParamSchemaEntry;
    if (entry.name.length === 0) {
      throw new Error('derive: schema entry name must be non-empty');
    }
    if (!ALL_TYPES.has(entry.type)) {
      throw new Error(`derive: unrecognised paramSchema type literal '${entry.type}'`);
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`derive: duplicate paramSchema entry name '${entry.name}'`);
    }
    if (reservedSamplerNames.has(entry.name)) {
      throw new Error(
        `derive: paramSchema entry '${entry.name}' collides with auto-paired sampler name`,
      );
    }
    seenNames.add(entry.name);

    if (NUMERIC_TYPES.has(entry.type)) {
      const numericType = entry.type as NumericParamType;
      const { size, align } = numericFootprint(numericType);
      if (activeRunBinding === null) {
        activeRunBinding = nextBinding;
        nextBinding += 1;
        uboCursor = 0;
        bglEntries.push({
          binding: activeRunBinding,
          visibility: FRAGMENT,
          buffer: { type: 'uniform' },
        });
      }
      const offset = alignUp(uboCursor, align);
      uboFields.push({ name: entry.name, offset, size, type: numericType });
      uboCursor = offset + size;
      continue;
    }

    finalizeRun();

    if (TEXTURE_VIEW_TYPES.has(entry.type)) {
      const texType = entry.type as TextureBindingParamType;
      const { sampleType, viewDimension } = textureBglDescriptor(texType);
      // Sampler-first per plan §D-4: emit auto-paired filtering sampler at
      // binding N, then the texture view at binding N+1. Matches the actual
      // WGSL @binding declaration order in the 5 built-in shaders (sampler
      // declared on the odd binding, texture on the even+1 binding).
      const samplerName = `${entry.name}_sampler`;
      if (seenNames.has(samplerName)) {
        throw new Error(
          `derive: auto-paired sampler name '${samplerName}' collides with existing entry`,
        );
      }
      reservedSamplerNames.add(samplerName);
      samplerForTexture.set(entry.name, samplerName);
      const samplerBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: samplerBinding,
        visibility: FRAGMENT,
        sampler: { type: 'filtering' },
      });

      const texBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: texBinding,
        visibility: FRAGMENT,
        texture: { sampleType, viewDimension, multisampled: false },
      });
      textureFieldNames.add(entry.name);
      continue;
    }

    if (SAMPLER_TYPES.has(entry.type)) {
      const samplerType = entry.type as 'sampler' | 'sampler_comparison';
      const samplerBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: samplerBinding,
        visibility: FRAGMENT,
        sampler: { type: samplerBindingType(samplerType) },
      });
      continue;
    }

    // entry.type === 'storage_buffer'
    const storageBinding = nextBinding;
    nextBinding += 1;
    bglEntries.push({
      binding: storageBinding,
      visibility: FRAGMENT,
      buffer: { type: 'read-only-storage' },
    });
  }

  const totalBytes = uboFields.length === 0 ? 0 : alignUp(largestNumericTail(uboFields), 16);

  return {
    bglEntries,
    uboLayout: { entries: uboFields, totalBytes },
    textureFieldNames,
    samplerForTexture,
    userRegionBindingEnd: nextBinding,
  };
}

/**
 * The three user-region material texture fields whose handles flow through the
 * paramSchema-driven extract filter (`validateTextureHandle`). They map to the
 * fixed `@group(1) @binding(2/4/6)` slots in the standard material BGL.
 *
 * `emissiveTexture` / `occlusionTexture` are deliberately EXCLUDED: they live
 * in the engine-managed lightmap injection region (`appendInjection`,
 * bindings 14..17), are sampled by `default-standard-pbr` without a schema
 * entry, and are never filtered by `validateTextureHandle`. Including them
 * would false-positive the engine's own PBR shader.
 */
const USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
];

/** Strip `//` line comments and block comments before scanning WGSL source. */
function stripWgslComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Detect user-region material textures a shader actually `textureSample`s but
 * its paramSchema fails to declare as a texture entry.
 *
 * This is the runtime (register-time) counterpart of the build-time superset
 * gate (`compareParamSchemaSuperset`): user shaders registered directly via
 * `ShaderRegistry.registerMaterialShader` bypass the vite-plugin-shader
 * reflection path, so an under-declared schema would otherwise let the extract
 * stage's `validateTextureHandle` silently drop the sampled texture's handle
 * and fall back to the default white texture (charter P3 violation — the bug
 * that turned the LearnOpenGL 4.3 blending demo's grass + windows opaque white;
 * see docs/handover/2026-06-19-blending-transparency-regression-bisect.md).
 *
 * Returns the field names that are sampled-but-undeclared (empty = consistent).
 * Scan is name-based on the WGSL var passed as the first `textureSample*`
 * argument; comments are stripped first so a commented-out sample never trips
 * the check. Only the three `USER_REGION_TEXTURE_FIELDS` participate, so a
 * shader that merely *declares* the standard binding layout without sampling it
 * (e.g. an outline / depth-viz shader reusing the PBR BGL) is not flagged.
 */
export function findUndeclaredSampledTextures(
  wgslSource: string,
  schema: readonly ParamSchemaEntry[],
): readonly string[] {
  const declared = derive(schema).textureFieldNames;
  const clean = stripWgslComments(wgslSource);
  const sampleRe = /textureSample[A-Za-z]*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  const sampled = new Set<string>();
  for (let m = sampleRe.exec(clean); m !== null; m = sampleRe.exec(clean)) {
    const name = m[1];
    if (name !== undefined) sampled.add(name);
  }
  return USER_REGION_TEXTURE_FIELDS.filter((f) => sampled.has(f) && !declared.has(f));
}

function largestNumericTail(fields: readonly UboFieldLayout[]): number {
  let tail = 0;
  for (const f of fields) {
    const end = f.offset + f.size;
    if (end > tail) tail = end;
  }
  return tail;
}
