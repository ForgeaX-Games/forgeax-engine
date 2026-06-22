/**
 * jscodeshift transform: rename @forgeax/<old> → @forgeax/engine-<new> across
 * every import-like source-string syntax in TS / TSX / JS / JSX / MTS / CTS /
 * MJS / CJS files. AST literal-equality (no regex on the source value) — this
 * is the layer-1 defence against bare-@forgeax/engine substring corruption
 * described in plan-strategy §2 "@forgeax/engine substring R-3".
 *
 * Input: --map <abs-or-rel-path> (defaults to scripts/codemod/rename-map.json).
 * Output: in-place edits via jscodeshift core; --fail-on-error propagates throws.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadMap(options) {
  const mapPath = options.map || path.join(__dirname, '..', 'rename-map.json');
  const raw = fs.readFileSync(mapPath, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error(`rename-map at ${mapPath} is not a JSON array`);
  }
  const dict = new Map();
  for (const entry of arr) {
    if (typeof entry?.old !== 'string' || typeof entry?.new !== 'string') {
      throw new Error(`rename-map entry malformed: ${JSON.stringify(entry)}`);
    }
    dict.set(entry.old, entry.new);
  }
  return dict;
}

function literalReplace(value, dict) {
  // Strict literal equality: only rewrite when the entire string equals an
  // old key. This guarantees '@forgeax/engine-math' is never matched by the
  // '@forgeax/engine' → '@forgeax/engine-runtime' rule.
  return dict.has(value) ? dict.get(value) : null;
}

module.exports = function transform(file, api, options) {
  const j = api.jscodeshift;
  const root = j(file.source);
  const dict = loadMap(options);
  let mutated = false;

  function rewriteStringLiteral(path) {
    const node = path.node;
    if (!node || typeof node.value !== 'string') return;
    const replaced = literalReplace(node.value, dict);
    if (replaced != null && replaced !== node.value) {
      node.value = replaced;
      // recast preserves quote style via raw — clear so it re-emits cleanly.
      if (node.raw !== undefined) delete node.raw;
      if (node.extra) delete node.extra;
      mutated = true;
    }
  }

  // 1) static import: import X from 'src' | import 'src'
  root.find(j.ImportDeclaration).forEach((p) => {
    rewriteStringLiteral(p.get('source'));
  });

  // 2) re-export: export ... from 'src'
  root.find(j.ExportAllDeclaration).forEach((p) => {
    if (p.node.source) rewriteStringLiteral(p.get('source'));
  });
  root.find(j.ExportNamedDeclaration).forEach((p) => {
    if (p.node.source) rewriteStringLiteral(p.get('source'));
  });

  // 3) dynamic import('src'), require('src'), require.resolve('src')
  //    The TS parser models dynamic imports as CallExpression with callee
  //    type 'Import', not as ImportExpression — so we handle all three call
  //    shapes uniformly here.
  root.find(j.CallExpression).forEach((p) => {
    const callee = p.node.callee;
    const isDynamicImport = callee?.type === 'Import';
    const isRequire = callee?.type === 'Identifier' && callee.name === 'require';
    const isRequireResolve =
      callee?.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'require' &&
      callee.property?.type === 'Identifier' &&
      callee.property.name === 'resolve';
    if (!isDynamicImport && !isRequire && !isRequireResolve) return;
    const args = p.node.arguments || [];
    if (args.length === 0) return;
    const first = p.get('arguments').get(0);
    if (first?.node?.type === 'Literal' || first?.node?.type === 'StringLiteral') {
      rewriteStringLiteral(first);
    }
  });

  // 5) TS-only: import type ... from 'src' is already covered by ImportDeclaration.
  //    TSImportType: type X = import('src').Y
  if (j.TSImportType) {
    root.find(j.TSImportType).forEach((p) => {
      const arg = p.get('argument');
      if (arg?.node?.type === 'TSLiteralType') {
        const lit = arg.get('literal');
        if (lit?.node?.type === 'StringLiteral' || lit?.node?.type === 'Literal') {
          rewriteStringLiteral(lit);
        }
      } else if (arg?.node?.type === 'StringLiteral' || arg?.node?.type === 'Literal') {
        rewriteStringLiteral(arg);
      }
    });
  }

  return mutated ? root.toSource({ quote: 'single' }) : null;
};

module.exports.parser = 'ts';
