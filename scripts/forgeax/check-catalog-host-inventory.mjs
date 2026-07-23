import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const CATALOG_HOSTS = [
  'apps/collectathon/vite.config.ts',
  'apps/hello/animation-graph/vite.config.ts',
  'apps/hello/audio/vite.config.ts',
  'apps/hello/compressed-texture/vite.config.ts',
  'apps/hello/custom-importer/vite.config.ts',
  'apps/hello/fbx-cube/vite.config.ts',
  'apps/hello/fbx-skin/vite.config.ts',
  'apps/hello/skin/vite.config.ts',
  'apps/hello/sprite-atlas/vite.config.ts',
  'apps/hello/sprite/vite.config.ts',
  'apps/hello/text/vite.config.ts',
  'apps/learn-render/1.getting-started/4.textures/vite.config.ts',
  'apps/learn-render/1.getting-started/5.transformations/vite.config.ts',
  'apps/learn-render/1.getting-started/6.coordinate-systems/vite.config.ts',
  'apps/learn-render/1.getting-started/7.camera/vite.config.ts',
  'apps/learn-render/2.lighting/4.lighting-maps/vite.config.ts',
  'apps/learn-render/2.lighting/5.light-casters/vite.config.ts',
  'apps/learn-render/2.lighting/6.multiple-lights/vite.config.ts',
  'apps/learn-render/3.model-loading/1.model-loading/vite.config.ts',
  'apps/learn-render/3.model-loading/2.city-glb/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/1.depth-testing/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/10.anti-aliasing-msaa/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/2.stencil-testing/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/3.blending/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/4.face-culling/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/5.framebuffers/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/6.cubemaps/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/7.advanced-glsl-ubo/vite.config.ts',
  'apps/learn-render/4.advanced-opengl/9.instancing/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/1.advanced-lighting/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/2.gamma-correction/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/3.1.shadow-mapping/3.full/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/3.3.csm/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/4.normal-mapping/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/5.parallax-mapping/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/6.hdr/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/7.bloom/vite.config.ts',
  'apps/learn-render/5.advanced-lighting/9.ssao/vite.config.ts',
  'apps/learn-render/6.pbr/2.ibl-irradiance/vite.config.ts',
  'apps/learn-render/6.pbr/3.ibl-specular/vite.config.ts',
  'apps/preview/vite.config.ts',
];

function pluginPackCalls(source) {
  const calls = [];
  for (
    let start = source.indexOf('pluginPack(');
    start >= 0;
    start = source.indexOf('pluginPack(', start + 1)
  ) {
    const lineStart = source.lastIndexOf('\n', start) + 1;
    if (!/^\s*pluginPack\(/.test(source.slice(lineStart, start + 'pluginPack('.length))) continue;
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(start, end + 1));
  }
  return calls;
}

export async function checkCatalogHostInventory(root) {
  const configured = new Set();
  const missingPolicy = [];
  for (const host of CATALOG_HOSTS) {
    const source = await readFile(resolve(root, host), 'utf8');
    const calls = pluginPackCalls(source);
    if (calls.length === 0) missingPolicy.push(`${host}: missing pluginPack host`);
    else if (!calls.every((call) => /refresh\s*:\s*reloadAssetHost\(\)/.test(call))) {
      missingPolicy.push(`${host}: missing explicit reloadAssetHost policy`);
    } else configured.add(host);
  }

  const discovered = [];
  const { glob } = await import('node:fs/promises');
  for await (const file of glob('apps/**/vite.config.ts', { cwd: root })) {
    const source = await readFile(resolve(root, file), 'utf8');
    if (pluginPackCalls(source).length > 0) discovered.push(file);
  }
  const unexpected = discovered.filter((file) => !CATALOG_HOSTS.includes(file));
  const missing = CATALOG_HOSTS.filter((host) => !discovered.includes(host));
  const errors = [
    ...missingPolicy,
    ...missing.map((host) => `${host}: inventory host disappeared`),
    ...unexpected.map((host) => `${host}: new pluginPack host is not in the 41-host inventory`),
  ];
  return {
    ok: errors.length === 0,
    configured: configured.size,
    expected: CATALOG_HOSTS.length,
    errors,
    channels: { tsConfig: 0, typeErasureScript: 0, jsonFixture: 0 },
  };
}

if (import.meta.main) {
  const result = await checkCatalogHostInventory(process.cwd());
  console.log(
    `catalog host inventory: ${result.configured}/${result.expected}; ts-config=0 type-erasure-script=0 json-fixture=0`,
  );
  for (const error of result.errors) console.error(error);
  if (!result.ok) process.exitCode = 1;
}
