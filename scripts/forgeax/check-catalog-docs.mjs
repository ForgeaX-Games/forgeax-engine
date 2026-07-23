import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const engineRoot = process.cwd();
const editorRootArg = process.argv.indexOf('--editor-root');
const editorRoot = editorRootArg < 0 ? undefined : process.argv[editorRootArg + 1];

if (editorRootArg >= 0 && editorRoot === undefined) {
  console.error(
    'usage: node scripts/forgeax/check-catalog-docs.mjs [--editor-root /absolute/path/to/forgeax-editor]',
  );
  process.exit(2);
}

const engineDocuments = [
  [
    'packages/assets-runtime/README.md',
    [
      'CatalogSource',
      'subscribe before enumerating',
      'added',
      'changed',
      'removed',
      'catalog-source-unconfigured',
      'static source',
    ],
  ],
  [
    'packages/vite-plugin-pack/README.md',
    ['forgeax:catalog-delta', 'reloadAssetHost()', 'source-only', 'static build'],
  ],
  [
    'skills/forgeax-engine-assets/SKILL.md',
    [
      'CatalogSource',
      'CatalogDelta',
      'subscribeCatalog',
      'enumerateCatalog',
      'reloadAssetHost()',
      'editor pinned consumer',
    ],
  ],
];

const editorDocuments = [
  ['packages/core/README.md', ['CatalogDelta', 'subscribe to', 'enumerate', 'GUID', 'pinned']],
  [
    'packages/content-browser/README.md',
    ['CatalogDelta', 'subscribe first', 'GUID', 'reload policy'],
  ],
  [
    'packages/edit-runtime/README.md',
    ['CatalogSource', 'CatalogDelta', 'subscribe before enumerating', 'submodule pin'],
  ],
];

async function checkDocuments(root, documents, label) {
  const failures = [];
  for (const [relativePath, required] of documents) {
    const absolutePath = resolve(root, relativePath);
    let source;
    try {
      source = await readFile(absolutePath, 'utf8');
    } catch (error) {
      failures.push(
        `${label}/${relativePath}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    for (const token of required) {
      if (!source.includes(token))
        failures.push(`${label}/${relativePath}: add catalog guidance ${JSON.stringify(token)}`);
    }
  }
  return failures;
}

const failures = await checkDocuments(engineRoot, engineDocuments, 'engine');
for (const [relativePath, term] of [
  ['packages/assets-runtime/README.md', 'forgeax:asset-changed'],
  ['packages/vite-plugin-pack/README.md', 'forgeax:asset-changed'],
  ['skills/forgeax-engine-assets/SKILL.md', 'suppressFullReload'],
]) {
  const source = await readFile(resolve(engineRoot, relativePath), 'utf8');
  if (source.includes(term))
    failures.push(`engine/${relativePath}: remove retired public term ${JSON.stringify(term)}`);
}

if (editorRoot !== undefined) {
  try {
    await access(editorRoot);
    failures.push(...(await checkDocuments(editorRoot, editorDocuments, 'editor')));
  } catch {
    failures.push(
      `editor: cannot access ${editorRoot}; pass the checked-out forgeax-editor worktree to --editor-root`,
    );
  }
}

if (failures.length > 0) {
  console.error('catalog documentation exit sweep failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `catalog documentation exit sweep passed (${editorRoot === undefined ? 'engine docs' : 'engine + editor docs'})`,
  );
}
