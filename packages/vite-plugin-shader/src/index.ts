// @forgeax/engine-vite-plugin-shader — Vite plugin 4 hooks + ShaderError → RollupLog wrap (w14).
//
// Top-level surface (charter proposition 1 progressive disclosure /
// proposition 5 consistent abstraction):
// - forgeaxShader(options?) — Vite Plugin factory returning a Plugin object with 4 hooks
// - toRollupLog(err) — ShaderError → RollupLog wrap (hint top-level + meta double surface, §S-7)
//
// Form invariants (plan-strategy §S-6 + §S-7):
// - Thin-shell forwarding: all 4 hooks are mounted, but transform only forwards
//   to @forgeax/engine-shader-compiler.compileShader; it does not reimplement compile
//   logic (AC-02 gate).
// - emitFile is mandatory: generateBundle goes through
//   this.emitFile({ type: 'asset', fileName, source }); directly mutating
//   bundle[fileName] is forbidden (Rollup official danger callout,
//   research Finding 3).
// - Hint double surface: transform calls this.error(toRollupLog(err)); the wrap
//   places hint at the top level and at meta.hint simultaneously (charter
//   proposition 5 consistent abstraction — AI consumers read err.hint at the
//   top level rather than parsing message prose or going through err.meta.hint).
// - HMR default propagation: handleHotUpdate(ctx) returns ctx.modules; transform
//   injects the `import.meta.hot.accept(` literal (whitespace-sensitive,
//   research Finding 3).

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  checkBindGroupOverflow,
  compareParamSchemaSuperset,
  compileShader,
  ShaderError,
} from '@forgeax/engine-shader-compiler';
import type { BindGroupLayoutDescriptor, ParamSchemaEntry } from '@forgeax/engine-types';
import { loadEngineImportsMap } from './engine-imports-map.js';
import { toRollupLog } from './wrap.js';

export type { ForgeaXShaderRollupLog } from './wrap.js';
export { toRollupLog } from './wrap.js';

/**
 * Build a `shaders/manifest.json`-shaped payload by compiling the engine's
 * shipped `@forgeax/engine-shader/src/{pbr,unlit}.wgsl` (with common.wgsl
 * + brdf.wgsl supplied as naga_oil `#import` peers). Useful for non-Vite
 * consumers that need the same manifest the plugin emits at build time —
 * e.g. dawn-node smoke scripts that boot the runtime without going through
 * `vite build` (charter P5: same SSOT, single composition path).
 *
 * The returned object is the `{schemaVersion, entries}` shape consumed by
 * `@forgeax/engine-shader.ShaderRegistry.loadManifest`. Wrap it in
 * `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`
 * to feed into `createRenderer({shaderManifestUrl})`.
 */
export async function buildEngineShaderManifest(): Promise<{
  schemaVersion: string;
  entries: Array<{ hash: string; wgsl: string; glsl: undefined; bindings: string }>;
  materialShaders: Array<{
    identifier: string;
    sourcePath: string;
    composedWgsl: string;
    paramSchema: string;
    variants: readonly [];
  }>;
}> {
  const eng = await loadEngineShaderEntries();
  const entries: Array<{ hash: string; wgsl: string; glsl: undefined; bindings: string }> = [];
  const materialShaders: Array<{
    identifier: string;
    sourcePath: string;
    composedWgsl: string;
    paramSchema: string;
    variants: readonly [];
  }> = [];
  for (const file of [
    eng.defaultStandardPbr,
    eng.defaultStandardPbrSkin,
    eng.unlit,
    eng.tonemap,
    eng.shadowCaster,
    eng.sprite,
    eng.msdfText,
    eng.iblEquirectToCube,
    eng.iblIrradiance,
    eng.iblPrefilter,
    eng.iblBrdfLut,
    eng.fxaa,
    eng.skybox,
  ]) {
    const r = await compileShader(stripPragmas(file.source), {
      id: file.id,
      imports: eng.imports,
      // POINT_SHADOW_AVAILABLE: turns on the @group(0) @binding(5) cube_array
      // shadow atlas + binding(6) shadowParams uniform declarations in
      // common.wgsl. The runtime PBR view BGL (buildPbrViewBglEntries) emits
      // matching entries unconditionally; lit pipelines always include the
      // bindings -- a 1x1x6 depth cube_array fallback (shadowAtlasFallbackView)
      // is bound when no PointLightShadow snapshots are active so the cube
      // sample returns 1.0 (fully lit) and AC-09 zero-shadow zero-allocation
      // is preserved (the atlas itself is still lazy-allocated by ShadowAtlas).
      defines: { STORAGE_BUFFER_AVAILABLE: true, POINT_SHADOW_AVAILABLE: true },
    });
    if (!r.ok) {
      throw Object.assign(new Error(r.error.message), toRollupLog(r.error));
    }
    const { manifestEntry } = r.value;
    const bindingsJson =
      typeof manifestEntry.bindings === 'string'
        ? manifestEntry.bindings
        : JSON.stringify(manifestEntry.bindings);
    entries.push({
      hash: manifestEntry.hash,
      wgsl: manifestEntry.wgsl,
      glsl: undefined,
      bindings: bindingsJson,
    });
    if (file.reservedIdentifier !== undefined) {
      const metaPath = `${file.id}.meta.json`;
      let paramSchemaJson = '[]';
      try {
        const metaRaw = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw) as Record<string, unknown>;
        if (meta.importer === 'shader' && Array.isArray(meta.paramSchema)) {
          paramSchemaJson = JSON.stringify(meta.paramSchema);
        }
      } catch {
        // sidecar missing or unparseable — fall back to empty paramSchema
      }
      materialShaders.push({
        identifier: file.reservedIdentifier,
        sourcePath: file.id,
        composedWgsl: manifestEntry.wgsl,
        paramSchema: paramSchemaJson,
        variants: [],
      });
    }
  }
  // feat-20260612-hdrp-ssao M6 / w27: hdrp-ssao manifest entry.
  // hdrp-ssao.wgsl uses @group(2) bindings with texture_depth_2d and
  // for-loops that naga_oil cannot compose directly. Instead of
  // compileShader, we resolve the sole #import (forgeax_view::common) by
  // inlining the fullscreen_triangle + FullscreenOutput from common.wgsl,
  // strip the #define_import_path + #import pragmas, and emit a manifest
  // entry with the 'fs_ssao_calc' content marker for createRenderer triage.
  {
    // hdrp-ssao only imports `fullscreen_triangle` + `FullscreenOutput` from
    // forgeax_view::common. We cannot inline common.wgsl wholesale because it
    // contains naga_oil preprocessor directives (#if STORAGE_BUFFER_AVAILABLE,
    // #ifdef POINT_SHADOW_AVAILABLE, …) that naga's WGSL parser rejects.
    // Hand-write the minimal prelude that hdrp-ssao actually needs.
    const commonPrelude = `struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

fn fullscreen_triangle(vertex_index : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (vertex_index == 1u) { x = 3.0; }
  if (vertex_index == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}
`;
    // Strip hdrp-ssao's pragma lines (define_import_path + multi-token #import).
    const ssaoSource = eng.hdrpSsao.source
      .replace(/^#define_import_path\s+.*$/gm, '')
      .replace(/^#import\s+.*$/gm, '')
      .replace(/^[ \t]*$/gm, '');
    const composed = `${commonPrelude}\n${ssaoSource}`;
    // Simple hash: stable based on content length + marker suffix
    const hash = `ssao-${composed.length}`;
    entries.push({
      hash,
      wgsl: composed,
      glsl: undefined,
      bindings: '[]',
    });
  }
  return { schemaVersion: '1.0.0', entries, materialShaders };
}

/**
 * Options for the `forgeaxShader` plugin factory (no configurable items in M2;
 * the future signature is reserved).
 */
export interface ForgeaXShaderOptions {
  /**
   * Reserved: in the future this will hold compileShader-forwarded options such as dynamic offset annotations.
   * @internal
   */
  readonly _reserved?: undefined;
  /**
   * When true (default) the plugin eagerly compiles the engine-shipped
   * `packages/shader/src/{pbr,unlit}.wgsl` (with `common.wgsl` + `brdf.wgsl`
   * supplied as `naga_oil` `#import` peers) at `buildStart` so the emitted
   * `shaders/manifest.json` always contains the `pbr` + `unlit` entries the
   * runtime `ShaderRegistry` expects (feat-20260518-pbr-direct-lighting-mvp
   * M5 / w22.8 — replaces the legacy inline `PBR_FALLBACK_WGSL` path in
   * `createRenderer.ts`). Set to `false` only in unit tests that mock the
   * eager-compile pipeline.
   */
  readonly engineEntries?: boolean;
  /**
   * Directories to scan for engine-shipped ShaderModule *.wgsl files.
   * Each *.wgsl with a `#define_import_path <path>` header line is added
   * to the engine imports map, enabling cross-directory `#import` resolution
   * for user MaterialShader entries (plan-strategy D-ImportsMap).
   *
   * Default: `[<packages/shader/src>]` resolved via `createRequire` at
   * `buildStart` time.
   *
   * @since feat-20260523-shader-template-instance-split M3-T03
   */
  readonly engineShaderRoots?: string[];
}

// === Internal state =================================================================

/** Manifest entries retained after a transform hit, used by generateBundle for aggregation. */
/**
 * Extract the transitive #import closure for `source` from the full imports map.
 * Returns only the modules actually reachable through `#import` directives
 * (direct + transitive), avoiding naga_oil compose issues with unrelated
 * modules that define conflicting globals when processed with defines.
 */
/**
 * Extract the transitive closure of import module IDs from a WGSL source.
 * Resolves `#import <prefix>::<spec>` directives by trying progressively
 * longer prefixes (full path, then one segment less, etc.) until a match
 * is found in `allImports`.
 */
function resolveImportModuleId(
  rawId: string,
  allImports: Readonly<Record<string, string>>,
): string | undefined {
  // Try the full id first, then progressively strip trailing `::segment` parts.
  let candidate = rawId;
  while (candidate.length > 0) {
    if (allImports[candidate] !== undefined) return candidate;
    const lastSep = candidate.lastIndexOf('::');
    if (lastSep === -1) break;
    candidate = candidate.slice(0, lastSep);
  }
  return undefined;
}

function extractTransitiveImports(
  source: string,
  allImports: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const rawId of scanImportModuleIds(source)) {
    const moduleId = resolveImportModuleId(rawId, allImports);
    if (moduleId !== undefined && !visited.has(moduleId)) {
      const src = allImports[moduleId];
      if (src !== undefined) {
        visited.add(moduleId);
        queue.push(moduleId);
        result[moduleId] = src;
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const modSource = allImports[current];
    if (modSource === undefined) continue;
    for (const rawId of scanImportModuleIds(modSource)) {
      const moduleId = resolveImportModuleId(rawId, allImports);
      if (moduleId !== undefined && !visited.has(moduleId)) {
        const src = allImports[moduleId];
        if (src !== undefined) {
          visited.add(moduleId);
          queue.push(moduleId);
          result[moduleId] = src;
        }
      }
    }
  }

  return result;
}

interface ManifestEntryValue {
  readonly hash: string;
  readonly wgsl: string;
  readonly bindings: string;
}

/**
 * Single variant within a material-shader manifest entry.
 * key = canonical defines string (sorted `key=value` pairs joined with `+`).
 * Empty key `""` denotes the default variant (all axes `true`), per plan-strategy D-2.
 *
 * feat-20260613 fix-issue-2: bindingLayout sidecar field gone -- the
 * runtime derives the BGL from `derive(paramSchema).bglEntries`. The
 * superset gate that used to consume bindingLayout now reads the freshly
 * compiled `manifestEntry.bindings` directly inline at the call site.
 */
interface MaterialShaderManifestVariant {
  readonly definesKey: string;
  readonly defines: Record<string, boolean>;
  readonly composedWgsl: string;
}

/** Single material-shader entry in the manifest (plan-strategy §3.10 + D-1 variants). */
interface MaterialShaderManifestEntry {
  readonly identifier: string;
  readonly sourcePath: string;
  readonly composedWgsl: string;
  readonly paramSchema: string;
  /**
   * Variant array produced by Cartesian-product compile of {@link MaterialShaderManifestVariant}.
   * Empty array when the source carries no `#pragma variant_axis` directives (single-variant entry).
   */
  readonly variants: readonly MaterialShaderManifestVariant[];
}

interface ManifestEntries {
  readonly entries: Map<string, ManifestEntryValue>;
  readonly materialShaders: MaterialShaderManifestEntry[];
  /**
   * Variant WGSL sources keyed by `${sourcePath}#${definesKey}`.
   * Variants are NOT emitted into `entries` (per Issue #1 fix: only the
   * default all-true variant lands there). This separate map serves
   * `generateBundle` sidecar emission for per-variant composed WGSL files.
   *
   * @since feat-20260526-pbr-uniform-fallback-no-storage-buffer M4-repair
   */
  readonly variantWgsl: Map<string, string>;
}

// === reverseDeps: cross-file HMR propagation (plan-strategy §2 D-10, T-16) =========
//
// `reverseDeps: Map<depFilePath, Set<importerFilePath>>` is the inverse of the
// compileShader `deps` array — transform hook scans every `#import <name>`
// directive in the source, resolves `<name>` to
// `${dirname(id)}/${name}.wgsl` (same-directory convention; research Finding
// 3 naga_oil `#define_import_path` pairing), and writes the edge
// `reverseDeps.get(depFilePath).add(importerFilePath)`. handleHotUpdate reads
// the map (never writes) to resolve downstream modules when a dep file
// changes. The Map + Set combo is safe under JS single-threaded
// transform serialisation (plan-strategy §3 RISK-3 — no manual locking).
const reverseDeps = new Map<string, Set<string>>();

/**
 * Resolve an `#import <name>` directive discovered inside `importerFile` to an
 * absolute filesystem path under the same-directory convention:
 *   `${dirname(importerFile)}/${tailSegment(name)}.wgsl`
 *
 * `name` is a naga_oil-style `::`-segmented moduleId (e.g.
 * `forgeax_view::common`). The **trailing** segment is taken as the file
 * basename, matching the production convention used by
 * `packages/shader/src/{common,brdf,pbr,unlit}.wgsl` and
 * `apps/hello/triangle/src/shaders/{view,brdf,pbr}.wgsl`: each companion
 * module declares `#define_import_path <prefix>::<tail>` and is saved as
 * `<tail>.wgsl` next to its importer.
 *
 * Pure-function (used both by `scanImportDirectives` to seed reverseDeps and
 * by the transform hook to read sibling sources for `compileShader.imports`).
 */
function resolveImportToFile(importerFile: string, name: string): string {
  const segments = name.split('::');
  const basename = segments[segments.length - 1] ?? name;
  const lastSlash = importerFile.lastIndexOf('/');
  const dir = lastSlash === -1 ? '.' : importerFile.slice(0, lastSlash);
  return `${dir}/${basename}.wgsl`;
}

/**
 * Scan `source` for `#define NAME` (without value) directives and return the
 * define names. `#define NAME VALUE` lines are not matched — those are caught
 * by compileShader Stage 0a (non-boolean define pre-scan).
 *
 * Used by the material-shader define-reject path (AC-03).
 */
function scanDefineDirectives(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('#define ')) continue;
    // Exclude #define NAME VALUE (with assignment)
    const parts = trimmed.slice('#define '.length).split(/\s+/);
    const name = parts[0];
    if (name !== undefined && parts.length === 1) {
      out.push(name);
    }
  }
  return out;
}

