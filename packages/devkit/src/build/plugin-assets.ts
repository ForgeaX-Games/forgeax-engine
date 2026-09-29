import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pluginAssetOutputProducer, resolvePluginProgram } from '@forgeax/engine-import';
import { type ScanInventory, scanInventory } from '@forgeax/engine-pack/scanner';
import {
  type AnyScriptablePackDefinition,
  AssetGuid,
  PackageId,
  type PackBuildReadContext,
  type PackOutputMap,
  type PluginAssetSource,
  parsePackSourceJson,
  projectDirectPackJson,
  resolvePackParameterValues,
  validatePluginAssetSource,
} from '@forgeax/engine-pack/source';
import { inventoryScriptablePackSource } from '@forgeax/engine-pack/source-node';
import { err, type PluginAsset, type PluginAssetDefinition } from '@forgeax/engine-types';
import type { ProjectFacts } from '../types.js';

export interface PluginSourceRecord {
  readonly definition: PluginAssetDefinition;
  readonly source: PluginAssetSource;
  readonly sourcePath: string;
  readonly sourceKey: string;
  readonly refs: readonly string[];
  readonly module: string;
  readonly export: string;
}

export interface PluginSourceInventory {
  readonly assets: ReadonlyMap<string, PluginSourceRecord>;
  readonly deferred: readonly string[];
  readonly sourceInputs: Map<string, string>;
}

