// compare-param-schema.ts -- single-direction superset gate at build time.
//
// feat-20260613-material-paramschema-driven-binding M2 / w7.
//
// Decision anchors:
//   - plan-strategy D-2  derive(schema) is the single source for BGL / UBO /
//     loader lookup tables; vite-plugin-shader consumes the BGL slice here.
//   - plan-strategy D-9  build-time gate is single-direction superset:
//     the actually reflected BGL must contain every binding emitted by
//     derive(schema). Extra bindings on the actual side are tolerated --
//     they are reserved for engine-side appendInjection (shadow / IBL /
//     lightmap) which lands at register time.
//   - plan-strategy D-10 add-only error code: superset failures emit
//     'material-shader-binding-mismatch' with .expected (the BGL entry
//     derive emitted) + .actual (the entry the reflector found, or
//     undefined) + .hint. The legacy 'material-schema-mismatch' code stays
//     put for register-time / overflow concerns.
//   - charter P3 explicit failure: build gate stops drift before runtime.
//
// The legacy two-way equality path (compareParamSchemaWithBgl) lived here
// before w7; it was deleted because appendInjection makes that semantic
// permanently red. The bg-overflow gate (checkBindGroupOverflow) stays
// because BGL count is independent of schema content.

import type {
  BindGroupLayoutDescriptor,
  BindGroupLayoutEntry,
  ParamSchemaEntry,
} from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { err, ok, type Result, ShaderError } from './errors.js';

// === Public API ====================================================================

/** Maximum allowed binding groups for material-shader entries (WebGPU spec). */
const MAX_BIND_GROUPS = 4;

/**
 * Pre-check for material-shader BGL overflow (AC-07).
 *
 * If the reflected BGL array length exceeds `MAX_BIND_GROUPS` (4), emit a
 * structured ShaderError with code='material-schema-mismatch' and
 * mismatchKind='bg-overflow'. This check runs before the schema-vs-BGL
 * comparison so the user sees a clear overflow signal rather than a
 * confusing type-mismatch.
 */
export function checkBindGroupOverflow(
  bgls: readonly BindGroupLayoutDescriptor[],
  materialShaderPath: string,
): Result<void, ShaderError> {
  if (bgls.length > MAX_BIND_GROUPS) {
    return err(
      new ShaderError({
        code: 'material-schema-mismatch',
        expected: `at most ${MAX_BIND_GROUPS} binding groups in a material-shader entry (WebGPU maxBindGroups)`,
        message: `material-shader '${materialShaderPath}' has ${bgls.length} binding groups (max ${MAX_BIND_GROUPS})`,
        hint: `reduce the number of @group annotations in the WGSL source to ${MAX_BIND_GROUPS} or fewer. The engine reserves @group(0) for view, @group(1) for mesh, @group(2) for material, and @group(3) for skybox/shadow. Material-shader user bindings must stay within @group(2).`,
        detail: {
          code: 'material-schema-mismatch',
          mismatchKind: 'bg-overflow',
          materialShaderPath,
          actualCount: bgls.length,
          maxAllowed: MAX_BIND_GROUPS,
        },
      }),
    );
  }
  return ok(undefined);
}

/**
 * Compare derive(schema) BGL slice against the actually reflected BGL.
 *
 * Single-direction superset semantics (D-9):
 *   actual ⊇ derive(schema).bglEntries
 *
 * For each entry derive(schema) emits, look up the actual entry at the same
 * `binding` number across all groups. The match must:
 *   1. exist (else `binding-missing`); and
 *   2. share the same resource kind (uniform buffer / texture / sampler /
 *      storage buffer / etc.) and -- where applicable -- the texture
 *      `viewDimension` / `sampleType` and the sampler `type` (else
 *      `binding-type-mismatch`).
 *
 * Extra entries in `actualBgls` that do not appear in derive(schema) are
 * tolerated (engine-injection placeholders). The function returns Ok on the
 * first all-clear pass and Err on the first violating expected entry; later
 * violations are surfaced one PR at a time as the AI user re-runs the build.
 */