const IMPORT_DIRECTIVE_RE = /^\s*(?:\/\/\s*)?#import\s+([A-Za-z0-9_:]+)/;
const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_:]+)/;
const PRAGMA_VARIANT_AXIS_RE = /^#pragma\s+variant_axis\s+(\w+)/gm;

/**
 * Scan `source` for `#pragma variant_axis <AXIS_NAME>` directives and return
 * the axis names in declaration order. Duplicates are preserved (declaration
 * order wins for deterministic canonical key construction).
 */
function scanVariantAxes(source: string): string[] {
  const axes: string[] = [];
  for (const match of source.matchAll(PRAGMA_VARIANT_AXIS_RE)) {
    const name = match[1];
    if (name !== undefined) axes.push(name);
  }
  return axes;
}

/**
 * Produce the Cartesian product of N boolean axes as an array of defines maps.
 * For N axes [A, B], yields 2^N combinations: [{A:true,B:true}, {A:true,B:false}, ...].
 * Order: mask descends so the all-true variant comes first.
 */
function cartesianDefines(axes: readonly string[]): Record<string, boolean>[] {
  const n = axes.length;
  const total = 1 << n;
  const results: Record<string, boolean>[] = [];
  for (let mask = total - 1; mask >= 0; mask--) {
    const defines: Record<string, boolean> = {};
    for (let i = 0; i < n; i++) {
      const bit = (mask >> (n - 1 - i)) & 1;
      const axis = axes[i];
      if (axis !== undefined) {
        defines[axis] = bit === 1;
      }
    }
    results.push(defines);
  }
  return results;
}

/**
 * Build the canonical variant key per plan-strategy D-2:
 * sorted `key=value` entries joined with `+`.
 * All-axes-true variant produces key `""` (empty string) for backward compat.
 */
function buildVariantKey(defines: Record<string, boolean>): string {
  const entries = Object.entries(defines).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.every(([, v]) => v === true)) return '';
  return entries.map(([k, v]) => `${k}=${v}`).join('+');
}

/**
 * Compute the canonical variant key that should land in `state.entries`
 * (the variant consumed by the pre-built pipeline path in createRenderer).
 *
 * For shaders with the CLUSTER_FORWARD_AVAILABLE axis, the entry variant
 * is the URP combination: CLUSTER_FORWARD_AVAILABLE=false, all other axes
 * true. This avoids the all-true variant's cluster bindings (@binding(4)
 * through @binding(6)) leaking into the pre-built PSO path where the URP
 * `pbr-mesh-array-bgl` lacks those entries.
 *
 * For shaders without CLUSTER_FORWARD_AVAILABLE (pbr-skin, unlit), the
 * entry variant is the all-true variant (key '') — unchanged behavior.
 */
function buildEntryVariantKey(axes: readonly string[]): string {
  const hasClusterAxis = axes.includes('CLUSTER_FORWARD_AVAILABLE');
  if (!hasClusterAxis) return '';
  const defines: Record<string, boolean> = {};
  for (const axis of axes) {
    defines[axis] = axis !== 'CLUSTER_FORWARD_AVAILABLE';
  }
  return buildVariantKey(defines);
}

const PRAGMA_RE = /^\s*#pragma\s+\S.*$/gm;

/** Strip #pragma lines before passing to naga_oil -- they pass through compose and naga rejects `#` tokens. */
function stripPragmas(source: string): string {
  return source.replace(PRAGMA_RE, '');
}

/**
 * Scan `source` for a `#define_import_path <path>` header line and return the
 * declared path. Returns `undefined` when no header is present.
 */
function extractDefineImportPath(source: string): string | undefined {
  const match = DEFINE_IMPORT_PATH_RE.exec(source);
  return match?.[1] ?? undefined;
}

/**
 * Scan `source` for `#import <name>` directives and return the leading
 * moduleId-prefix (everything up to the first `{` / whitespace). Tail-end
 * specifiers like `::{A,B}` are stripped — `IMPORT_DIRECTIVE_RE` already
 * excludes `{` / `,` from its capture group. Lines prefixed with `// ` are
 * also accepted (test-fixture injection; matches the same rules as the real
 * naga_oil `#import` pre-scanner in `@forgeax/engine-shader-compiler`).
 */
function scanImportModuleIds(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = IMPORT_DIRECTIVE_RE.exec(line);
    if (!match) continue;
    const full = match[1];
    if (full === undefined) continue;
    // Strip trailing `::` (from `::{spec,spec}` braces that the regex's
    // character class can't consume) and any `{...}` specifier so the
    // moduleId key matches `#define_import_path` values byte-for-byte.
    const moduleId = full.replace(/::$/, '').split('::{')[0]?.split(/[\s,]/)[0] ?? full;
    out.push(moduleId);
  }
  return out;
}

/**
 * Scan `source` for `#import <name>` directives and return resolved absolute
 * file paths (same-directory convention — see `resolveImportToFile`). Lines
 * prefixed with `// ` are also accepted so that test fixtures can inject
 * directives without causing compileShader to fail naga_oil resolution.
 */
function scanImportDirectives(source: string, importerFile: string): string[] {
  const moduleIds = scanImportModuleIds(source);
  return moduleIds.map((name) => resolveImportToFile(importerFile, name));
}

/**
 * For each `#import <moduleId>` directive in `source`, read the resolved
 * sibling file, extract its `#define_import_path` declaration as the
 * canonical moduleId key (falls back to the `#import`'s leading segments
 * if the companion file has no header), and return the
 * `Record<moduleId, source>` map consumed by `compileShader.imports`.
 *
 * Called from the transform hook so that production `#import` chains
 * (`apps/hello/triangle/src/shaders/pbr.wgsl` importing `hello_triangle::view`
 * + `hello_triangle::brdf`) resolve through the Vite plugin during `vite
 * build` — without this step transform fails fast with
 * `shader-import-not-found`.
 *
 * Missing sibling files bubble up the fs.readFile rejection as-is; the
 * transform hook converts that into a structured ShaderError via the same
 * toRollupLog path used for compile failures (charter proposition 4
 * explicit failure).
 */
async function collectSiblingImports(
  source: string,
  importerFile: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const moduleIds = scanImportModuleIds(source);
  for (const moduleId of moduleIds) {
    const siblingPath = resolveImportToFile(importerFile, moduleId);
    const siblingSource = await readFile(siblingPath, 'utf8');
    let canonicalId = moduleId;
    for (const line of siblingSource.split(/\r?\n/)) {
      const header = DEFINE_IMPORT_PATH_RE.exec(line);
      if (header?.[1] !== undefined) {
        canonicalId = header[1];
        break;
      }
    }
    result[canonicalId] = siblingSource;
  }
  return result;
}

/**
 * Record every `depFile -> importerFile` edge implied by the directives
 * discovered by `scanImportDirectives`. Called from the transform hook on
 * every successful compile; Vite's transform pipeline is single-threaded so
 * no mutex is required (plan-strategy §3 RISK-3).
 */
function updateReverseDeps(importerFile: string, depFiles: readonly string[]): void {
  for (const depFile of depFiles) {
    let bucket = reverseDeps.get(depFile);
    if (bucket === undefined) {
      bucket = new Set<string>();
      reverseDeps.set(depFile, bucket);
    }
    bucket.add(importerFile);
  }
}

/**
 * Walk `reverseDeps` starting at `seed` and collect every transitively
 * reachable importer file (a -> b -> c: editing c returns {b, a}).
 * Handles self-referential cycles via a visited set.
 */
function collectTransitiveImporters(seed: string): string[] {
  const visited = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [seed];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const bucket = reverseDeps.get(current);
    if (bucket === undefined) continue;
    for (const importer of bucket) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      out.push(importer);
      stack.push(importer);
    }
  }
  return out;
}

// === 4-hook shape (minimal Vite Plugin interface contract) =========================
//
// We do not directly `import type Plugin from 'vite'` — the peerDep is
// unavailable during type-check, the Vite 8 Plugin<A> generic, and Rolldown's
// multiple `declare module` blocks all make a minimal interface constraint
// easier to maintain.
// Vite uses duck typing at runtime: as long as the plugin exposes `name` plus
// the expected hooks, it is registered.

/** Subset of Rollup PluginContext (only this.error + this.emitFile are used). */
interface MinimalPluginContext {
  error(log: { message: string } & Record<string, unknown>): never;
  emitFile(asset: { type: 'asset'; fileName: string; source: string }): string;
}