export function isPluginAssetSourceIgnoredPath(root: string, path: string): boolean {
  return relative(root, path)
    .split(sep)
    .some((part) => part === 'node_modules' || part === '.forgeax');
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function failure(path: string, reason: unknown): never {
  throw {
    code: 'plugin-bootstrap-failed',
    expected: 'deterministic plugin definitions discoverable without cooked reads',
    hint: 'repair the source or move build-root definitions to a self-contained Pack',
    detail: { sourcePath: path, cause: reason },
  };
}

/** Add declared local programs to the existing fence without rebasing any frozen input. */
export async function capturePluginProgramInputs(
  projectRoot: string,
  sourceInputs: Map<string, string>,
  module: string,
  resolveModule?: (specifier: string, importer: string) => Promise<string | undefined>,
): Promise<void> {
  const root = await realpath(projectRoot);
  const resolveLocal = async (importer: string, specifier: string) => {
    const resolved = resolveModule ? await resolveModule(specifier, importer) : specifier;
    if (!resolved || !isAbsolute(resolved)) return undefined;
    let path: string;
    try {
      path = await realpath(resolved.split('?')[0] ?? resolved);
    } catch (cause) {
      // A .js declaration can resolve to authored .ts; discovery does not
      // choose the compiler's extension or condition rules.
      if (!resolveModule && (cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
    if (!resolveModule && !(await stat(path)).isFile()) return undefined;
    const local = relative(root, path);
    if (
      local.startsWith(`..${sep}`) ||
      local === '..' ||
      isAbsolute(local) ||
      isPluginAssetSourceIgnoredPath(root, path)
    )
      return undefined;
    return path;
  };
  const entry = await resolveLocal(resolve(root, 'package.json'), module);
  if (!entry) return;
  // Discovery freezes known files. The actual compiler/contract loader supplies
  // its resolver before consuming the closure; no second build configuration exists.
  for (const input of await inventoryScriptablePackSource(
    entry,
    undefined,
    resolveModule ? resolveLocal : async () => undefined,
  ))
    await capturePluginSourceInput(sourceInputs, input.path, input.digest);
}

async function capturePluginSourceInput(
  inputs: Map<string, string>,
  path: string,
  revision: string,
): Promise<void> {
  path = await realpath(path);
  const previous = inputs.get(path);
  if (previous !== undefined && previous !== revision)
    failure(path, {
      reason: 'source changed during plugin compilation',
      expected: previous,
      actual: revision,
    });
  inputs.set(path, revision);
}

/** Runs source declarations only. Project plugins, Cookers and executors are never installed. */
export async function discoverPluginAssets(
  facts: Pick<ProjectFacts, 'root' | 'assetRoots'>,
  scannedInventory?: ScanInventory,
): Promise<PluginSourceInventory> {
  let inventory = scannedInventory;
  if (!inventory) {
    const scanned = await scanInventory(
      facts.assetRoots.map((root) => resolve(facts.root, root)),
      {
        ignorePath: (path) => isPluginAssetSourceIgnoredPath(facts.root, path),
      },
    );
    if (!scanned.ok) throw scanned.error;
    inventory = scanned.value;
  }
  const assets = new Map<string, PluginSourceRecord>();
  const sourceInputs = new Map<string, string>();
  await capturePluginSourceInputs(facts.root, sourceInputs);
  const deferred: string[] = [];
  const sourceDeclarations = inventory.declarations;
  const declarations = [...sourceDeclarations.values()];

  async function add(
    sourcePath: string,
    revision: string,
    packageId: PackageId,
    outputs: PackOutputMap,
  ): Promise<void> {
    for (const [sourceKey, output] of Object.entries(outputs)) {
      if (output.kind !== 'plugin') continue;
      const declaration = sourceDeclarations.get(sourcePath);
      await capturePluginSourceInput(
        sourceInputs,
        sourcePath,
        declaration?.sourceRevision ?? revision,
      );
      if (declaration?.format === 'pack.ts')
        for (const input of declaration.sourceClosure)
          await capturePluginSourceInput(sourceInputs, input.path, input.digest);
      const source = validatePluginAssetSource(output);
      if (!source.ok) failure(sourcePath, source.error);
      const guid = AssetGuid.format(AssetGuid.derive(packageId, sourceKey));
      if (assets.has(guid)) failure(sourcePath, `duplicate plugin GUID ${guid}`);
      const resolved = resolvePluginProgram(sourcePath, source.value.module, facts.root);
      await capturePluginProgramInputs(facts.root, sourceInputs, resolved.module);
      const contract = source.value.toolContract;
      if (contract && 'specifier' in contract)
        await capturePluginProgramInputs(
          facts.root,
          sourceInputs,
          contract.specifier.startsWith('.')
            ? resolve(dirname(sourcePath), contract.specifier)
            : contract.specifier,
        );
      const cooked = await pluginAssetOutputProducer.produce({
        guid,
        sourceKey,
        asset: source.value,
        sourcePath,
        projectRoot: facts.root,
      });
      if (!cooked.ok) failure(sourcePath, cooked.error);
      const asset = cooked.value.payload as PluginAsset;
      assets.set(guid, {
        definition: { guid, asset, evidence: { kind: 'source', revision, digest: digest(asset) } },
        source: source.value,
        sourcePath,
        sourceKey,
        refs: cooked.value.refs.map((ref) => ref.guid),
        module: resolved.module,
        export: resolved.export,
      });
    }
  }

  async function evaluate(
    sourcePath: string,
    revision: string,
    definition: AnyScriptablePackDefinition,
    packageId = definition.packageId,
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    let blocked = false;
    const context: PackBuildReadContext & { packageId: PackageId } = {
      packageId,
      async readByGuid(guid) {
        blocked = true;
        return err({
          code: 'plugin-bootstrap-read-blocked',
          expected: 'source-only bootstrap inputs',
          hint: 'defer this Pack to normal cooking',
          detail: { guid: AssetGuid.format(guid) },
        });
      },
    };
    const result =
      'parameters' in definition
        ? await definition.build({
            ...context,
            values: resolvePackParameterValues(definition, overrides).unwrap(),
          })
        : await definition.build(context);
    if (blocked) {
      deferred.push(relative(facts.root, sourcePath));
      return;
    }
    if (!result.ok) failure(sourcePath, result.error);
    await add(sourcePath, revision, packageId, result.value);
  }

  for (const declaration of declarations) {
    if (declaration.format === 'pack.ts') {
      await evaluate(declaration.sourcePath, declaration.sourceRevision, declaration.definition);
    } else if (declaration.format === 'pack.json' && declaration.value.schemaVersion === '3.0.0') {
      const parsed = parsePackSourceJson(declaration.value);
      if (!parsed.ok) failure(declaration.sourcePath, parsed.error);
      if (parsed.value.format !== 'direct') continue;
      const projected = projectDirectPackJson(parsed.value).unwrap();
      const outputs = Object.fromEntries(
        projected.assets.map((asset) => [asset.sourceKey, { ...asset.payload, kind: asset.kind }]),
      ) as PackOutputMap;
      await add(
        declaration.sourcePath,
        declaration.sourceRevision,
        parsed.value.packageId,
        outputs,
      );
    }
  }
  // Instances must execute the original declaring module; moving an instance does not rebase imports.
  const byPackage = new Map<string, (typeof declarations)[number]>();
  for (const declaration of declarations) {
    if (declaration.format === 'pack.ts') {
      byPackage.set(PackageId.format(declaration.definition.packageId), declaration);
    } else if (declaration.format === 'pack.json' && declaration.value.schemaVersion === '3.0.0') {
      byPackage.set(
        PackageId.format(parsePackSourceJson(declaration.value).unwrap().packageId),
        declaration,
      );
    }
  }
  for (const declaration of declarations) {
    if (declaration.format !== 'pack.json' || declaration.value.schemaVersion !== '3.0.0') continue;
    const parsed = parsePackSourceJson(declaration.value).unwrap();
    if (parsed.format !== 'instance') continue;
    await capturePluginSourceInput(
      sourceInputs,
      declaration.sourcePath,
      declaration.sourceRevision,
    );
    const visited = new Set<string>();
    let parentId = PackageId.format(parsed.parent);
    let values = { ...parsed.values };
    for (;;) {
      if (visited.has(parentId)) failure(declaration.sourcePath, 'Pack instance cycle');
      visited.add(parentId);
      const parent = byPackage.get(parentId);
      if (!parent) failure(declaration.sourcePath, `missing parent ${parentId}`);
      if (parent.format === 'pack.ts') {
        // Each isolated executor is single-use; reload an instance's original module.
        const { loadScriptablePack } = await import('@forgeax/engine-pack/source-node');
        const definition = (await loadScriptablePack(parent.sourcePath)).unwrap();
        await evaluate(
          parent.sourcePath,
          digest([declaration.sourceRevision, parent.sourceRevision]),
          definition,
          parsed.packageId,
          values,
        );
        break;
      }
      if (parent.format !== 'pack.json') failure(declaration.sourcePath, 'invalid instance parent');
      const next = parsePackSourceJson(parent.value).unwrap();
      if (next.format !== 'instance')
        failure(declaration.sourcePath, 'instance parent must be a parameterized source');
      values = { ...next.values, ...values };
      parentId = PackageId.format(next.parent);
    }
  }
  return { assets, sourceInputs, deferred: [...new Set(deferred)].sort() };
}

export function pluginAssetClosure(
  inventory: PluginSourceInventory,
  root: string | undefined,
): readonly PluginSourceRecord[] {
  if (!root) return [];
  const result = new Map<string, PluginSourceRecord>();
  const queue = [root];
  for (const guid of queue) {
    if (result.has(guid)) continue;
    const record = inventory.assets.get(guid);
    if (!record) failure(guid, { missingPlugin: guid, deferredSources: inventory.deferred });
    result.set(guid, record);
    for (const ref of record.refs) if (inventory.assets.has(ref)) queue.push(ref);
  }
  return [...result.values()];
}

/** Merge the final producer projection, rejecting bootstrap definitions that changed while cooking. */
export async function publishedPluginInventory(
  projectRoot: string,
  bootstrap: PluginSourceInventory,
  pack: Pick<import('@forgeax/engine-vite-plugin-pack').PluginPack, 'readPluginDefinitions'>,
): Promise<PluginSourceInventory> {
  await assertPluginSourceInputs(bootstrap, projectRoot);
  const assets = new Map(bootstrap.assets);
  const published = await pack.readPluginDefinitions();
  for (const item of published) {
    const previous = bootstrap.assets.get(item.definition.guid);
    if (previous && digest(previous.definition.asset) !== digest(item.definition.asset)) {
      failure(
        previous.sourcePath,
        'plugin definition changed between bootstrap and ordinary cooking',
      );
    }
    const program = item.definition.asset.program;
    const split = program.lastIndexOf('#');
    const locator = program.slice(0, split);
    const name = decodeURIComponent(program.slice(split + 1));
    const module = locator.startsWith('project:')
      ? resolve(projectRoot, locator.slice(8))
      : locator.slice(4);
    if ((!locator.startsWith('project:') && !locator.startsWith('npm:')) || split < 0)
      failure(item.sourcePath, 'invalid program locator');
    await capturePluginProgramInputs(projectRoot, bootstrap.sourceInputs, module);
    assets.set(
      item.definition.guid,
      previous
        ? { ...previous, definition: item.definition }
        : {
            ...item,
            sourceKey: item.definition.guid,
            module,
            export: name,
            source: { kind: 'plugin', module: { specifier: module, export: name } },
          },
    );
  }
  return { assets, sourceInputs: bootstrap.sourceInputs, deferred: [] };
}

/** Publication must use the exact authored definitions used to bootstrap this session. */
export async function assertPluginSourceInputs(
  inventory: PluginSourceInventory,
  projectRoot: string,
): Promise<void> {
  const current = new Map<string, string>();
  await capturePluginSourceInputs(await realpath(projectRoot), current);
  const expectedInputs = new Map(
    await Promise.all(
      [...inventory.sourceInputs].map(
        async ([path, revision]) => [await realpath(path), revision] as const,
      ),
    ),
  );
  for (const path of current.keys())
    if (!expectedInputs.has(path))
      failure(path, { reason: 'source added during plugin compilation' });
  for (const [path, expected] of expectedInputs) {
    const actual = `sha256:${createHash('sha256')
      .update(await readFile(path))
      .digest('hex')}`;
    if (actual !== expected)
      failure(path, { reason: 'source changed during plugin compilation', expected, actual });
  }
}

/** Fence project code and dependency authority before any compiler consumes it. */
async function capturePluginSourceInputs(root: string, inputs: Map<string, string>): Promise<void> {
  const ignored = new Set([
    'node_modules',
    '.git',
    '.forgeax',
    '.assetlib',
    '.worktrees',
    'dist',
    'coverage',
    '__tests__',
    '.forgeax-harness',
  ]);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        /(?:\.[cm]?[jt]sx?|\.json|lock\.yaml|bun\.lock)$/.test(entry.name)
      ) {
        await capturePluginSourceInput(
          inputs,
          path,
          `sha256:${createHash('sha256')
            .update(await readFile(path))
            .digest('hex')}`,
        );
      }
    }
  }
  await visit(root);
}
