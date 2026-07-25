'use strict';

const path = require('node:path');

const owners = new Map([
  ...['ChildOf', 'Children', 'Name', 'Transform', 'scenePlugin', 'propagateTransforms'].map(
    (name) => [name, '@forgeax/engine-scene'],
  ),
  ...['Skin', 'resolveSkinJoints'].map((name) => [name, '@forgeax/engine-skinning']),
  ...[
    'AnimationPlayer',
    'animationPlugin',
    'defineAnimationGraph',
    'describeAnimationGraph',
    'serializeAnimationGraph',
    'evaluateAnimationGraph',
    'advanceAnimationPlayer',
    'AdvanceAnimationPlayer',
    'EvaluateAnimationGraph',
  ].map((name) => [name, '@forgeax/engine-animation']),
  ...[
    'Camera',
    'MeshFilter',
    'MeshRenderer',
    'DirectionalLight',
    'PointLight',
    'SpotLight',
    'Layer',
    'SortKey',
    'Instances',
    'PostProcessParams',
    'Renderer',
    'RendererOptions',
    'RendererBackend',
    'RendererLostInfo',
    'RendererLostListener',
    'RenderError',
    'RenderErrorCode',
  ].map((name) => [name, '@forgeax/engine-render']),
]);
const enabledDomains = new Set(
  (process.env.CUTOVER_DOMAINS ?? 'all')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function importedName(specifier) {
  if (specifier.type !== 'ImportSpecifier') return undefined;
  return specifier.imported.name ?? specifier.imported.value;
}

module.exports = function transform(file, api) {
  if (file.path.includes(`${path.sep}packages${path.sep}runtime${path.sep}src${path.sep}index.`))
    return null;
  const j = api.jscodeshift.withParser('ts');
  const root = j(file.source);
  let changed = false;
  root
    .find(j.ImportDeclaration, { source: { value: '@forgeax/engine-runtime' } })
    .forEach((nodePath) => {
      const declaration = nodePath.node;
      const groups = new Map();
      const retained = [];
      for (const specifier of declaration.specifiers ?? []) {
        const owner = owners.get(importedName(specifier));
        const enabled =
          owner &&
          (enabledDomains.has('all') || enabledDomains.has(owner.slice('@forgeax/engine-'.length)));
        if (!enabled || specifier.type !== 'ImportSpecifier') retained.push(specifier);
        else {
          if (!groups.has(owner)) groups.set(owner, []);
          groups.get(owner).push(specifier);
        }
      }
      if (!groups.size) return;
      const declarations = [];
      for (const [source, specifiers] of groups) {
        const moved = j.importDeclaration(specifiers, j.literal(source));
        moved.importKind = declaration.importKind;
        declarations.push(moved);
      }
      if (retained.length) {
        const keep = j.importDeclaration(retained, j.literal('@forgeax/engine-runtime'));
        keep.importKind = declaration.importKind;
        declarations.push(keep);
      }
      j(nodePath).replaceWith(() => declarations);
      changed = true;
    });
  return changed ? root.toSource({ quote: 'single', trailingComma: true }) : null;
};

module.exports.parser = 'ts';