/**
 * Subset of Vite HmrContext (research Finding 3 field set). `server.moduleGraph.
 * getModulesByFile` is the D-10 cross-file propagation entry point — Vite
 * returns `Set<ModuleNode> | undefined` and the plugin null-safes with
 * `?? new Set()` per plan-strategy D-10 note 4.
 */
interface HmrModuleNodeLike {
  readonly file?: string | null;
}
type HmrGetModulesByFile = (file: string) => Set<HmrModuleNodeLike> | undefined;
interface HmrServerLike {
  readonly moduleGraph: { getModulesByFile: HmrGetModulesByFile };
}
interface HmrContextLike {
  readonly file: string;
  readonly modules: ReadonlyArray<HmrModuleNodeLike>;
  readonly server?: HmrServerLike | undefined;
}

// === configureServer hook contract (5th hook, plan-strategy §2 D-P2 / w2) =====
//
// Reference anchors (run before editing this region):
// - plan-strategy §2 D-P2: dev fix = candidate II-A configureServer middleware
//   intercepting the shader manifest URL + lazy `transformRequest`
// - research §F-V3: configureServer is the Vite-only dev-time middleware
//   injection point (not invoked during production build)
// - research §F-V5: server.transformRequest(url) is the official mechanism for
//   programmatically driving the plugin transform pipeline from inside a
//   middleware (used by SSR fixtures / dev-time prerender plugins)
// - research §F-V6: middleware lives at the connect.js layer and is NOT subject
//   to server.fs.allow (no need to touch vite.config.ts)
// - requirements §II-1 ~ §II-5 / §AC-01: dev path no longer reports
//   manifest-malformed; schema is byte-shape-equivalent to the generateBundle
//   (prod) path; fail-fast preserved (no silent try/catch around transform).

/** Connect.js NextHandleFunction shape — kept structural to match Vite. */
type NextHandleFunction = (err?: unknown) => void;

/** Subset of node http.ServerResponse used by the dev manifest middleware. */
interface ServerResponseLike {
  setHeader(name: string, value: string): void;
  end(chunk: string): void;
}

/** Subset of node http.IncomingMessage used by the dev manifest middleware. */
interface IncomingMessageLike {
  readonly url?: string | undefined;
}

/** connect.js Middleware shape (req / res / next). */
type ConnectMiddleware = (
  req: IncomingMessageLike,
  res: ServerResponseLike,
  next: NextHandleFunction,
) => void | Promise<void>;

/** Subset of vite.ViteDevServer used by configureServer. */
interface ViteDevServerLike {
  readonly middlewares: { use(handler: ConnectMiddleware): unknown };
  transformRequest(url: string): Promise<unknown>;
  readonly config?:
    | {
        readonly build?:
          | {
              readonly rollupOptions?:
                | {
                    readonly input?:
                      | string
                      | ReadonlyArray<string>
                      | Readonly<Record<string, string>>
                      | undefined;
                  }
                | undefined;
            }
          | undefined;
      }
    | undefined;
}

/** The shape of the plugin return value (6 hooks + name; 5th = configureServer; 6th = buildStart). */
export interface ForgeaXShaderPlugin {
  readonly name: string;
  config(cfg: unknown, env: { command: string }): void;
  buildStart(this: MinimalPluginContext): Promise<void>;
  /**
   * resolveId: claim the `virtual:forgeax/bundler` virtual module id so vite
   * routes its load to our `load` hook (TASK-019, plan-strategy D-4 q7-A).
   * Returns the same id (`virtual:forgeax/bundler`) on hit; null otherwise so
   * the default vite resolver runs for `.wgsl` and JS imports.
   */
  resolveId(this: unknown, source: string, importer?: string): string | null;
  /**
   * load: returns `.wgsl` -> null (default fs load -> transform); for the
   * `virtual:forgeax/bundler` id returns the inline-emit adapter source
   * (forgeaxBundlerAdapter factory; structurally compatible with
   * `@forgeax/engine-app` BundlerOptions, but NEVER imports it -- D-4 q7-A
   * reverse-coupling guard).
   */
  load(this: MinimalPluginContext, id: string): string | null;
  transform(
    this: MinimalPluginContext,
    code: string,
    id: string,
  ): Promise<{ code: string; map: null } | null>;
  generateBundle(this: MinimalPluginContext): void;
  handleHotUpdate(ctx: HmrContextLike): ReadonlyArray<HmrModuleNodeLike> | undefined;
  configureServer(server: ViteDevServerLike): void;
}

/**
 * Virtual module id for the bundler-options adapter (TASK-019 + D-4 q7-A).
 * Single SSOT for the id used across resolveId / load hooks + the consumer
 * `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler'` line.
 */
const VIRTUAL_BUNDLER_ID = 'virtual:forgeax/bundler';

/**
 * Manifest path suffix emitted by `generateBundle` and served by the
 * dev `configureServer` middleware. Single SSOT for the `shaders/manifest.json`
 * literal; consumers compose their own prefix:
 *   - virtual module adapter: (import.meta.env.BASE_URL ?? '/') + SHADER_MANIFEST_PATH
 *   - generateBundle emit: SHADER_MANIFEST_PATH (relative, no leading /)
 *   - configureServer middleware: '/' + SHADER_MANIFEST_PATH
 * (AC-12; plan-strategy D-4 q7-A SSOT).
 */
const SHADER_MANIFEST_PATH = 'shaders/manifest.json';

/**
 * Inline source returned by the `load` hook for `virtual:forgeax/bundler`.
 * The factory function `forgeaxBundlerAdapter` returns a plain object that is
 * structurally compatible with `@forgeax/engine-app` `BundlerOptions`
 * (TASK-019 / D-4 q7-A: no `@forgeax/engine-app` import to avoid the
 * vite-plugin-shader -> engine-app reverse coupling concern).
 *
 * Why an inline string instead of a separate `.ts` file: the plugin is the
 * only producer; emitting source from the load hook keeps the manifestUrl
 * literal a single SSOT (plugin-side) and avoids a second file that
 * downstream packages could accidentally import directly. Consumers reach
 * the adapter solely through the virtual module id.
 *
 * shaderManifestUrl is base-aware: at browser runtime, `import.meta.env.BASE_URL`
 * carries Vite's `base` config so the manifest resolves under non-root bases
 * without recompilation. The suffix `SHADER_MANIFEST_PATH` is the SSOT
 * constant defined above.
 */
const VIRTUAL_BUNDLER_SOURCE = `// AUTO-GENERATED by @forgeax/engine-vite-plugin-shader
// virtual:forgeax/bundler -- forgeaxBundlerAdapter factory.
// Do not edit; the plugin emits this module on demand.
export function forgeaxBundlerAdapter() {
  return {
    shaderManifestUrl: (import.meta.env.BASE_URL ?? '/') + ${JSON.stringify(SHADER_MANIFEST_PATH)},
    importTransport: undefined,
  };
}
`;

// === Engine entries: eager compile of packages/shader/src/{pbr,unlit}.wgsl ====
//
// feat-20260518-pbr-direct-lighting-mvp M5 / w22.8 (plan-strategy §2 D-3 + D-4
// + AC-05 PBR_FALLBACK_WGSL grep 0): the engine ships pbr.wgsl + unlit.wgsl
// inside `@forgeax/engine-shader/src/`, but apps do not import them
// directly (RenderSystem dispatches via material.shadingModel inside the
// engine — pipeline isolation, AGENTS.md). To keep the runtime
// `ShaderRegistry` manifest path the single SSOT (charter P4 consistent
// abstraction), the plugin eagerly compiles these two entry shaders at
// `buildStart` with `common.wgsl` + `brdf.wgsl` supplied as naga_oil
// `#import` peers, and parks the results in the same `state.entries` Map
// that `transform` populates for app-owned `.wgsl` imports. Both
// `generateBundle` (prod) and `configureServer` (dev) then aggregate every
// entry into a single manifest payload.
//
// Resolution: `createRequire(import.meta.url).resolve(...)` reaches
// `packages/shader/package.json` through the workspace dep, then we read
// `src/{pbr,unlit,common,brdf}.wgsl` as siblings. The shader package's
// `package.json#files` already includes `src` so this works in installed
// trees as well as in the workspace.

interface EngineShaderFile {
  readonly id: string;
  readonly source: string;
  /**
   * Reserved identifier for engine-shipped material shaders (e.g.
   * `forgeax::default-standard-pbr`). When present, overrides the
   * `#define_import_path` header for the `materialShaders[].identifier`
   * field in the emitted manifest. Entries without a reserved identifier
   * fall back to `#define_import_path` and then to the filesystem path.
   *
   * @since feat-20260526-pbr-uniform-fallback-no-storage-buffer M4-repair
   */
  readonly reservedIdentifier?: string | undefined;
}

interface EngineShaderEntries {
  // feat-20260523-shader-template-instance-split M5 / T09: pbr.wgsl is
  // retired; default-standard-pbr.wgsl is the engine PBR entry. The
  // composed manifest entry feeds
  // ShaderRegistry.registerMaterialShader('forgeax::default-standard-pbr',
  // ...) wired by createRenderer at engine boot (M6 host wiring + the
  // existing `f_schlick` content marker in createRenderer.ts identifies
  // the engine PBR entry post-rename).
  readonly defaultStandardPbr: EngineShaderFile;
  /**
   * feat-20260523-skin-skeleton-animation M3 / T-34: pbr-skin WGSL entry.
   * Compiled at buildStart alongside default-standard-pbr and surfaced
   * in the manifest so the runtime createRenderer can wire
   * registerDefaultStandardPbrSkin at engine boot.
   */
  readonly defaultStandardPbrSkin: EngineShaderFile;
  readonly unlit: EngineShaderFile;
  readonly tonemap: EngineShaderFile;
  readonly shadowCaster: EngineShaderFile;
  // feat-20260520-2d-sprite-layer-mvp / M-3 / w20: 5th engine entry for
  // the 2D sprite alpha-blend pipeline (w24). Same naga_oil 0.22 Composer
  // #import path as unlit / pbr / tonemap — pulls `forgeax_view::common`
  // peer for the View struct (requirements §3 AC-04 + research §Finding
  // C-1; plan-strategy §3 SH1 + §7 M-3 acceptanceCheck AC-04 §2). The
  // manifest carries { 'pbr', 'unlit', 'tonemap', 'shadow_caster',
  // 'sprite', + 4 IBL }.
  readonly sprite: EngineShaderFile;
  /**
   * feat-20260531-world-space-msdf-text-rendering M5 / w20-w21: world-space
   * MSDF text material entry. Same naga_oil #import forgeax_view::common peer
   * as unlit / sprite (View struct for worldViewProj + cameraPos billboard).
   * Surfaced in the manifest so the runtime createRenderer registers
   * `forgeax::msdf-text` at engine boot (D-7 -- materialShaderId path, zero
   * new pipelineTag).
   */
  readonly msdfText: EngineShaderFile;
  /**
   * M5-amend Gap A (feat-20260520-skylight-ibl-cubemap): 4 IBL precompute
   * standalone entries. Each carries its own cubemap_vs / fullscreen_vs +
   * fragment entry pair and imports forgeax_pbr::ibl_shared (and
   * forgeax_pbr::ibl_sampling for prefilter / brdf-lut). Compiled at
   * buildStart and surfaced in the manifest so the runtime
   * createRenderer can call setIblComposedShaders before
   * IblPipelineCache.createIblPipelines runs (charter P5: same SSOT,
   * single build-time composition path; AGENTS.md grep gate forbids
   * runtime engine-shader from touching engine-naga).
   */
  readonly iblEquirectToCube: EngineShaderFile;
  readonly iblIrradiance: EngineShaderFile;
  readonly iblPrefilter: EngineShaderFile;
  readonly iblBrdfLut: EngineShaderFile;
  readonly fxaa: EngineShaderFile;
  readonly bloomBright: EngineShaderFile;
  readonly bloomBlur: EngineShaderFile;
  readonly bloomComposite: EngineShaderFile;
  /**
   * feat-20260531-skybox-env-background M3 / w14: skybox fullscreen cubemap
   * shader entry. Vertex stage imports forgeax_view::common::fullscreen_triangle,
   * fragment stage reconstructs world-space view direction via View.inverseViewProj
   * and samples a texture_cube<f32>. No reservedIdentifier (non-material shader,
   * same pattern as tonemap/fxaa).
   */
  readonly skybox: EngineShaderFile;
  /**
   * feat-20260612-hdrp-ssao M6 / w27: SSAO fullscreen post-process shader
   * entry. Vertex stage imports forgeax_view::common::fullscreen_triangle,
   * fragment stages fs_ssao_calc + fs_ssao_blur for half-resolution AO.
   * plan-strategy D-E: manifest entry with content marker 'fs_ssao_calc'.
   */
  readonly hdrpSsao: EngineShaderFile;
  readonly imports: Record<string, string>;
}