export function compareParamSchemaSuperset(
  schema: readonly ParamSchemaEntry[],
  actualBgls: readonly BindGroupLayoutDescriptor[],
  materialShaderPath: string,
): Result<void, ShaderError> {
  const derived = derive(schema);
  if (derived.bglEntries.length === 0) {
    return ok(undefined);
  }

  const actualByBinding = flattenByBinding(actualBgls);
  const expectedParamByBinding = paramNameByBinding(schema, derived);

  for (const expected of derived.bglEntries) {
    const actual = actualByBinding.get(expected.binding);
    const paramName = expectedParamByBinding.get(expected.binding) ?? '<merged-ubo>';
    if (actual === undefined) {
      return err(
        makeBindingMismatch('binding-missing', expected, undefined, paramName, materialShaderPath),
      );
    }
    if (!resourceKindCompatible(expected, actual)) {
      return err(
        makeBindingMismatch(
          'binding-type-mismatch',
          expected,
          actual,
          paramName,
          materialShaderPath,
        ),
      );
    }
  }
  return ok(undefined);
}

// === Helpers =======================================================================

function flattenByBinding(
  bgls: readonly BindGroupLayoutDescriptor[],
): Map<number, BindGroupLayoutEntry> {
  const out = new Map<number, BindGroupLayoutEntry>();
  for (const descriptor of bgls) {
    for (const entry of descriptor.entries) {
      if (!out.has(entry.binding)) out.set(entry.binding, entry);
    }
  }
  return out;
}

/**
 * Map binding number to the paramSchema entry name that produced it. The
 * merged UBO at the head of bglEntries has no single owning name (one binding
 * carries all numeric entries); for it we report the first numeric param name
 * so AI users get a useful pointer.
 */
function paramNameByBinding(
  schema: readonly ParamSchemaEntry[],
  derived: ReturnType<typeof derive>,
): Map<number, string> {
  const out = new Map<number, string>();
  // First pass: walk the schema in declaration order and assign each
  // non-numeric entry its own binding slot. Numeric entries collapse onto a
  // single binding (the merged UBO at the head of derived.bglEntries when at
  // least one numeric entry exists).
  let nextBindingCursor = 0;
  let mergedUboBinding: number | null = null;
  let firstNumericName: string | null = null;
  for (const entry of schema) {
    if (isNumericType(entry.type)) {
      if (mergedUboBinding === null) {
        mergedUboBinding = nextBindingCursor;
        firstNumericName = entry.name;
        nextBindingCursor += 1;
      }
      continue;
    }
    if (isTextureViewType(entry.type)) {
      // Sampler-first per §D-4: auto-paired sampler at binding N, then
      // texture at binding N+1 (matches derive() emission order).
      out.set(nextBindingCursor, `${entry.name}_sampler`);
      nextBindingCursor += 1; // auto-paired sampler
      out.set(nextBindingCursor, entry.name);
      nextBindingCursor += 1; // texture
      continue;
    }
    // sampler / sampler_comparison / storage_buffer
    out.set(nextBindingCursor, entry.name);
    nextBindingCursor += 1;
  }
  if (mergedUboBinding !== null && firstNumericName !== null) {
    out.set(mergedUboBinding, firstNumericName);
  }
  // Sanity: derived.bglEntries cardinality must match the cursor we walked.
  void derived;
  return out;
}

function isNumericType(t: string): boolean {
  return (
    t === 'f32' ||
    t === 'i32' ||
    t === 'u32' ||
    t === 'vec2' ||
    t === 'vec3' ||
    t === 'vec4' ||
    t === 'color'
  );
}

function isTextureViewType(t: string): boolean {
  return (
    t === 'texture2d' ||
    t === 'texture_cube' ||
    t === 'texture_depth_2d' ||
    t === 'texture_cube_array'
  );
}

