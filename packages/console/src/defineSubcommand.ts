// @forgeax/engine-console/src/defineSubcommand - sade utils.js form (~94-line
// flat-dictionary + section primitive) DSL for the `forgeax-engine-console`
// CLI help renderer. Plan-strategy D-4 + D-7 lock-in:
//
//   - Single file, package-internal (NOT in package.json#exports).
//     `cli.ts` is the sole consumer; tsup inlines it into dist/cli.mjs.
//   - 94-line ceiling is a pattern target, not a hard cap; we trade a few
//     extra lines for explicit JSDoc that AI users read at edit time.
//   - Three render layers driven by `path` slicing:
//       path = []                       -> top-level help
//       path = ['inspect']              -> subcommand help
//       path = ['inspect', 'entities']  -> sub-target help
//   - List-width pin: `maxLen + GAP=4` padding (R-4 mitigation; snapshot
//     test packages/console/src/__tests__/cli-help.test.ts guards drift).
//
// charter: proposition 1 (progressive disclosure — `path` is the navigator,
// not a hidden config) + proposition 3 (machine-readable spec >>> hand-rolled
// strings) + proposition 4 (explicit failure — render is total: any unknown
// path returns the closest valid layer rather than throwing).

const GAP = 4;

/** Single option entry: `--with <Name>`, `--port <number>` ... */
export interface OptionSpec {
  readonly flag: string;
  readonly description: string;
  readonly multiple?: boolean;
  readonly defaultValue?: string;
}

/** Single example block: usage line + free description. */
export interface ExampleSpec {
  readonly usage: string;
  readonly description?: string;
}

/** Subcommand spec — recursive (subcommands map to nested specs). */
export interface SubcommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options?: ReadonlyArray<OptionSpec>;
  readonly subcommands?: ReadonlyArray<SubcommandSpec>;
  readonly examples?: ReadonlyArray<ExampleSpec>;
  readonly extraNotes?: ReadonlyArray<string>;
}

/**
 * Single-input wrapping helper: turns a sade-style descriptor into a
 * SubcommandSpec POD. Today the function is a near-identity (the spec is
 * already structurally a POD), but the wrapper preserves a single intercept
 * point for future validation (charter proposition 4: explicit failure on
 * malformed input — we can throw here rather than silently render garbage).
 */
export function defineSubcommand(spec: SubcommandSpec): SubcommandSpec {
  if (typeof spec.name !== 'string' || spec.name.length === 0) {
    throw new Error('defineSubcommand: spec.name must be a non-empty string');
  }
  return spec;
}

/**
 * Look up the descendant spec at `path`. Returns the closest matching
 * ancestor when the path is partially unknown so renderHelp degrades to the
 * deepest valid layer rather than throwing (charter proposition 4 explicit
 * failure: a wrong path is recoverable; a thrown render is not).
 */
function resolvePath(
  root: SubcommandSpec,
  path: readonly string[],
): { readonly spec: SubcommandSpec; readonly path: readonly string[] } {
  let current = root;
  const consumed: string[] = [];
  for (const segment of path) {
    const next = current.subcommands?.find((s) => s.name === segment);
    if (next === undefined) break;
    current = next;
    consumed.push(segment);
  }
  return { spec: current, path: consumed };
}

/**
 * Render a single section with `key` left-padded to `maxLen + GAP` columns.
 * `items` carries `[label, body]` pairs; both halves are flat strings.
 *
 * Skips emission entirely when `items` is empty so the rendered help body
 * has no orphan section headers (UX nit: AI users grep section headers as
 * anchors — emitting a header followed by nothing fools the grep).
 */
function section(title: string, items: ReadonlyArray<readonly [string, string]>): string[] {
  if (items.length === 0) return [];
  let maxLen = 0;
  for (const [label] of items) {
    if (label.length > maxLen) maxLen = label.length;
  }
  const lines: string[] = [];
  lines.push(`${title}:`);
  for (const [label, body] of items) {
    const pad = ' '.repeat(maxLen + GAP - label.length);
    lines.push(`  ${label}${pad}${body}`);
  }
  lines.push('');
  return lines;
}

/**
 * Render the help body for `path` against `root`. Always returns a non-empty
 * string ending in a single newline so callers can pipe to stdout without
 * post-processing.
 *
 * Layer 1 (root):       title + Usage + Sub-commands + Options + extraNotes
 * Layer 2 (subcommand): title + Usage + Sub-targets (if any) + Options + Examples + extraNotes
 * Layer 3 (sub-target): title + Usage + Options + Examples + extraNotes
 */
export function renderHelp(root: SubcommandSpec, path: readonly string[]): string {
  const { spec, path: consumed } = resolvePath(root, path);
  const fullPath = [root.name, ...consumed].join(' ');
  const out: string[] = [];
  out.push(`${fullPath} - ${spec.description}`);
  out.push('');

  // Usage line — synthesised from `path` + the leaf's surface.
  const usagePieces: string[] = [fullPath];
  if (spec.subcommands && spec.subcommands.length > 0) {
    usagePieces.push('<subcommand>');
  } else {
    // Leaf nodes use a generic <args> token; concrete shape lives in
    // `examples` so the help body stays declarative rather than guessed.
    usagePieces.push('[options]');
  }
  out.push('Usage:');
  out.push(`  ${usagePieces.join(' ')}`);
  out.push('');

  if (spec.subcommands && spec.subcommands.length > 0) {
    out.push(
      ...section(
        consumed.length === 0 ? 'Sub-commands' : 'Sub-targets',
        spec.subcommands.map((s) => [s.name, s.description] as const),
      ),
    );
  }

  if (spec.options && spec.options.length > 0) {
    out.push(
      ...section(
        'Options',
        spec.options.map((o) => [o.flag, o.description] as const),
      ),
    );
  }

  if (spec.examples && spec.examples.length > 0) {
    const exampleItems: Array<readonly [string, string]> = spec.examples.map(
      (e) => [e.usage, e.description ?? ''] as const,
    );
    out.push(...section('Examples', exampleItems));
  }

  if (spec.extraNotes && spec.extraNotes.length > 0) {
    out.push('Notes:');
    for (const note of spec.extraNotes) {
      out.push(`  ${note}`);
    }
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}