// feat-20260609-hdrp-cluster-fragment-ggx M1 / w4: per-variant import filtering.
// naga_oil parses all modules in the imports map even when the #import directive
// is inside an #ifdef block whose condition is false for the current variant.
// This helper filters out imports whose #import line is inside an #ifdef block
// with a false condition for the given defines, checking each #import line's
// surrounding #ifdef context.
//
// M5-hotfix scope-amendment (co-cluster-binding-defensive): the #import
// #ifdef wrapping in the entry source (Fix 2) pairs with this filter so naga_oil
// skips the #import directive itself and never processes the excluded module.
// @forgeax/engine-shader-compiler's checkImportsResolvable (Fix 3) is also
// #ifdef-aware so the TS-layer pre-check matches naga_oil's behavior.
function filterImportsByDefines(
  allImports: Record<string, string>,
  source: string,
  defines: Record<string, boolean>,
  axes: readonly string[],
): Record<string, string> {
  if (axes.length === 0) return allImports;
  // Step A: scan source for active direct #import lines (respecting #ifdef state).
  const activeDirectModules = new Set<string>();
  const lines = source.split(/\r?\n/);
  // Track disabled depth: each element is [disabled: boolean, seenElse: boolean].
  // Incremented on #ifdef(axis) with !defines[axis] (or already disabled).
  const disableStack: Array<[boolean, boolean]> = [];
  for (const line of lines) {
    const ifdefMatch = /^\s*#ifdef\s+(\w+)/.exec(line);
    const ifndefMatch = /^\s*#ifndef\s+(\w+)/.exec(line);
    if (ifdefMatch) {
      const axis = ifdefMatch[1] ?? '';
      const parentDisabled = disableStack.length > 0 && disableStack[disableStack.length - 1]?.[0];
      disableStack.push([parentDisabled || !(defines[axis] ?? false), false]);
      continue;
    }
    if (ifndefMatch) {
      const axis = ifndefMatch[1] ?? '';
      const parentDisabled = disableStack.length > 0 && disableStack[disableStack.length - 1]?.[0];
      disableStack.push([parentDisabled || (defines[axis] ?? false), false]);
      continue;
    }
    if (/^\s*#else\b/.exec(line)) {
      if (disableStack.length > 0) {
        const top = disableStack[disableStack.length - 1];
        if (top !== undefined && !top[1]) {
          // Only flip once per #else
          const parentDisabled =
            disableStack.length > 1 && disableStack[disableStack.length - 2]?.[0];
          if (!parentDisabled) {
            top[0] = !top[0];
          }
          top[1] = true;
        }
      }
      continue;
    }
    if (/^\s*#endif/.exec(line)) {
      if (disableStack.length > 0) disableStack.pop();
      continue;
    }
    // Skip lines in disabled blocks
    if (disableStack.length > 0 && disableStack[disableStack.length - 1]?.[0]) continue;
    const importMatch = /^\s*(?:\/\/\s*)?#import\s+([A-Za-z0-9_:]+)/.exec(line);
    if (importMatch?.[1]) {
      const full = importMatch[1];
      const moduleId = full.split('::{')[0]?.split(/[\s,]/)[0] ?? full;
      activeDirectModules.add(moduleId.replace(/::$/, ''));
    }
  }
  // Step B: BFS from active direct imports through allImports to collect
  // the full transitive closure. A module like ibl_sampling may be active
  // directly but its own #import of ibl_shared only appears inside
  // ibl_sampling.wgsl, not in the entry source — skipping this BFS would
  // drop ibl_shared and cause naga_oil compose failure.
  const activeModules = new Set(activeDirectModules);
  const queue = [...activeDirectModules];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    const modSource = allImports[cur];
    if (modSource === undefined) continue;
    const childIds = scanImportModuleIds(modSource);
    for (const childRawId of childIds) {
      const childId = resolveImportModuleId(childRawId, allImports);
      if (childId !== undefined && !activeModules.has(childId)) {
        activeModules.add(childId);
        queue.push(childId);
      }
    }
  }
  const result: Record<string, string> = {};
  for (const [modId, src] of Object.entries(allImports)) {
    if (activeModules.has(modId)) result[modId] = src;
  }
  return result;
}

async function loadEngineShaderEntries(): Promise<EngineShaderEntries> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@forgeax/engine-shader/package.json');
  const shaderRoot = dirname(packageJsonPath);
  const srcDir = resolve(shaderRoot, 'src');
  const defaultStandardPbrPath = resolve(srcDir, 'default-standard-pbr.wgsl');
  const defaultStandardPbrSkinPath = resolve(srcDir, 'default-standard-pbr-skin.wgsl');
  const unlitPath = resolve(srcDir, 'unlit.wgsl');
  const tonemapPath = resolve(srcDir, 'tonemap.wgsl');
  const shadowCasterPath = resolve(srcDir, 'shadow_caster.wgsl');
  const spritePath = resolve(srcDir, 'sprite.wgsl');
  const msdfTextPath = resolve(srcDir, 'msdf-text.wgsl');
  const commonPath = resolve(srcDir, 'common.wgsl');
  const brdfPath = resolve(srcDir, 'brdf.wgsl');
  // M3 round-2 (feat-20260520-skylight-ibl-cubemap / t49): round-1 single
  // forgeax_pbr::ibl entry replaced by 6 physically isolated modules so each
  // module's @group/@binding namespace is its own (WGSL spec rule: (group,
  // binding) must be globally unique within a module; the round-1 single
  // ibl.wgsl collided @group(1) @binding(0) across texture_2d + texture_cube).
  const iblSharedPath = resolve(srcDir, 'ibl-shared.wgsl');
  const iblEquirectToCubePath = resolve(srcDir, 'ibl-equirect-to-cube.wgsl');
  const iblIrradiancePath = resolve(srcDir, 'ibl-irradiance.wgsl');
  const iblPrefilterPath = resolve(srcDir, 'ibl-prefilter.wgsl');
  const iblBrdfLutPath = resolve(srcDir, 'ibl-brdf-lut.wgsl');
  const iblSamplingPath = resolve(srcDir, 'ibl-sampling.wgsl');
  // feat-20260523-shader-template-instance-split M5: pbr.wgsl + future
  // default-standard-pbr.wgsl pull TBN + lighting helpers via #import
  // forgeax_pbr::{tbn,lighting_directional,lighting_punctual}. naga_oil
  // composer rejects the entry source if the import target is absent from
  // the imports map -- list them here so buildStart composition succeeds.
  const tbnPath = resolve(srcDir, 'tbn.wgsl');
  const lightingDirectionalPath = resolve(srcDir, 'lighting-directional.wgsl');
  const lightingPunctualPath = resolve(srcDir, 'lighting-punctual.wgsl');
  const fxaaPath = resolve(srcDir, 'fxaa.wgsl');
  const bloomBrightPath = resolve(srcDir, 'bloom-bright.wgsl');
  const bloomBlurPath = resolve(srcDir, 'bloom-blur.wgsl');
  const bloomCompositePath = resolve(srcDir, 'bloom-composite.wgsl');
  const skyboxPath = resolve(srcDir, 'skybox.wgsl');
  const hdrpClusterForwardPath = resolve(srcDir, 'hdrp-cluster-forward.wgsl');
  const hdrpSsaoPath = resolve(srcDir, 'hdrp-ssao.wgsl');
  // feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1 (plan-strategy D-4):
  // shared PCF core imported by lighting-directional.wgsl (2D) and
  // lighting-punctual.wgsl + hdrp-cluster-forward.wgsl (cube). Registered
  // in the imports map so naga_oil compose resolves #import forgeax_pbr::shadow_pcf.
  const shadowPcfPath = resolve(srcDir, 'shadow-pcf.wgsl');
  const [
    defaultStandardPbrSrc,
    defaultStandardPbrSkinSrc,
    unlitSrc,
    tonemapSrc,
    shadowCasterSrc,
    spriteSrc,
    msdfTextSrc,
    commonSrc,
    brdfSrc,
    iblSharedSrc,
    iblEquirectToCubeSrc,
    iblIrradianceSrc,
    iblPrefilterSrc,
    iblBrdfLutSrc,
    iblSamplingSrc,
    tbnSrc,
    lightingDirectionalSrc,
    lightingPunctualSrc,
    fxaaSrc,
    bloomBrightSrc,
    bloomBlurSrc,
    bloomCompositeSrc,
    skyboxSrc,
    hdrpClusterForwardSrc,
    hdrpSsaoSrc,
    shadowPcfSrc,
  ] = await Promise.all([
    readFile(defaultStandardPbrPath, 'utf8'),
    readFile(defaultStandardPbrSkinPath, 'utf8'),
    readFile(unlitPath, 'utf8'),
    readFile(tonemapPath, 'utf8'),
    readFile(shadowCasterPath, 'utf8'),
    readFile(spritePath, 'utf8'),
    readFile(msdfTextPath, 'utf8'),
    readFile(commonPath, 'utf8'),
    readFile(brdfPath, 'utf8'),
    readFile(iblSharedPath, 'utf8'),
    readFile(iblEquirectToCubePath, 'utf8'),
    readFile(iblIrradiancePath, 'utf8'),
    readFile(iblPrefilterPath, 'utf8'),
    readFile(iblBrdfLutPath, 'utf8'),
    readFile(iblSamplingPath, 'utf8'),
    readFile(tbnPath, 'utf8'),
    readFile(lightingDirectionalPath, 'utf8'),
    readFile(lightingPunctualPath, 'utf8'),
    readFile(fxaaPath, 'utf8'),
    readFile(bloomBrightPath, 'utf8'),
    readFile(bloomBlurPath, 'utf8'),
    readFile(bloomCompositePath, 'utf8'),
    readFile(skyboxPath, 'utf8'),
    readFile(hdrpClusterForwardPath, 'utf8'),
    readFile(hdrpSsaoPath, 'utf8'),
    readFile(shadowPcfPath, 'utf8'),
  ]);
  return {
    defaultStandardPbr: {
      id: defaultStandardPbrPath,
      source: defaultStandardPbrSrc,
      reservedIdentifier: 'forgeax::default-standard-pbr',
    },
    defaultStandardPbrSkin: {
      id: defaultStandardPbrSkinPath,
      source: defaultStandardPbrSkinSrc,
      reservedIdentifier: 'forgeax::pbr-skin',
    },
    unlit: { id: unlitPath, source: unlitSrc, reservedIdentifier: 'forgeax::default-unlit' },
    tonemap: { id: tonemapPath, source: tonemapSrc },
    shadowCaster: {
      id: shadowCasterPath,
      source: shadowCasterSrc,
      reservedIdentifier: 'forgeax::default-shadow-caster',
    },
    sprite: { id: spritePath, source: spriteSrc, reservedIdentifier: 'forgeax::sprite' },
    msdfText: { id: msdfTextPath, source: msdfTextSrc, reservedIdentifier: 'forgeax::msdf-text' },
    iblEquirectToCube: { id: iblEquirectToCubePath, source: iblEquirectToCubeSrc },
    iblIrradiance: { id: iblIrradiancePath, source: iblIrradianceSrc },
    iblPrefilter: { id: iblPrefilterPath, source: iblPrefilterSrc },
    iblBrdfLut: { id: iblBrdfLutPath, source: iblBrdfLutSrc },
    fxaa: { id: fxaaPath, source: fxaaSrc },
    bloomBright: { id: bloomBrightPath, source: bloomBrightSrc },
    bloomBlur: { id: bloomBlurPath, source: bloomBlurSrc },
    bloomComposite: { id: bloomCompositePath, source: bloomCompositeSrc },
    skybox: { id: skyboxPath, source: skyboxSrc },
    hdrpSsao: { id: hdrpSsaoPath, source: hdrpSsaoSrc },
    imports: {
      'forgeax_view::common': commonSrc,
      'forgeax_pbr::brdf': brdfSrc,
      'forgeax_pbr::ibl_shared': iblSharedSrc,
      'forgeax_pbr::ibl_equirect_to_cube': iblEquirectToCubeSrc,
      'forgeax_pbr::ibl_irradiance': iblIrradianceSrc,
      'forgeax_pbr::ibl_prefilter': iblPrefilterSrc,
      'forgeax_pbr::ibl_brdf_lut': iblBrdfLutSrc,
      'forgeax_pbr::ibl_sampling': iblSamplingSrc,
      'forgeax_pbr::tbn': tbnSrc,
      'forgeax_pbr::lighting_directional': lightingDirectionalSrc,
      'forgeax_pbr::lighting_punctual': lightingPunctualSrc,
      'forgeax_view::fxaa': fxaaSrc,
      'forgeax_view::bloom_bright': bloomBrightSrc,
      'forgeax_view::bloom_blur': bloomBlurSrc,
      'forgeax_view::bloom_composite': bloomCompositeSrc,
      'forgeax_hdrp::cluster_forward': hdrpClusterForwardSrc,
      // feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1 (plan-strategy D-4):
      // shared PCF core. #import forgeax_pbr::shadow_pcf resolves to
      // shadow-pcf.wgsl. Consumers: lighting-directional.wgsl (2D wrapper)
      // + lighting-punctual.wgsl + hdrp-cluster-forward.wgsl (cube wrapper).
      'forgeax_pbr::shadow_pcf': shadowPcfSrc,
    },
  };
}

