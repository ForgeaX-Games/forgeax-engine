#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Project, ts } from 'ts-morph';

const root = process.env.FORGEAX_ROOT ?? process.cwd();
const packagesRoot = path.join(root, 'packages');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(entryPath));
    else result.push(entryPath);
  }
  return result;
}

function packageRecords() {
  const records = new Map();
  for (const file of walk(packagesRoot).filter((entry) => entry.endsWith('package.json'))) {
    const dir = path.dirname(file);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest.name?.startsWith('@forgeax/engine-')) continue;
    records.set(manifest.name, {
      dir,
      index: path.join(dir, 'src/index.ts'),
      exports: new Set(Object.keys(manifest.exports ?? { '.': true })),
    });
  }
  return records;
}

const packages = packageRecords();
const paths = {};
for (const [name, record] of packages) {
  paths[name] = [record.index];
  paths[`${name}/*`] = [path.join(record.dir, 'src/*')];
}

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    baseUrl: root,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths,
    target: ts.ScriptTarget.ESNext,
  },
});

for (const record of packages.values()) {
  if (fs.existsSync(record.index)) project.addSourceFileAtPath(record.index);
}

const exportCache = new Map();
function publicExports(packageName) {
  if (exportCache.has(packageName)) return exportCache.get(packageName);
  const record = packages.get(packageName);
  if (record === undefined) return new Set();
  const sourceFile =
    project.getSourceFile(record.index) ?? project.addSourceFileAtPath(record.index);
  const names = new Set(sourceFile.getExportSymbols().map((symbol) => symbol.getName()));
  exportCache.set(packageName, names);
  return names;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function regionsFor(file, source) {
  if (file.endsWith('.md')) {
    return [...source.matchAll(/```[\s\S]*?```/g)].map((match) => ({
      offset: match.index,
      text: match[0],
    }));
  }
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(file)) {
    return [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((match) => ({
      offset: match.index,
      text: match[0],
    }));
  }
  return [];
}

function namesFromList(list) {
  return list
    .split(',')
    .map((entry) => entry.replace(/^\s*\*\s?/, '').trim())
    .map((entry) => entry.replace(/^type\s+/, '').trim())
    .map((entry) => entry.split(/\s+as\s+/)[0].trim())
    .filter((entry) => entry && entry !== '*' && !entry.startsWith('...'));
}

function packageAndSubpath(specifier) {
  const match = specifier.match(/^(@forgeax\/engine-[^/]+)(\/.*)?$/);
  if (match === null) return undefined;
  return {
    packageName: match[1],
    subpath: match[2] === undefined ? '.' : `.${match[2]}`,
  };
}

function hasPublicSubpath(record, subpath) {
  if (subpath === '.') return record.exports.has('.') || record.exports.size === 0;
  if (record.exports.has(subpath)) return true;
  return [...record.exports].some(
    (entry) => entry.endsWith('/*') && subpath.startsWith(entry.slice(0, -1)),
  );
}

const findings = [];
const scanFiles = walk(path.join(root, 'packages')).concat(walk(path.join(root, 'apps')));

for (const file of scanFiles) {
  if (file.endsWith('CHANGELOG.md')) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const region of regionsFor(file, source)) {
    for (const match of region.text.matchAll(
      /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g,
    )) {
      const lineStart = region.text.lastIndexOf('\n', match.index) + 1;
      const linePrefix = region.text.slice(lineStart, match.index).trimStart();
      if (linePrefix.startsWith('-') || linePrefix.startsWith('+')) continue;
      const target = packageAndSubpath(match[2]);
      if (target === undefined) continue;
      const record = packages.get(target.packageName);
      const location = `${path.relative(root, file)}:${lineAt(source, region.offset + match.index)}`;
      if (record === undefined) {
        findings.push(`${location}: package ${target.packageName} does not exist in packages/`);
        continue;
      }
      if (!hasPublicSubpath(record, target.subpath)) {
        findings.push(
          `${location}: public subpath ${match[2]} is not declared by ${target.packageName}`,
        );
        continue;
      }
      if (target.subpath !== '.') continue;
      const exports = publicExports(target.packageName);
      for (const name of namesFromList(match[1])) {
        if (!exports.has(name)) {
          findings.push(`${location}: ${name} is not exported by ${target.packageName}`);
        }
      }
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`[public-import-examples] ${finding}`);
  console.error(`[public-import-examples] ${findings.length} finding(s)`);
  process.exitCode = 1;
} else {
  console.log('[public-import-examples] OK');
}