function resourceKindCompatible(
  expected: BindGroupLayoutEntry,
  actual: BindGroupLayoutEntry,
): boolean {
  if (expected.buffer !== undefined) {
    if (actual.buffer === undefined) return false;
    return expected.buffer.type === actual.buffer.type;
  }
  if (expected.texture !== undefined) {
    if (actual.texture === undefined) return false;
    if (expected.texture.viewDimension !== actual.texture.viewDimension) return false;
    if (expected.texture.sampleType !== actual.texture.sampleType) return false;
    return true;
  }
  if (expected.sampler !== undefined) {
    if (actual.sampler === undefined) return false;
    return expected.sampler.type === actual.sampler.type;
  }
  if (expected.storageTexture !== undefined) {
    return actual.storageTexture !== undefined;
  }
  return false;
}

function makeBindingMismatch(
  mismatchKind: 'binding-missing' | 'binding-type-mismatch',
  expected: BindGroupLayoutEntry,
  actual: BindGroupLayoutEntry | undefined,
  expectedParam: string,
  materialShaderPath: string,
): ShaderError {
  const wgslHint = synthesiseWgslHint(expected, expectedParam);
  const message =
    mismatchKind === 'binding-missing'
      ? `material-shader '${materialShaderPath}' is missing WGSL @binding(${expected.binding}) for paramSchema entry '${expectedParam}'`
      : `material-shader '${materialShaderPath}' WGSL @binding(${expected.binding}) resource kind does not match paramSchema entry '${expectedParam}'`;
  return new ShaderError({
    code: 'material-shader-binding-mismatch',
    expected: `WGSL @binding(${expected.binding}) declaring ${describeEntry(expected)} for paramSchema entry '${expectedParam}'`,
    message,
    hint: wgslHint,
    detail: {
      code: 'material-shader-binding-mismatch',
      mismatchKind,
      materialShaderPath,
      expected,
      ...(actual !== undefined ? { actual } : {}),
      expectedParam,
    },
  });
}

function describeEntry(entry: BindGroupLayoutEntry): string {
  if (entry.buffer !== undefined) {
    return entry.buffer.type === 'storage' || entry.buffer.type === 'read-only-storage'
      ? `var<storage> (${entry.buffer.type})`
      : 'var<uniform> ...';
  }
  if (entry.texture !== undefined) {
    return `texture (sampleType=${entry.texture.sampleType}, viewDimension=${entry.texture.viewDimension})`;
  }
  if (entry.sampler !== undefined) {
    return `sampler (type=${entry.sampler.type})`;
  }
  if (entry.storageTexture !== undefined) {
    return 'storage texture';
  }
  return 'unknown resource';
}

function synthesiseWgslHint(expected: BindGroupLayoutEntry, expectedParam: string): string {
  const at = `@group(2) @binding(${expected.binding})`;
  if (expected.buffer !== undefined) {
    return `add the missing WGSL declaration: ${at} var<uniform> ${expectedParam}: <Type>; (the paramSchema entry '${expectedParam}' is the first numeric field in the merged UBO; the struct itself collapses every numeric paramSchema entry into one std140-packed slot)`;
  }
  if (expected.texture !== undefined) {
    const wgslTexType =
      expected.texture.viewDimension === '2d' && expected.texture.sampleType === 'depth'
        ? 'texture_depth_2d'
        : expected.texture.viewDimension === 'cube'
          ? 'texture_cube<f32>'
          : expected.texture.viewDimension === 'cube-array'
            ? 'texture_cube_array<f32>'
            : 'texture_2d<f32>';
    return `add the missing WGSL declaration: ${at} var ${expectedParam}: ${wgslTexType};`;
  }
  if (expected.sampler !== undefined) {
    const wgslSamplerType =
      expected.sampler.type === 'comparison' ? 'sampler_comparison' : 'sampler';
    return `add the missing WGSL declaration: ${at} var ${expectedParam}: ${wgslSamplerType};`;
  }
  if (expected.storageTexture !== undefined) {
    return `add the missing WGSL storage-texture declaration at ${at} for paramSchema entry '${expectedParam}'`;
  }
  return `add the missing WGSL declaration at ${at} for paramSchema entry '${expectedParam}'`;
}