/**
 * Rewrite materialShaders entries so that every `composedWgsl` field is the
 * inline WGSL source string, not the relative path reference (`./<hash>.composed.wgsl`).
 * Runtime consumer (createRenderer) passes composedWgsl directly to
 * registerMaterialShader({ source: wgsl }) and WGSL tokenizers reject path strings.
 */
function inlineMaterialShaderComposedWgsl(
  materialShaders: readonly MaterialShaderManifestEntry[],
  entries: ReadonlyMap<string, ManifestEntryValue>,
  variantWgsl: ReadonlyMap<string, string>,
): MaterialShaderManifestEntry[] {
  return materialShaders.map((ms) => {
    const defaultEntry = entries.get(ms.sourcePath);
    // For entries with variants, resolve per-variant composedWgsl from variantWgsl;
    // for single-variant entries, resolve from state.entries.
    const variants: MaterialShaderManifestVariant[] = ms.variants.map((v) => {
      const variantKey = `${ms.sourcePath}#${v.definesKey}`;
      const wgslSource = variantWgsl.get(variantKey) ?? v.composedWgsl;
      return { ...v, composedWgsl: wgslSource };
    });
    const entryComposedWgsl = defaultEntry?.wgsl ?? ms.composedWgsl;
    return { ...ms, composedWgsl: entryComposedWgsl, variants };
  });
}

function emitShaderTriplet(
  ctx: MinimalPluginContext,
  hash: string,
  wgsl: string,
  bindingsJson: string,
  serve: boolean,
): void {
  if (serve) return;
  ctx.emitFile({ type: 'asset', fileName: `shaders/${hash}.wgsl`, source: wgsl });
  ctx.emitFile({ type: 'asset', fileName: `shaders/${hash}.glsl`, source: '' });
  ctx.emitFile({ type: 'asset', fileName: `shaders/${hash}.bindings.json`, source: bindingsJson });
}

// M5-hotfix scope-amendment (co-cluster-binding-defensive): flatten false
// #ifdef blocks in the source before passing to naga_oil. naga_oil resolves
// symbols (including #import targets and function calls) before evaluating
// #ifdef. This pre-processor handles three shapes:
//   (a) #ifdef AXIS ... #endif (no #else) when AXIS=false: remove entirely.
//   (b) #ifdef AXIS ... #else ... #endif when AXIS=false: keep only the #else
//       body, drop all #ifdef/#else/#endif directives.
//   (c) #ifdef AXIS ... #endif when AXIS=true: pass through (keep directives).
// The companion checkImportsResolvable in engine-shader-compiler is also
// #ifdef-aware (M5-hotfix Fix 3).
function stripFalseImports(source: string, defines: Record<string, boolean>): string {
  const axes = Object.keys(defines);
  if (axes.length === 0) return source;
  const lines = source.split(/\r?\n/);
  // [disabled, seenElse, ifdefRemoved, startIndex]
  // ifdefRemoved=true when the #ifdef line was NOT pushed to out (block started disabled).
  const disableStack: Array<[boolean, boolean, boolean, number]> = [];
  const out: string[] = [];
  for (const line of lines) {
    const ifdefMatch = /^\s*#ifdef\s+(\w+)/.exec(line);
    const ifndefMatch = /^\s*#ifndef\s+(\w+)/.exec(line);
    if (ifdefMatch) {
      const axis = ifdefMatch[1] ?? '';
      const parentDisabled = disableStack.length > 0 && disableStack[disableStack.length - 1]?.[0];
      const disabled = parentDisabled || !(defines[axis] ?? false);
      disableStack.push([disabled, false, disabled, out.length]);
      if (!disabled) out.push(line);
      continue;
    }
    if (ifndefMatch) {
      const axis = ifndefMatch[1] ?? '';
      const parentDisabled = disableStack.length > 0 && disableStack[disableStack.length - 1]?.[0];
      const disabled = parentDisabled || (defines[axis] ?? false);
      disableStack.push([disabled, false, disabled, out.length]);
      if (!disabled) out.push(line);
      continue;
    }
    if (/^\s*#else\b/.exec(line)) {
      if (disableStack.length > 0) {
        const top = disableStack[disableStack.length - 1];
        if (top !== undefined && !top[1]) {
          const parentDisabled =
            disableStack.length > 1 && disableStack[disableStack.length - 2]?.[0];
          if (!parentDisabled) top[0] = !top[0];
          top[1] = true;
        }
      }
      // Skip the #else directive if the block started disabled. We want the
      // #else body to flow through (since top[0] flipped to false), but the
      // #else line itself is meaningless without a matching #ifdef.
      const top = disableStack.length > 0 ? (disableStack[disableStack.length - 1] ?? null) : null;
      if (top?.[2]) continue; // #ifdef was removed, skip #else too
      out.push(line);
      continue;
    }
    if (/^\s*#endif/.exec(line)) {
      if (disableStack.length > 0) {
        const top = disableStack.pop();
        if (top?.[2]) continue; // #ifdef was removed, skip #endif too
      }
      out.push(line);
      continue;
    }
    // Skip lines in disabled blocks.
    if (disableStack.length > 0 && disableStack[disableStack.length - 1]?.[0]) continue;
    out.push(line);
  }
  return out.join('\n');
}

async function compileEngineEntry(
  ctx: MinimalPluginContext,
  state: ManifestEntries,
  file: EngineShaderFile,
  imports: Record<string, string>,
  serve: boolean,
): Promise<void> {
  const isMaterialShader = file.reservedIdentifier !== undefined;
  // bug-20260610: non-material engine entries that declare a #pragma
  // variant_axis (e.g. shadow_caster.wgsl on the WebGL2 fallback path) need
  // their per-variant composed WGSL surfaced to the runtime so the renderer
  // can pick the STORAGE_BUFFER_AVAILABLE=false body when storage buffers
  // are unavailable. We piggy-back on the materialShaders channel with a
  // synthetic `forgeax::engine-<basename>` identifier — the runtime treats
  // these the same way it treats material-shader entries (variant lookup
  // by identifier) but does NOT call registerMaterialShader on them.
  const hasVariantAxis = scanVariantAxes(file.source).length > 0;
  const surfaceVariants = isMaterialShader || hasVariantAxis;
  let paramSchemaJson = '[]';

  if (isMaterialShader) {
    const metaPath = `${file.id}.meta.json`;
    let metaRaw: string;
    try {
      metaRaw = await readFile(metaPath, 'utf8');
    } catch {
      throw new Error(
        `engine material-shader entry '${file.id}' is missing required .wgsl.meta.json sidecar (plan-strategy D-2: sidecar is the paramSchema SSOT for all material shaders)`,
      );
    }
    let meta: unknown;
    try {
      meta = JSON.parse(metaRaw);
    } catch (e) {
      throw new Error(
        `engine material-shader sidecar '${metaPath}' contains invalid JSON: ${String(e)}`,
      );
    }
    if (meta == null || typeof meta !== 'object') {
      throw new Error(`engine material-shader sidecar '${metaPath}' is not a valid JSON object`);
    }
    const metaObj = meta as Record<string, unknown>;
    if (metaObj.importer !== 'shader') {
      throw new Error(
        `engine material-shader sidecar '${metaPath}' has importer '${String(metaObj.importer)}', expected 'shader'`,
      );
    }
    const paramSchema = metaObj.paramSchema;
    if (!Array.isArray(paramSchema)) {
      throw new Error(
        `engine material-shader sidecar '${metaPath}' is missing required paramSchema array`,
      );
    }
    // feat-20260609 T-018 fixup: empty paramSchema is allowed for vertex-only
    // material shaders (e.g. forgeax::default-shadow-caster — shadow depth
    // pass with no fragment stage and no per-material params). Earlier
    // requirement of non-empty paramSchema was an artifact of forward-only
    // material shaders predating this feat.
    paramSchemaJson = JSON.stringify(paramSchema);
  }
  const variantAxes = scanVariantAxes(file.source);
  const axisCombos = variantAxes.length > 0 ? cartesianDefines(variantAxes) : [{}];

  const baseIdentifier = file.reservedIdentifier ?? extractDefineImportPath(file.source) ?? file.id;
  const variants: MaterialShaderManifestVariant[] = [];
  // feat-20260613 fix-issue-2: bindingLayout is no longer a manifest field;
  // the variant-axis superset gate (below) needs the freshly compiled
  // bindings JSON for the default variant, so we keep a parallel string
  // array indexed alongside `variants` (same length, same order).
  const variantBindingsJson: string[] = [];
  const cleanSource = stripPragmas(file.source);
  const allTransitiveImports =
    variantAxes.length > 0 ? extractTransitiveImports(cleanSource, imports) : imports;

  for (const defines of axisCombos) {
    // feat-20260609-hdrp-cluster-fragment-ggx M1 / w4: per-variant import
    // filtering. naga_oil parses all modules in the imports map regardless
    // of whether the #import directive is gated behind an #ifdef. When a
    // module carries WGSL declarations that are only valid inside a function
    // body (e.g. let at module scope), including it in the imports map for
    // a variant where the #import is excluded causes compose failure. We
    // filter out imports whose #import directive is inside an #ifdef block
    // whose condition is false for this variant.
    const perVariantImports = filterImportsByDefines(
      allTransitiveImports,
      cleanSource,
      defines,
      variantAxes,
    );
    const definesKey = buildVariantKey(defines);
    const uniqueId =
      variantAxes.length > 0 && definesKey !== '' ? `${file.id}#${definesKey}` : file.id;
    // M5-hotfix (co-cluster-binding-defensive): strip #import directives
    // inside false #ifdef blocks from the entry source before naga_oil
    // compose. naga_oil resolves #import before evaluating #ifdef; we
    // remove them here so the false-variant import-not-found error is
    // eliminated at the TS layer.
    const perVariantSource =
      variantAxes.length > 0 ? stripFalseImports(cleanSource, defines) : cleanSource;
    const r = await compileShader(perVariantSource, {
      id: uniqueId,
      imports: perVariantImports,
      // Non-variant entries always compile with STORAGE_BUFFER_AVAILABLE=true
      // because common.wgsl has #ifdef STORAGE_BUFFER_AVAILABLE for mesh/
      // pointLight/spotLight bindings. Without the define the WGSL falls to
      // var<uniform> while the runtime BGL uses read-only-storage, causing
      // pipeline validation mismatch (M4-repair pre-existing fix).
      ...(variantAxes.length > 0
        ? { defines }
        : { defines: { STORAGE_BUFFER_AVAILABLE: true, POINT_SHADOW_AVAILABLE: true } }),
    });
    if (!r.ok) {
      throw Object.assign(new Error(r.error.message), toRollupLog(r.error));
    }
    const { manifestEntry } = r.value;
    const hash = manifestEntry.hash;
    const bindingsJson =
      typeof manifestEntry.bindings === 'string'
        ? manifestEntry.bindings
        : JSON.stringify(manifestEntry.bindings);

    if (variantAxes.length === 0) {
      state.entries.set(file.id, { hash, wgsl: manifestEntry.wgsl, bindings: bindingsJson });
      emitShaderTriplet(ctx, hash, manifestEntry.wgsl, bindingsJson, serve);
      if (isMaterialShader) {
        // feat-20260613-material-paramschema-driven-binding M4 / w8 fix-up
        // (orchestrator Q2): apply the same single-direction superset gate
        // (D-9) to engine-shipped material shaders so AC-13 (build-time
        // material-shader-binding-mismatch) actually fires for the 5 built-in
        // shaders. The user-shader transform path runs the gate too; without
        // this call engine entries silently drift away from derive(schema).
        //
        // Engine shaders import @group(0) view + @group(2) meshes + @group(3)
        // instances bindings via `#import forgeax_view::common`; the
        // paramSchema only describes @group(1) (the material BGL). Pass just
        // the group(1) descriptor so the comparator's flatten-by-binding
        // helper does not clash with same-numbered entries from other groups
        // (e.g. shadowMap @group(0) @binding(3) vs metallicRoughnessSampler
        // @group(1) @binding(3)).
        const allBgls =
          typeof manifestEntry.bindings === 'string'
            ? (JSON.parse(manifestEntry.bindings) as readonly BindGroupLayoutDescriptor[])
            : (manifestEntry.bindings as readonly BindGroupLayoutDescriptor[]);
        const materialBgl = allBgls[1];
        const groupOneBgls: readonly BindGroupLayoutDescriptor[] =
          materialBgl !== undefined ? [materialBgl] : [];
        const supersetResult = compareParamSchemaSuperset(
          JSON.parse(paramSchemaJson) as readonly ParamSchemaEntry[],
          groupOneBgls,
          file.id,
        );
        if (!supersetResult.ok) {
          throw Object.assign(
            new Error(supersetResult.error.message),
            toRollupLog(supersetResult.error),
          );
        }
        state.materialShaders.push({
          identifier: baseIdentifier,
          sourcePath: file.id,
          composedWgsl: `./${hash}.composed.wgsl`,
          paramSchema: paramSchemaJson,
          variants: [],
        });
      }
      return;
    }

    variants.push({
      definesKey,
      defines: { ...defines },
      composedWgsl: `./${hash}.composed.wgsl`,
    });
    variantBindingsJson.push(bindingsJson);
    // Issue #1 fix (M4-repair): only the default (all-true) variant lands in
    // state.entries. Variant entries get a separate map for generateBundle
    // sidecar emission — they must not pollute the hash-based entries array
    // because the createRenderer Step 2 triage loop iterating duplicates
    // causes f_schlick-positive PBR-skin variants to clobber unlitEntry.
    //
    // M4-scope-amendment: the pre-built standard pipeline path in
    // createRenderer consumes state.entries directly (not variantWgsl).
    // The all-true variant carries cluster bindings (@binding(4)..@binding(6))
    // that don't exist in the URP pbr-mesh-array-bgl, causing pipeline
    // validation mismatch. Fix: store the URP variant (CLUSTER_FORWARD_AVAILABLE
    // =false) when the shader has that axis; store all-true otherwise.
    //
    // The URP canonical key is the defines combination where every axis
    // EXCEPT CLUSTER_FORWARD_AVAILABLE is true. For shaders without the
    // CLUSTER_FORWARD_AVAILABLE axis (pbr-skin, unlit) this is the all-true
    // variant — unchanged from pre-amendment behavior.
    if (definesKey === buildEntryVariantKey(variantAxes)) {
      state.entries.set(file.id, { hash, wgsl: manifestEntry.wgsl, bindings: bindingsJson });
    }
    state.variantWgsl.set(`${file.id}#${definesKey}`, manifestEntry.wgsl);
    emitShaderTriplet(ctx, hash, manifestEntry.wgsl, bindingsJson, serve);
  }

  if (variantAxes.length > 0) {
    const defaultVariant = variants[0];
    const defaultVariantBindingsJson = variantBindingsJson[0];
    if (
      defaultVariant !== undefined &&
      defaultVariantBindingsJson !== undefined &&
      surfaceVariants
    ) {
      // feat-20260613 M4 / w8 fix-up (orchestrator Q2) +
      // feat-20260613 fix-issue-2: superset gate also applies to engine
      // entries that carry variant axes (default-standard-pbr
      // STORAGE_BUFFER_AVAILABLE / CLUSTER_FORWARD_AVAILABLE etc). Compare
      // paramSchema against the default variant's BGL -- bindings are read
      // from the parallel `variantBindingsJson[0]` rather than the now-gone
      // `defaultVariant.bindingLayout` field.
      if (isMaterialShader) {
        const allBgls = JSON.parse(
          defaultVariantBindingsJson,
        ) as readonly BindGroupLayoutDescriptor[];
        const materialBgl = allBgls[1];
        const groupOneBgls: readonly BindGroupLayoutDescriptor[] =
          materialBgl !== undefined ? [materialBgl] : [];
        const supersetResult = compareParamSchemaSuperset(
          JSON.parse(paramSchemaJson) as readonly ParamSchemaEntry[],
          groupOneBgls,
          file.id,
        );
        if (!supersetResult.ok) {
          throw Object.assign(
            new Error(supersetResult.error.message),
            toRollupLog(supersetResult.error),
          );
        }
      }
      // bug-20260610: derive a synthetic identifier for non-material engine
      // entries (shadow_caster etc.) so the runtime variant-resolution path
      // can find them via materialShaderManifestEntries(). Material shaders
      // keep their reservedIdentifier; everything else gets
      // `forgeax::engine-<basename>`.
      const engineIdentifier =
        baseIdentifier !== file.id
          ? baseIdentifier
          : `forgeax::engine-${
              file.id
                .split('/')
                .pop()
                ?.replace(/\.wgsl$/, '') ?? 'unknown'
            }`;
      state.materialShaders.push({
        identifier: engineIdentifier,
        sourcePath: file.id,
        composedWgsl: defaultVariant.composedWgsl,
        paramSchema: paramSchemaJson,
        variants,
      });
    }
  }
}

// === Main factory ===================================================================

/**
 * Vite plugin factory — mounts 5 hooks (+ `buildStart` for engine-entries
 * eager compile) + ShaderError -> RollupLog wrap.
 *
 * Hook responsibilities (plan-strategy §S-6 + feat-20260518 M5 / w22.8):
 * | hook | responsibility |
 * |:--|:--|
 * | `buildStart()` | eager-compile `@forgeax/engine-shader/src/{pbr,unlit}.wgsl` (with `common.wgsl` + `brdf.wgsl` as naga_oil `#import` peers) into `state.entries`, so manifest.json always carries the engine entries even when no app `.wgsl` import triggers `transform` (M5 / w22.8: replaces inline `PBR_FALLBACK_WGSL`) |
 * | `load(id)` | `.wgsl` -> return null (let the default fs load run; transform takes over) |
 * | `transform(code, id)` | `.wgsl` -> call compileShader -> err takes this.error(toRollupLog(err)); ok emits files + injects the import.meta.hot.accept literal + returns a JS module |
 * | `generateBundle()` | prod-only: aggregate every entry cached during transform / buildStart -> emit triplet files + manifest.json |
 * | `handleHotUpdate(ctx)` | `.wgsl` -> return ctx.modules (default propagation; the client-side accept literal was already injected by transform) |
 * | `configureServer(server)` | dev-only: middleware serves the shader manifest from the same `state.entries` Map (II-A from plan-strategy §2 D-P2) |
 */
export function forgeaxShader(options: ForgeaXShaderOptions = {}): ForgeaXShaderPlugin {
  const state: ManifestEntries = {
    entries: new Map(),
    materialShaders: [],
    variantWgsl: new Map(),
  };
  const wantEngineEntries = options.engineEntries ?? true;
  let isServeMode = false;

  let engineShaderRoots: string[];
  try {
    engineShaderRoots = options.engineShaderRoots ?? [
      resolve(
        dirname(createRequire(import.meta.url).resolve('@forgeax/engine-shader/package.json')),
        'src',
      ),
    ];
  } catch {
    engineShaderRoots = [];
  }

  return {
    name: 'forgeax:shader',

    config(_cfg: unknown, env: { command: string }): void {
      if (env.command === 'serve') isServeMode = true;
    },

    // hook 0: buildStart — eager compile engine pbr.wgsl + unlit.wgsl
    // (feat-20260518-pbr-direct-lighting-mvp M5 / w22.8). Runs once per
    // build / dev cold-start; idempotent because state.entries is keyed by
    // absolute file path so a re-entry overwrites the same key. Throws if
    // compileShader rejects (charter P3 explicit failure: the engine
    // shaders are SSOT — a compile failure here is a real bug, not a soft
    // skip).
    async buildStart(this: MinimalPluginContext): Promise<void> {
      if (!wantEngineEntries) return;
      const eng = await loadEngineShaderEntries();
      // feat-20260523-shader-template-instance-split M5 / T09: pbr.wgsl is
      // retired; default-standard-pbr.wgsl is the engine PBR entry. The
      // runtime createRenderer.ts identifies the entry by `f_schlick`
      // content marker (unchanged); M6 host wiring calls
      // registry.registerMaterialShader('forgeax::default-standard-pbr', ...)
      // off the manifest entry + default-standard-pbr.schema.json sidecar.
      await compileEngineEntry(this, state, eng.defaultStandardPbr, eng.imports, isServeMode);
      // feat-20260523-skin-skeleton-animation M3 / T-34: pbr-skin entry compiled
      // at buildStart alongside default-standard-pbr; the composed WGSL is
      // surfaced in manifest.json for createRenderer to wire
      // registerDefaultStandardPbrSkin at engine boot.
      await compileEngineEntry(this, state, eng.defaultStandardPbrSkin, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.unlit, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.tonemap, eng.imports, isServeMode);
      // feat-20260520-directional-light-shadow-mapping: shadow_caster.wgsl
      // engine entry compiled at buildStart so the runtime
      // shadowCasterPipeline can pick up the composed module.
      await compileEngineEntry(this, state, eng.shadowCaster, eng.imports, isServeMode);
      // feat-20260520-2d-sprite-layer-mvp / M-3 / w20: 5th engine entry
      // for sprite alpha-blend pipeline; same #import peers as the other
      // three (AC-04 §2 + plan-strategy §3 SH1 + AC-19 derivation row 7).
      await compileEngineEntry(this, state, eng.sprite, eng.imports, isServeMode);
      // feat-20260531-world-space-msdf-text-rendering M5 / w21: world-space
      // MSDF text entry compiled at buildStart alongside the other material
      // entries; same #import forgeax_view::common peer. Runtime createRenderer
      // registers forgeax::msdf-text off the manifest materialShaders[] row.
      await compileEngineEntry(this, state, eng.msdfText, eng.imports, isServeMode);
      // M5-amend Gap A (feat-20260520-skylight-ibl-cubemap): also pre-compose
      // the 4 IBL precompute entries (equirect-to-cube / irradiance / prefilter
      // / brdf-lut). Each module ships its own cubemap_vs / fullscreen_vs +
      // fragment entry; naga_oil resolves the #import forgeax_pbr::ibl_shared
      // (+ ibl_sampling for prefilter / brdf-lut) chain. Runtime createRenderer
      // identifies them by entry-point marker (equirectToCube_fs /
      // irradianceConvolve_fs / prefilterEnv_fs / brdfLutBake_fs) and calls
      // setIblComposedShaders before IblPipelineCache.createIblPipelines runs.
      await compileEngineEntry(this, state, eng.iblEquirectToCube, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.iblIrradiance, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.iblPrefilter, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.iblBrdfLut, eng.imports, isServeMode);
      // feat-20260528-fxaa-post-processing / w6: FXAA fullscreen post-process
      // shader compiled at buildStart alongside the other engine entries.
      await compileEngineEntry(this, state, eng.fxaa, eng.imports, isServeMode);
      // feat-20260531-bloom-first-declarative-render-graph-pass / w9:
      // 3 bloom engine entries (bright / blur / composite) compiled at
      // buildStart alongside the other engine entries.
      await compileEngineEntry(this, state, eng.bloomBright, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.bloomBlur, eng.imports, isServeMode);
      await compileEngineEntry(this, state, eng.bloomComposite, eng.imports, isServeMode);
      // feat-20260531-skybox-env-background M3 / w14: skybox fullscreen
      // cubemap shader compiled at buildStart alongside tonemap/fxaa.
      await compileEngineEntry(this, state, eng.skybox, eng.imports, isServeMode);
    },

    // hook 0.5: resolveId -- claim the virtual:forgeax/bundler id (TASK-019 /
    // D-4 q7-A). Returning the same id (no `\0` prefix) keeps the load hook
    // input simple and matches the test's structural expectation (the prefix
    // form is also accepted by virtual-bundler.test.ts).
    resolveId(source: string): string | null {
      if (source === VIRTUAL_BUNDLER_ID) return VIRTUAL_BUNDLER_ID;
      return null;
    },

    // hook 1: load -- two responsibilities:
    //   (a) `.wgsl` -> return null so vite's default fs load runs (forwarded
    //       to the transform hook below);
    //   (b) `virtual:forgeax/bundler` -> return the adapter source string so
    //       vite registers a real module for `import { forgeaxBundlerAdapter }
    //       from 'virtual:forgeax/bundler'`. The adapter source is a constant
    //       (VIRTUAL_BUNDLER_SOURCE) closed over the plugin module's
    //       SHADER_MANIFEST_URL SSOT -- D-4 q7-A reverse-coupling guard means
    //       NO `@forgeax/engine-app` import inside this source.
    load(id: string): string | null {
      if (id === VIRTUAL_BUNDLER_ID) return VIRTUAL_BUNDLER_SOURCE;
      return null;
    },

    // hook 2: transform — `.wgsl` forwarded to compileShader
    async transform(this: MinimalPluginContext, code: string, id: string) {
      if (!id.endsWith('.wgsl')) return null;

      // Detect material-shader sidecar: *.wgsl.meta.json with
      // subAssets[].kind='material-shader' (AC-09 / plan-strategy D-ImportsMap).
      // In M2 (feat-20260528-material-shader-registration-unification), the
      // sidecar is also the paramSchema SSOT -- if a material-shader sidecar
      // is present, paramSchema MUST be declared there (requirements E4).
      let isMaterialShader = false;
      const metaPath = `${id}.meta.json`;
      let engineImports: Record<string, string> = {};
      let userParamSchema: Array<{ name: string; type: string }> = [];
      try {
        const metaRaw = await readFile(metaPath, 'utf8');
        let meta: unknown;
        try {
          meta = JSON.parse(metaRaw);
        } catch (e) {
          // Sidecar exists but JSON is malformed -> fail-fast with path (AC-17)
          throw Object.assign(
            new Error(`material-shader sidecar '${metaPath}' contains invalid JSON: ${String(e)}`),
            { code: 'PLUGIN_ERROR' },
          );
        }
        const metaObj = meta as Record<string, unknown> | null;
        if (metaObj == null || typeof metaObj !== 'object') {
          throw Object.assign(
            new Error(`material-shader sidecar '${metaPath}' is not a valid JSON object`),
            { code: 'PLUGIN_ERROR' },
          );
        }

        // Validate importer -- only the reserved 'shader' importer key gets
        // material-shader treatment (feat-20260603-asset-import-loader-injection
        // M2: the former assetType 'shader' became importer 'shader').
        const importer = metaObj.importer;
        if (importer !== 'shader') {
          // Sidecar exists but is not a shader sidecar -- skip the
          // material-shader path entirely (fall through to catch block)
          throw new Error('not a shader sidecar');
        }

        const subAssets: unknown = metaObj.subAssets;
        let sidecarHasMaterialShader = false;
        if (Array.isArray(subAssets)) {
          for (const sa of subAssets) {
            if (
              sa != null &&
              typeof sa === 'object' &&
              (sa as Record<string, unknown>).kind === 'material-shader'
            ) {
              sidecarHasMaterialShader = true;
              break;
            }
          }
        }

        if (sidecarHasMaterialShader) {
          // Sidecar is material-shader: paramSchema is required (E4)
          const paramSchema = metaObj.paramSchema;
          if (!Array.isArray(paramSchema) || paramSchema.length === 0) {
            throw Object.assign(
              new Error(
                `material-shader sidecar '${metaPath}' is missing required non-empty paramSchema array`,
              ),
              { code: 'PLUGIN_ERROR' },
            );
          }
          userParamSchema = paramSchema as Array<{ name: string; type: string }>;
          isMaterialShader = true;

          // AC-03: reject #define (boolean) directives in material-shader entries.
          // v1 assembly mechanism is #import + direct call only (plan-strategy
          // §3.6). #define directives found in the user's wgsl source are
          // rejected before compose with shader-define-conflict.
          const defineLines = scanDefineDirectives(code);
          if (defineLines.length > 0) {
            const firstDefine = defineLines[0] ?? '<unknown>';
            const err = new ShaderError({
              code: 'shader-define-conflict',
              expected:
                'material-shader entries disallow #define directives; use paramSchema+paramValues instead',
              message: `material-shader '${id}' contains #define directive: ${firstDefine}`,
              hint: 'remove the #define directive; v1 material-shader supports only #import + direct call assembly (AC-03). Use paramSchema+paramValues in the .pack.json payload for per-instance parameter injection.',
              detail: {
                code: 'shader-define-conflict',
                defineName: firstDefine,
                sites: [{ moduleId: id }],
              },
            });
            throw Object.assign(new Error(err.message), toRollupLog(err));
          }
          engineImports = loadEngineImportsMap(engineShaderRoots);
        }
      } catch (e: unknown) {
        if (e instanceof Error && 'code' in e && e.code === 'PLUGIN_ERROR') {
          // Re-throw fail-fast errors (bad JSON, missing paramSchema)
          throw e;
        }
        // Missing sidecar or non-shader sidecar -> fall through to existing behavior
      }

      // Collect sibling `#import` sources so `compileShader` can resolve
      // multi-segment moduleIds (e.g. `hello_triangle::view`) by reading
      // `<tail>.wgsl` siblings — matches the production file-naming
      // convention (`#define_import_path forgeax_view::common` lives in
      // `common.wgsl`; F-2 fix).  Missing sibling files (unit-mock paths,
      // orphan fixtures) are soft-skipped — `compileShader` still surfaces a
      // structured `shader-import-not-found` if the remaining map cannot
      // satisfy the directives.
      let imports: Record<string, string>;
      try {
        imports = await collectSiblingImports(code, id);
      } catch {
        imports = {};
      }

      // Merge engine imports for material-shader entries (engine imports
      // take priority in case of key collision — engine-shipped ShaderModules
      // are the canonical source).
      if (isMaterialShader) {
        imports = { ...imports, ...engineImports };
      }

      const r = await compileShader(stripPragmas(code), {
        id,
        imports,
        defines: { STORAGE_BUFFER_AVAILABLE: true, POINT_SHADOW_AVAILABLE: true },
      });
      if (!r.ok) {
        // bug-20260512-rolldown-this-error-wasm-crash: rolldown@1.0.0-rc.17
        // crashes with "WebAssembly.Table.grow(): failed to grow table by 4"
        // when this.error() is called from an async transform hook
        // (TransformPluginContextImpl.error goes through the native Rust WASM
        // binding and overflows the function table — known rolldown rc17 bug).
        // Throw directly instead: rolldown surfaces plugin-thrown errors
        // correctly without hitting the native binding path. The §S-7 hint
        // double-surface contract is preserved via Object.assign which merges
        // toRollupLog fields (hint / meta / loc) onto the plain Error instance.
        throw Object.assign(new Error(r.error.message), toRollupLog(r.error));
      }

      const { manifestEntry, bindings } = r.value;
      const hash = manifestEntry.hash;
      const bindingsJson =
        typeof manifestEntry.bindings === 'string'
          ? manifestEntry.bindings
          : JSON.stringify(manifestEntry.bindings);
      // feat-20260523-shader-template-instance-split M9-T05 (incidental fix):
      // store the post-naga_oil composed source from `manifestEntry.wgsl`,
      // not the raw `code` (which still carries #import directives the WGSL
      // tokenizer rejects). Engine entries already use this shape via
      // `compileEngineEntry` line 621; user-shader transform now matches
      // (charter P4 consistent abstraction across the two compile paths).
      state.entries.set(id, { hash, wgsl: manifestEntry.wgsl, bindings: bindingsJson });

      // T-16 / D-10: seed reverseDeps from this source's #import directives so
      // handleHotUpdate can fan out to the downstream Vite ModuleNodes when a
      // dep file is saved.
      updateReverseDeps(id, scanImportDirectives(code, id));

      // For material-shader entries, run schema-vs-BGL comparison after
      // successful compile (build-time fail-fast, plan-strategy D-OptionalBinding).
      // The schema is sourced from the sibling `.pack.json` payload's
      // paramSchema field; when no .pack.json sits next to the .wgsl the
      // schema check is skipped (M9-T05: deferred to runtime
      // registerMaterialShader, which validates paramValues against the
      // user-supplied paramSchema -- charter P3 explicit failure: bad
      // shape surfaces at register time, not silently). The bind-group
      // overflow gate (AC-07) still runs unconditionally.
      if (isMaterialShader) {
        const overflowResult = checkBindGroupOverflow(bindings, id);
        if (!overflowResult.ok) {
          throw Object.assign(
            new Error(overflowResult.error.message),
            toRollupLog(overflowResult.error),
          );
        }

        // Single-direction superset gate (feat-20260613-material-paramschema-
        // driven-binding M2 / w8 / D-9): the actually reflected BGL must
        // contain every binding emitted by derive(schema). Extra bindings on
        // the actual side are tolerated (engine-injection placeholders).
        // Failures emit material-shader-binding-mismatch with a synthesised
        // WGSL-author hint so the AI user can fix without trial-and-error.
        const supersetResult = compareParamSchemaSuperset(
          userParamSchema as readonly ParamSchemaEntry[],
          bindings,
          id,
        );
        if (!supersetResult.ok) {
          throw Object.assign(
            new Error(supersetResult.error.message),
            toRollupLog(supersetResult.error),
          );
        }

        // paramSchema sourced from sidecar (M2 feat-20260528-material-shader-
        // registration-unification). Runtime registerMaterialShader still
        // validates paramSchema vs paramValues at register-time.
        const paramSchema: Array<{ name: string; type: string }> = userParamSchema;
        // Push material-shader manifest entry (5-field mini schema).
        // composedWgsl is a path-only index -- the actual composed wgsl is
        // emitted as a sidecar file in generateBundle.
        const composedWgslPath = `./${hash}.composed.wgsl`;
        state.materialShaders.push({
          identifier: extractDefineImportPath(code) ?? hash,
          sourcePath: id,
          composedWgsl: composedWgslPath,
          paramSchema: JSON.stringify(paramSchema),
          variants: [],
        });
      }

      if (!isServeMode) {
        this.emitFile({
          type: 'asset',
          fileName: `shaders/${hash}.wgsl`,
          source: code,
        });
        this.emitFile({
          type: 'asset',
          fileName: `shaders/${hash}.glsl`,
          source: '',
        });
        this.emitFile({
          type: 'asset',
          fileName: `shaders/${hash}.bindings.json`,
          source: bindingsJson,
        });
      }

      // Return a JS module — injects the `import.meta.hot.accept(` literal
      // (research Finding 3 whitespace-sensitive HMR fallback hard constraint).
      // The default export `wgsl` field carries the post-naga_oil composed
      // source (manifestEntry.wgsl) so that consumers passing
      // `pulseShader.wgsl` directly into device.createShaderModule (e.g.
      // hello-custom-shader -> registerMaterialShader({ source })) receive a
      // tokenizer-valid WGSL string. Storing raw `code` here would re-feed
      // `#define_import_path` / `#import` directives into the GPU compiler
      // and produce `RhiError shader-compile-failed: invalid character found`
      // on every frame (matches the state.entries store on line 823).
      const moduleSource = [
        `// generated by @forgeax/engine-vite-plugin-shader`,
        `export default ${JSON.stringify({ hash, wgsl: manifestEntry.wgsl })};`,
        `export const reflection = ${JSON.stringify(bindings)};`,
        `if (import.meta.hot) { import.meta.hot.accept(() => {}); }`,
      ].join('\n');

      return { code: moduleSource, map: null };
    },

    // hook 3: generateBundle — prod-only manifest.json aggregation
    //
    // F3-fix (reviewer Round 1): schema shape aligned with
    // @forgeax/engine-types.ManifestEntry and interoperable with
    // @forgeax/engine-shader.ShaderRegistry.loadManifest.
    //
    // Old shape: `Record<absoluteFilePath, {hash, wgsl: relPath, glsl: relPath, bindings: relPath}>`
    //   - the key was an absolute path (with the worktree prefix) → reproducibility
    //     risk (paths differ across machines)
    //   - wgsl/glsl/bindings fields were relative paths instead of content → when
    //     ShaderRegistry.get(hash) called device.createShaderModule({code: entry.wgsl})
    //     it treated the path string as WGSL source → compilation failure
    //   - the overall schema was completely incompatible with the
    //     `{entries: ManifestEntry[]}` array expected by ShaderRegistry.loadManifest
    //
    // New shape: `{entries: ManifestEntry[]}` strictly aligned with @forgeax/engine-types.ManifestEntry:
    //   - entry.wgsl = WGSL source string content (consumed directly at runtime by device.createShaderModule)
    //   - entry.glsl = undefined (empty within M1 scope; non-WebGL fallback path)
    //   - entry.bindings = JSON.stringify(BindGroupLayoutDescriptor[]) (reflection-derived)
    //   - The triplet .wgsl / .glsl / .bindings.json files are still emitted by
    //     the transform hook (independent assets convenient for human debugging);
    //     the manifest no longer repeats path fields.
    generateBundle(this: MinimalPluginContext): void {
      const entries: Array<{
        readonly hash: string;
        readonly wgsl: string;
        readonly glsl: undefined;
        readonly bindings: string;
      }> = [];
      for (const [, entry] of state.entries) {
        entries.push({
          hash: entry.hash,
          wgsl: entry.wgsl,
          glsl: undefined,
          bindings: entry.bindings,
        });
      }
      // Emit composed wgsl sidecar for each material-shader entry + its variants
      for (const ms of state.materialShaders) {
        // Default variant
        const defaultEntry = state.entries.get(ms.sourcePath);
        if (defaultEntry !== undefined) {
          this.emitFile({
            type: 'asset',
            fileName: `shaders/${ms.composedWgsl.replace(/^\.?\//, '')}`,
            source: defaultEntry.wgsl,
          });
        }
        // Per-variant composed wgsl sidecars
        for (const v of ms.variants) {
          const variantKey = `${ms.sourcePath}#${v.definesKey}`;
          const variantWgslSource = state.variantWgsl.get(variantKey);
          if (variantWgslSource !== undefined) {
            this.emitFile({
              type: 'asset',
              fileName: `shaders/${v.composedWgsl.replace(/^\.?\//, '')}`,
              source: variantWgslSource,
            });
          }
        }
      }
      const manifestPayload: {
        readonly entries: typeof entries;
        readonly materialShaders: readonly MaterialShaderManifestEntry[];
      } = {
        entries,
        materialShaders: inlineMaterialShaderComposedWgsl(
          state.materialShaders,
          state.entries,
          state.variantWgsl,
        ),
      };
      this.emitFile({
        type: 'asset',
        fileName: SHADER_MANIFEST_PATH,
        source: JSON.stringify(manifestPayload, null, 2),
      });
    },

    // hook 4: handleHotUpdate — cross-file propagation (T-16, plan-strategy
    // §2 D-10). 5-line core: direct = ctx.modules; importers =
    // reverseDeps.get(ctx.file) ?? new Set(); downstream =
    // importers.flatMap(f => [...(ctx.server.moduleGraph.getModulesByFile(f)
    // ?? [])]); return [...direct, ...downstream].
    //
    // Transitive expansion: reverseDeps records direct edges only, but
    // nested chains (a -> b -> c) need every ancestor invalidated. We walk
    // reverseDeps from ctx.file via collectTransitiveImporters so `handleHotUpdate`
    // returns the full ancestor chain (research R-08: Vite's own propagation
    // handles the moduleGraph side; the plugin contributes the shader-import
    // edges).
    //
    // No manual module-invalidation call (plan-strategy D-10 note 3) — Vite
    // auto-recurses on the returned ModuleNode[] array.
    handleHotUpdate(ctx: HmrContextLike): ReadonlyArray<HmrModuleNodeLike> | undefined {
      if (!ctx.file.endsWith('.wgsl')) return undefined;

      const direct = ctx.modules;
      const importers = collectTransitiveImporters(ctx.file);
      if (importers.length === 0) return direct;

      const getModulesByFile = ctx.server?.moduleGraph.getModulesByFile;
      const downstream: HmrModuleNodeLike[] = [];
      if (getModulesByFile !== undefined) {
        for (const importer of importers) {
          const nodes = getModulesByFile(importer) ?? new Set<HmrModuleNodeLike>();
          for (const node of nodes) downstream.push(node);
        }
      }

      // Dev log: list the downstream file names explicitly so AI users see
      // which modules HMR invalidated (plan-strategy D-10 note + AC-18.b
      // charter proposition 4 explicit failure: a silent propagation is
      // indistinguishable from a missing one).
      const downstreamFiles = downstream
        .map((m) => m.file ?? '<unknown>')
        .filter((f): f is string => typeof f === 'string');
      console.warn('[forgeax-shader] HMR invalidate downstream:', downstreamFiles);

      return [...direct, ...downstream];
    },

    // hook 5: configureServer — dev-only manifest middleware (D-P2 / II-A)
    //
    // Why this hook exists (research §F-V1 / §F-V2 / §F-V3):
    // - generateBundle is strict prod-only (Vite/Rollup contract); during dev
    //   the example app fetches the shader manifest over HTTP, but no one
    //   has emitted that asset, so the dev server falls back to SPA index.html
    //   which fails JSON parse → ShaderRegistry rejects with manifest-malformed.
    // - transform is also 0-shot in dev unless something imports the .wgsl;
    //   the example main.ts intentionally does NOT import the .wgsl directly
    //   (architecture principle #4 pipeline isolation), so state.entries stays
    //   empty.
    // - configureServer runs only when Vite is in `serve` mode (Vite docs
    //   "configureServer is not called when running the production build").
    //
    // Behavior contract:
    // - Register exactly one middleware on server.middlewares.use().
    // - Filter req.url matches the manifest path; on miss call next() with no
    //   header / body mutation.
    // - On hit, lazy-prime: when state.entries is empty, enumerate the wgsl
    //   ids declared in vite.config.ts.build.rollupOptions.input (filter by
    //   .wgsl suffix) and `await server.transformRequest(id)` for each. The
    //   transform hook closure populates state.entries as a side effect (same
    //   Map prod uses; HMR refresh stays free via hook 4).
    // - Aggregate state.entries into the shape
    //     { schemaVersion: '1.0.0', entries: ManifestEntry[] }
    //   matching @forgeax/engine-types.ManifestEntry (II-4 schema equivalence; the
    //   schemaVersion key is forward-compatible — ShaderRegistry.loadManifest
    //   only validates the entries array).
    // - Errors PROPAGATE: transformRequest throwing surfaces out of the
    //   middleware (Vite's connect runner converts to a 5xx error response);
    //   no try/catch wraps the prime loop. This preserves charter proposition
    //   4 fail-fast — the user sees a structured ShaderError rather than an
    //   empty manifest (II-5).
    configureServer(server: ViteDevServerLike): void {
      const manifestUrl = `/${SHADER_MANIFEST_PATH}`;
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== manifestUrl) {
          next();
          return;
        }

        if (state.entries.size === 0) {
          for (const wgslId of resolveWgslEntries(server)) {
            // Errors surface out of the await — no silent try/catch (II-5).
            await server.transformRequest(wgslId);
          }
        }

        const entries: Array<{
          readonly hash: string;
          readonly wgsl: string;
          readonly glsl: undefined;
          readonly bindings: string;
        }> = [];
        for (const [, entry] of state.entries) {
          entries.push({
            hash: entry.hash,
            wgsl: entry.wgsl,
            glsl: undefined,
            bindings: entry.bindings,
          });
        }
        const payload = {
          schemaVersion: '1.0.0',
          entries,
          materialShaders: inlineMaterialShaderComposedWgsl(
            state.materialShaders,
            state.entries,
            state.variantWgsl,
          ),
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload, null, 2));
      });
    },
  };
}

// === Helper ====================================================================

/**
 * Enumerate the .wgsl entry ids the dev server should prime via
 * `server.transformRequest`. Source order:
 * 1. config.build.rollupOptions.input (object form: pick string values ending in .wgsl)
 * 2. config.build.rollupOptions.input (array form: pick array entries ending in .wgsl)
 * 3. config.build.rollupOptions.input (string form: only used if it ends in .wgsl)
 *
 * Returns an empty array on absent config — that yields an empty manifest body
 * (`{schemaVersion: '1.0.0', entries: []}`) which is still valid against
 * ShaderRegistry.loadManifest (charter proposition 4: explicit failure means
 * the example surfaces a downstream `shader-not-found` rather than the
 * misleading `manifest-malformed`).
 */
function resolveWgslEntries(server: ViteDevServerLike): readonly string[] {
  const input = server.config?.build?.rollupOptions?.input;
  if (input === undefined) return [];
  if (typeof input === 'string') {
    return input.endsWith('.wgsl') ? [input] : [];
  }
  if (Array.isArray(input)) {
    return input.filter((id): id is string => typeof id === 'string' && id.endsWith('.wgsl'));
  }
  // Object form: pick values ending in .wgsl. The `input` key may be the
  // hello-triangle "main" entry (index.html) which we ignore.
  const values = Object.values(input as Record<string, string>);
  return values.filter((id) => typeof id === 'string' && id.endsWith('.wgsl'));
}

/** Package version string (debug tag). */
export const VITE_PLUGIN_SHADER_PACKAGE_VERSION = '0.0.0';
