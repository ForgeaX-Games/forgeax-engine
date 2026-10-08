#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGroups } from '../lib/run-bounded-groups.mjs';
import { readMemoryPressureDiagnostics } from '../lib/runner-resources.mjs';
import hostFiles from './browser-host-files.json' with { type: 'json' };
import { isRetryableOutput, runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const browserHostFiles = new Set(hostFiles);
export function browserGroupIsHostOnly(group) {
  return group.length > 0 && group.every((file) => browserHostFiles.has(file));
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
// Regular groups pay one fresh Vite/Chrome startup. Keep the startup boundary
// for the genuinely cold GPU/asset owners, but let contract-only browser
// files share the normal bounded group so CI spends its budget on assertions
// instead of repeatedly booting identical browsers.
const defaultGroupSize = 8;
const defaultMaxWorkers = 1;
const defaultGroupConcurrency = 1;
const maxGroupConcurrency = 3;
const browserGroupTimeoutMs = 300_000;
const directLightBrowserGroupTimeoutMs = 420_000;
// The complete Preview catalog has a 330 s preparation hook and a 120 s
// gameplay case, enclosed by the existing documented 420 s total budget.
const previewBrowserGroupTimeoutMs = 420_000;
// Enclose the existing 300 s Surface case with bounded startup/cleanup time.
const surfaceProvenanceBrowserGroupTimeoutMs = 360_000;
// Four 60-frame captures and fresh-device replays have a 600 s case budget.
const generatedLodBrowserGroupTimeoutMs = 630_000;
const browserNodeHeapArg = '--max-old-space-size=4096';
const defaultShardCount = 1;
const defaultShardIndex = 0;
const defaultShardStrategy = 'round-robin';
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const r32floatCapabilityGenerationTest =
  'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
const advancedLightingBrowserFiles = new Set([
  'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
]);
const iblIrradianceBrowserFile =
  'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts';
const iblSpecularBrowserFile =
  'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts';
const transmissionBrowserFile =
  'apps/learn-render/6.pbr/4.transmission-refraction/src/__tests__/onerror-gate.browser.test.ts';
const topologyBrowserFile = 'apps/hello/topology/src/__tests__/topology.browser.test.ts';
const directLightBrowserFile =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
const instancingStaticBrowserFile =
  'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
const thinWrapperBrowserFile = 'packages/app/__tests__/thin-wrapper.browser.test.ts';
const solarAtmosphereCalibrationBrowserFile =
  'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts';
const surfaceProvenanceBrowserFile =
  'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts';
const generatedLodBrowserFile = 'packages/runtime/src/__tests__/generated-lod.browser.test.ts';
const lightingChannelReplayFiles = new Set(
  ['world', 'publication'].flatMap((mode) =>
    ['rigid', 'skin'].flatMap((receiver) =>
      ['forward', 'deferred'].map(
        (renderPath) =>
          `packages/runtime/src/__tests__/lighting-channels-${mode}-${receiver}-${renderPath}.browser.test.ts`,
      ),
    ),
  ),
);
const lightingChannelBrowserFiles = new Set([
  ...lightingChannelReplayFiles,
  'packages/runtime/src/__tests__/lighting-channels-character.browser.test.ts',
  ...['world', 'publication'].flatMap((mode) =>
    ['sections', 'instances', 'transparent', 'physical'].map(
      (receiver) =>
        `packages/runtime/src/__tests__/lighting-channels-${mode}-${receiver}.browser.test.ts`,
    ),
  ),
  'packages/runtime/src/__tests__/lighting-channels-shadow.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-views.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-lifecycle.browser.test.ts',
  'packages/app/__tests__/lighting-channels.browser.test.ts',
]);
const shortRendererBootstrapBrowserFiles = new Set([
  'packages/runtime/src/__tests__/barrel-distortion-zero-size.browser.test.ts',
  'packages/runtime/src/__tests__/clamp-to-last.e2e.browser.test.ts',
  'packages/runtime/src/__tests__/composite-skybox-cross-world.browser.test.ts',
]);
const exclusiveRunnerBrowserFiles = new Set([
  // Run37361872160 timed out both overlapping environment/fog pairs.
  // Their environment/calibration neighbors passed unchanged solo retries.
  // Drain the existing runner slots without changing fixtures or deadlines.
  'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
  'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts',
  'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts',

  // Both attempts in PR run 36821505941 approached the 16 GB cgroup limit.
  // The second killed a neighboring group while this eight-file group was
  // active, with its Vitest process holding 4.6 GB RSS. Keep the full group,
  // but let it run without another browser group sharing the runner.
  'apps/parity/color-lighting/src/visual/__tests__/vertex-color-visual.browser.test.ts',
  // Run 36927168010 reached 15.9 GB while this measured video owner held
  // 4.5 GB RSS and the neighboring full rendering group was SIGKILLed.
  // Retain the 720p/1080p measurements and 300 s bound without that overlap.
  'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
]);
const browserProcessIsolatedFiles = new Set([
  // The local World/rigid/Forward replay measured 186 s. Keep every source,
  // writer and path, with one replay case per original 300 s process window.
  ...lightingChannelBrowserFiles,

  // The unchanged seven-case PCM owner fails its first Range poll in the
  // eight-file cohort on Linux CI and macOS; it passes in a fresh process.
  'packages/audio-webaudio/src/__tests__/pcm-stream.browser.test.ts',
  ...advancedLightingBrowserFiles,
  iblIrradianceBrowserFile,
  iblSpecularBrowserFile,
  transmissionBrowserFile,
  topologyBrowserFile,
  directLightBrowserFile,
  instancingStaticBrowserFile,
  // createApp(canvas) performs the first real WebGPU renderer construction.
  // This owner exceeded its 30 s budget in a mixed renderer group on CI.
  // Give it a fresh process to bound shared native state; the original real
  // renderer assertions and test deadline still decide whether it is healthy.
  thinWrapperBrowserFile,
  // Both mixed-group attempts missed the 15 s bootstrap observation, while
  // the unchanged triangle passed alone. Keep that deadline in a fresh process.
  'apps/learn-render/1.getting-started/2.hello-triangle/src/__tests__/onerror-gate.browser.test.ts',
  // This six-test solar calibration owns several real WebGPU render journeys.
  // The b323 Linux/lavapipe runs completed in 239-244 s and nearly filled the
  // ordinary 300 s group budget when seven other files shared its process.
  // Give it a fresh process while retaining the same six assertions and
  // owner-level 300 s timeout.
  solarAtmosphereCalibrationBrowserFile,
  // Equal-time replay owns two renderers and retains its complete 240 s case.
  // Run 37320616705 exhausted the shared 300 s process twice after calibration.
  'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts',
  // This owner requires a complete catalog before rendering. Its existing
  // Surface-only input closure avoids cooking unrelated scene fixtures.
  surfaceProvenanceBrowserFile,
  // Run 37245520259 exhausted a four-file process twice. Image environment
  // alone consumed 223s; preserve every owner in a fresh bounded process.
  'packages/runtime/src/__tests__/framebuffer-snapshot.browser.test.ts',
  'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts',
  'packages/runtime/src/__tests__/light-casters-9-light.browser.test.ts',
  'packages/runtime/src/__tests__/material-mrt.browser.test.ts',
  generatedLodBrowserFile,
  // Run 36924174364 exhausted the four-file runtime group's 300 s bound
  // on both attempts. Modeling used 135 s and DRS 50 s on retry while
  // alpha-hash remained unfinished. Keep each complete owner in the same
  // bounded fresh process; no case or process deadline changes.
  'packages/runtime/src/__tests__/adaptive-drs.browser.test.ts',
  'packages/runtime/src/__tests__/advanced-modeling.browser.test.ts',
  'packages/runtime/src/__tests__/alpha-hash.browser.test.ts',
  // The complete hot-reload/recovery journey measured 139 s alone; its
  // eight-file runtime group exhausted the unchanged 300 s deadline twice.
  'packages/runtime/src/__tests__/material-publication.browser.test.ts',
  // Six Canvas update/recovery/replay journeys measured 222 s alone; the
  // mixed eight-file group exceeded 300 s. Keep the same bound in isolation.
  'packages/runtime/src/__tests__/canvas-texture.browser.test.ts',
  // CI 36040095295 exhausted the mixed runtime group's 300 s budget twice.
  // Preserve this complete publication journey and the same process bound.
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  // Three 60-frame LOD journeys exhausted the mixed group's 300 s budget twice.
  // Keep every pixel oracle and the same deadline in a fresh process.
  'packages/runtime/src/__tests__/lod-transition.browser.test.ts',
  // Normal/bump pixel and replay evidence measured 186 s alone after its mixed
  // group reached 300 s. Preserve the complete journey in one fresh process.
  'packages/runtime/src/__tests__/normal-bump.browser.test.ts',
  // Five barrel-output journeys consumed 77 s of test work alone. Replacing
  // their eighth neighbor still hit 300 s; give the complete owner one process.
  'packages/runtime/src/__tests__/barrel-distortion-output.browser.test.ts',
  // Fresh processes still missed 15 s on CI 36777528708 while another GPU
  // group ran. Retain 15/30 s case deadlines without neighboring runner work.
  ...shortRendererBootstrapBrowserFiles,
  // Four video measurements took 141-144 s in CI 36770987234. The shared
  // four-file group exhausted 300 s twice; retain the complete owner alone.
  'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
  // The 60-frame SSR case exceeded 30 s twice in its mixed group; all nine
  // cases passed alone. Keep the original per-case and process deadlines.
  'packages/render/src/__tests__/ssr-gpu-dispatch.browser.test.ts',
  // The mixed ray group exhausted its 300 s bound on repeated CI attempts.
  // Keep all six path/capture/replay cases and their deadline in one fresh process.
  'packages/render/src/__tests__/raytracing/path-tracer.browser.test.ts',
  // Four live captures plus fresh-device per-work replays exhausted the
  // ordinary mixed-group budget. Preserve the 300 s bound in a fresh process.
  'packages/runtime/src/__tests__/standard-gbuffer-replay.browser.test.ts',
  // The complete displacement journey measured 151 s alone; its mixed group
  // exhausted 300 s. Preserve every case and replay in a fresh bounded process.
  'packages/runtime/src/__tests__/standard-displacement.browser.test.ts',
  // Both decal paths capture and replay on fresh devices. Their mixed runtime
  // group exhausted 300 s; keep every oracle inside the same bound alone.
  'packages/runtime/src/__tests__/decals.browser.test.ts',
  // Six captures and fresh-device replays take 75 s alone; the mixed runtime
  // group exhausted 300 s. Keep the complete lens journey in its own process.
  'packages/runtime/src/__tests__/lens-effects.browser.test.ts',
  // Seven flare captures, five fresh-device oracle replays and five
  // missing-bokeh falsifier replays share the lens replay cost profile.
  'packages/runtime/src/__tests__/lens-flare.browser.test.ts',

  // Split/minimap/monitor captures and fresh-device replay exhausted the
  // eight-file group on both attempts; retain the complete camera/replay journey.
  'packages/runtime/src/__tests__/multi-camera.browser.test.ts',
  // The local/transferred publication journey took 71 s inside a runtime
  // group that repeatedly exhausted 300 s; retain its complete comparison.
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  // These full RHI replay journeys were still unfinished after the mixed
  // runtime group spent its deadline on the other rendering owners.
  'packages/runtime/src/__tests__/normal-bump.browser.test.ts',
  'packages/runtime/src/__tests__/outline.browser.test.ts',
  // The clipping color/depth/shadow/replay journey passed in 64 s, but its
  // eight-file runtime group exhausted the 300 s bound on both CI attempts.
  'packages/runtime/src/__tests__/clipping-planes.browser.test.ts',
  // All fifteen journeys pass in 383 s on software WebGPU, beyond the 300 s
  // group bound. Each scene/resolution retains all five filters independently.
  'packages/runtime/src/__tests__/shadow-contact-column.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-centimeter-1024.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-centimeter-2048.browser.test.ts',
  // The two 50k pressure runs and two real Worker/device-loss recoveries
  // take about 250 s locally before unrelated files are added.
  'packages/app/__tests__/render-worker.browser.test.ts',
  'packages/app/__tests__/render-worker-contract.browser.test.ts',
  // Real multi-camera capture, fresh-device replay and child replacement share
  // the unchanged 300 s group bound in one process.
  'packages/app/__tests__/render-worker-multi-camera.browser.test.ts',
  'packages/app/__tests__/worker-policy.browser.test.ts',
  // Each content group keeps both tiers, acknowledged publications, and real child replacement.
  // Eleven cases measured 585 s together; split semantic owners retain the 300 s bound.
  'packages/app/__tests__/render-worker-deformation.browser.test.ts',
  'packages/app/__tests__/render-worker-geometry.browser.test.ts',
  'packages/app/__tests__/render-worker-media.browser.test.ts',
  'packages/app/__tests__/render-worker-tiles.browser.test.ts',
  // Two local lighting cases plus native publication exhausted 300 s twice
  // (run 36597854898). Keep publication/replay in its own bounded process.
  'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
  'packages/runtime/src/__tests__/vfx-mesh-lighting-publication.browser.test.ts',
  // Two host-loss cycles hit the unchanged 20 s recovery deadline in a mixed
  // GPU group; the complete journey passes in a fresh process (103 s measured).
  'packages/runtime/src/__tests__/wave1-rendering-recovery.browser.test.ts',
  'packages/app/__tests__/render-worker-environment.browser.test.ts',
]);
const renderingGroupSize = 4;
function isRenderingBrowserFile(file) {
  return (
    file.startsWith('packages/runtime/src/__tests__/') ||
    file.startsWith('packages/render/src/__tests__/raytracing/') ||
    file === 'packages/ui/src/preview/__tests__/capture-determinism.browser.test.ts'
  );
}
const assetColdOwnerFiles = new Set([
  iblIrradianceBrowserFile,
  iblSpecularBrowserFile,
  transmissionBrowserFile,
  topologyBrowserFile,
]);
const instancingStaticBrowserGroupTimeoutMs = 900_000;
const colorLightingCasePrefix = 'apps/parity/color-lighting/cases/';
const colorLightingCaseGroupSize = 4;
const colorLightingCaseSeconds = 18;
const excludedDirectories = new Set([
  '.git',
  '.forgeax-harness',
  'artifacts',
  'dist',
  'node_modules',
]);

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const valueOptions = new Set([
    '--file',
    '--group-concurrency',
    '--group-size',
    '--max-workers',
    '--shard-count',
    '--shard-index',
    '--shard-strategy',
  ]);
  const options = {
    dryRun: false,
    files: [],
    groupConcurrency: defaultGroupConcurrency,
    groupSize: defaultGroupSize,
    maxWorkers: defaultMaxWorkers,
    shardCount: defaultShardCount,
    shardIndex: defaultShardIndex,
    shardStrategy: defaultShardStrategy,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? (valueOptions.has(key) ? argv[++index] : undefined);
    if (key === '--file') {
      if (!value) throw new Error('--file needs an exact repository test path');
      options.files.push(value);
    } else if (key === '--group-concurrency') {
      options.groupConcurrency = parsePositiveInt(value, '--group-concurrency', {
        max: maxGroupConcurrency,
      });
    } else if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 24 });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else if (key === '--shard-count') {
      options.shardCount = parsePositiveInt(value, '--shard-count', { max: 4 });
    } else if (key === '--shard-index') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3)
        throw new Error(`--shard-index must be an integer from 0 to 3, got ${value}`);
      options.shardIndex = parsed;
    } else if (key === '--shard-strategy') {
      if (value !== 'round-robin' && value !== 'balanced') {
        throw new Error(`--shard-strategy must be round-robin or balanced, got ${value}`);
      }
      options.shardStrategy = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.shardIndex >= options.shardCount)
    throw new Error(
      `--shard-index must be less than --shard-count, got ${options.shardIndex + 1}/${options.shardCount}`,
    );
  return options;
}

// Browser groups are intentionally ordered for readable logs, but a simple
// groupIndex % shardCount assignment can put the long owners on the same
// runner. Keep every test and process boundary, and place groups with a
// deterministic longest-processing-time scheduler over measured seconds.
// browser-file-seconds.json holds each file's Vitest-reported duration (the
// latest successful profile where available, otherwise the earlier measurement).
// Run 37147881797 refreshes 259 measured file durations across all four passed
// Browser shards; the complete workflow still failed its Dawn recovery cases.
// A group adds one fresh Vite/Chrome startup and per-file collection cost.
// Unmeasured files keep an estimate
// until the table is refreshed from a later run.
const measuredBrowserFileSeconds = new Map(
  Object.entries(
    JSON.parse(readFileSync(path.join(scriptDir, 'browser-file-seconds.json'), 'utf8')).files,
  ),
);
// Run 37186700381 measured startup medians at 20.6/24.5/22.6/39.1 s.
// Charge the slow observed startup so fresh-process counts retain headroom.
const browserGroupStartupSeconds = 40;
const browserFileOverheadSeconds = 2;
const renderWorkerBrowserFile =
  /^packages\/app\/__tests__\/(?:render-worker[a-z-]*|worker-policy)\.browser\.test\.ts$/;
function estimatedBrowserFileSeconds(file) {
  // Placement estimate from that single local case, not a CI measurement.
  if (lightingChannelReplayFiles.has(file)) return 240;
  if (lightingChannelBrowserFiles.has(file)) return 100;
  // Until a complete duration exists, reserve the unchanged case budget; this
  // is an estimate, not a measurement of the censored run 37320616705.
  if (file === 'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts')
    return 240;
  if (renderWorkerBrowserFile.test(file)) return 75;
  if (file.startsWith('packages/runtime/src/__tests__/')) return 20;
  if (file.startsWith(colorLightingCasePrefix)) return colorLightingCaseSeconds;
  return 5;
}
export function browserFileWeight(file) {
  return (
    (measuredBrowserFileSeconds.get(file) ?? estimatedBrowserFileSeconds(file)) +
    browserFileOverheadSeconds
  );
}

export function browserGroupWeight(group) {
  return group.reduce(
    (seconds, file) => seconds + browserFileWeight(file),
    browserGroupStartupSeconds,
  );
}

// Keep exclusive work contiguous, then fill the concurrent lanes with the
// heaviest ordinary owners first. Interleaved exclusives drain partial batches
// and leave slots idle. A serial lane keeps the stable roster order.
export function browserGroupRunOrder(groups, selectedIndexes, concurrency) {
  if (concurrency <= 1) return undefined;
  return selectedIndexes
    .map((_index, position) => position)
    .sort(
      (left, right) =>
        Number(browserGroupRequiresExclusiveRunner(groups[selectedIndexes[right]])) -
          Number(browserGroupRequiresExclusiveRunner(groups[selectedIndexes[left]])) ||
        browserGroupWeight(groups[selectedIndexes[right]]) -
          browserGroupWeight(groups[selectedIndexes[left]]) ||
        left - right,
    );
}

// CI's existing four runners each reserve their own serial tail: shard 0
// discovery/MSAA/FXAA/multiplayer; shard 3 Runtime Pack; shard 2 mesh interchange.
// Run 37184336050 measured Runtime Pack plus upload/cleanup at 304 s and
// mesh interchange plus upload/cleanup at 334 s. Reserve measured tails
// with headroom; discovery/MSAA/FXAA/multiplayer retained its 300 s allowance.
// One tail second occupies every group slot, so scale it by concurrency.
export const ciBrowserShardTailSeconds = Object.freeze([300, 0, 400, 350]);

export function assignBrowserGroupsToShards(
  groups,
  shardCount,
  strategy = defaultShardStrategy,
  { tailSeconds = [], concurrency = 1 } = {},
) {
  if (strategy === 'round-robin') {
    return groups.map((_group, groupIndex) => groupIndex % shardCount);
  }
  const totals = Array.from({ length: shardCount }, (_value, shard) =>
    shard < tailSeconds.length ? tailSeconds[shard] * concurrency : 0,
  );
  const assignment = Array(groups.length).fill(0);
  // An exclusive group holds every concurrent lane of its runner.
  const ranked = groups
    .map((group, index) => ({
      index,
      weight:
        browserGroupWeight(group) * (browserGroupRequiresExclusiveRunner(group) ? concurrency : 1),
    }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const { index, weight } of ranked) {
    let selected = 0;
    for (let shard = 1; shard < shardCount; shard += 1) {
      if (totals[shard] < totals[selected]) selected = shard;
    }
    assignment[index] = selected;
    totals[selected] += weight;
  }
  // Refine LPT by exchanging whole groups only when the measured lane
  // spread strictly improves. Process boundaries and group counts survive.
  for (;;) {
    const shortest = totals.indexOf(Math.min(...totals));
    let spread = Math.max(...totals) - totals[shortest];
    let selected;
    for (const left of ranked) {
      const owner = assignment[left.index];
      if (owner === shortest) continue;
      for (const right of ranked) {
        if (assignment[right.index] !== shortest) continue;
        const delta = left.weight - right.weight;
        if (delta <= 0) continue;
        const candidate = [...totals];
        candidate[owner] -= delta;
        candidate[shortest] += delta;
        const nextSpread = Math.max(...candidate) - Math.min(...candidate);
        if (nextSpread < spread) {
          spread = nextSpread;
          selected = { left, right, owner, delta };
        }
      }
    }
    if (selected === undefined) break;
    assignment[selected.left.index] = shortest;
    assignment[selected.right.index] = selected.owner;
    totals[selected.owner] -= selected.delta;
    totals[shortest] += selected.delta;
  }
  return assignment;
}

export function browserTestFiles(directory = rootDir, relativeDirectory = '') {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (
        excludedDirectories.has(entry.name) ||
        relativePath === path.join('packages', 'wgpu-wasm', 'target') ||
        relativePath === path.join('packages', 'dawn-node', '.native-build') ||
        relativePath === '.worktrees' ||
        relativePath === path.join('.claude', 'worktrees') ||
        relativePath.startsWith(`${path.join('.claude', 'worktrees')}${path.sep}`)
      ) {
        continue;
      }
      files.push(...browserTestFiles(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.browser.test.ts') &&
      relativePath !== entityVisibilityBrowserTest
    ) {
      files.push(relativePath.split(path.sep).join('/'));
    }
  }
  return files;
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function planGroups(files, groupSize) {
  const host = files.filter((file) => browserHostFiles.has(file));
  files = files.filter((file) => !browserHostFiles.has(file));
  const preview = files.filter((file) => file.startsWith('apps/preview/'));
  const isolated = files.filter((file) => browserProcessIsolatedFiles.has(file));
  const regular = files.filter(
    (file) => !file.startsWith('apps/preview/') && !browserProcessIsolatedFiles.has(file),
  );
  const colorLightingCases = regular.filter((file) => file.startsWith(colorLightingCasePrefix));
  const rendering = regular.filter(isRenderingBrowserFile);
  const ordinaryRegular = regular.filter(
    (file) => !file.startsWith(colorLightingCasePrefix) && !isRenderingBrowserFile(file),
  );

  // These owners create a real WebGPU device or a multi-pass pipeline whose
  // cold start has exceeded the ordinary Vitest budget on persistent runners.
  // Vitest's historical-duration scheduler can otherwise make their
  // app/renderer lifecycles contend with neighboring files. Each advanced
  // lighting owner gets its own fresh process: HDR, Bloom, deferred shading,
  // and SSAO all create multi-pass WebGPU pipelines, and sharing even two of
  // them has consumed the 60s test budget or stalled teardown before the app
  // became observable. The direct-light parity producer is also isolated: it
  // renders eight bounded captures (60 frames locally, 24 in the CI
  // lightweight profile) and keeps its own outer budget. Ordinary browser
  // files keep the caller-supplied bounded group size for throughput.
  const isolatedAdvancedLighting = isolated
    .filter((file) => advancedLightingBrowserFiles.has(file))
    .map((file) => [file]);
  // These asset consumers use the on-demand Pack path and do not
  // own a long frame loop; share one process so their cold Vite startup is
  // paid once while the heavier renderer owners retain their boundaries.
  // Topology requests the Catalog but only draws procedural geometry. Full
  // eager asset cooking consumed its 120s test deadline before rendering.
  const assetColdOwners = isolated.filter((file) => assetColdOwnerFiles.has(file));
  const isolatedGroups = [
    ...isolatedAdvancedLighting,
    ...(assetColdOwners.length > 0 ? [assetColdOwners] : []),
    ...isolated
      .filter((file) => !advancedLightingBrowserFiles.has(file) && !assetColdOwnerFiles.has(file))
      .map((file) => [file]),
  ];
  return [
    ...host.filter((file) => browserProcessIsolatedFiles.has(file)).map((file) => [file]),
    ...chunk(
      host.filter((file) => !browserProcessIsolatedFiles.has(file) && isRenderingBrowserFile(file)),
      Math.min(groupSize, renderingGroupSize),
    ),
    ...chunk(
      host.filter(
        (file) => !browserProcessIsolatedFiles.has(file) && !isRenderingBrowserFile(file),
      ),
      groupSize,
    ),
    ...(preview.length > 0 ? [preview] : []),
    ...isolatedGroups,
    // The color-lighting cases perform multiple live captures. Keep their
    // fresh-process boundary small enough for the regular 300s budget while
    // retaining the caller's larger group size for ordinary contract files.
    ...chunk(colorLightingCases, colorLightingCaseGroupSize),
    // Runtime, Ray and Preview capture owners perform real WebGPU journeys.
    // Multiple eight-file combinations exhausted 300 s after roster additions.
    // Bound this whole family instead of isolating each newly displaced file.
    ...chunk(rendering, Math.min(groupSize, renderingGroupSize)),
    ...chunk(ordinaryRegular, groupSize),
  ];
}

function resolveCliPath() {
  const candidates = [
    path.join(rootDir, 'node_modules/vitest/vitest.mjs'),
    path.join(rootDir, 'node_modules/vitest/dist/cli.js'),
  ];
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  if (!cliPath) throw new Error('cannot resolve the workspace Vitest CLI');
  return cliPath;
}

export function withBrowserHeapLimit(environment) {
  const inherited = environment.NODE_OPTIONS?.trim() ?? '';
  if (/(^|\s)--max-old-space-size(?:=|\s)/.test(inherited)) return environment;
  return {
    ...environment,
    NODE_OPTIONS: [inherited, browserNodeHeapArg].filter(Boolean).join(' '),
  };
}

export function browserProducerReadiness(group, requestedReadiness) {
  const previewGroup = group.some((file) => file.startsWith('apps/preview/'));
  return previewGroup ||
    group.includes(surfaceProvenanceBrowserFile) ||
    requestedReadiness === 'before-consume'
    ? 'before-consume'
    : 'on-demand';
}

// A before-consume group cooks the whole browser catalog in its Vitest process
// (6-7 GB). In run 36958820889 Surface provenance beside a Render Worker group
// reached the 16 GB cgroup limit (oom_kill 20) and both groups timed out.
// A Render Worker group runs a second renderer in its worker: runs 36961810482
// (deformation) and 36973851710 (contract) SIGKILLed one beside an ordinary
// group at a 16.0 GB cgroup peak, with two Chrome renderers at 3.3-3.7 GB each.
// Run 37082849605 repeated the deformation/multi-camera overlap at 15.9 GB.
// The Worker family rule is the one admission authority for all these owners.
export function browserGroupRequiresExclusiveRunner(group) {
  return (
    browserProducerReadiness(group, undefined) === 'before-consume' ||
    group.some(
      (file) =>
        shortRendererBootstrapBrowserFiles.has(file) ||
        exclusiveRunnerBrowserFiles.has(file) ||
        renderWorkerBrowserFile.test(file),
    )
  );
}

export async function runGroup({ cliPath, group, groupIndex, groupCount, maxWorkers }) {
  const hostOnly = browserGroupIsHostOnly(group);
  process.stderr.write(`[vitest] browser group ${groupIndex}/${groupCount}: ${group.join(', ')}\n`);
  if (browserGroupRequiresExclusiveRunner(group))
    process.stderr.write('[vitest] browser group owns the runner exclusively\n');
  const groupTimeoutMs = group.includes(instancingStaticBrowserFile)
    ? instancingStaticBrowserGroupTimeoutMs
    : group.includes(directLightBrowserFile)
      ? directLightBrowserGroupTimeoutMs
      : group.includes(surfaceProvenanceBrowserFile)
        ? surfaceProvenanceBrowserGroupTimeoutMs
        : group.includes(generatedLodBrowserFile)
          ? generatedLodBrowserGroupTimeoutMs
          : group.some((file) => file.startsWith('apps/preview/'))
            ? previewBrowserGroupTimeoutMs
            : browserGroupTimeoutMs;
  // Every group has a fresh Vitest process. A before-consume producer pass
  // cooks the whole browser catalog, including Sponza, into that process's
  // heap (about 4 GB and 30-40 s per group), so ordinary groups resolve their
  // asset GUIDs through the same runtime import transport on first request.
  // Preview and Surface provenance remain before-consume because their
  // contracts assert a complete catalog before the consumer starts.
  const producerReadiness = browserProducerReadiness(
    group,
    process.env.FORGEAX_BROWSER_PACK_READINESS,
  );
  const command = [
    process.execPath,
    cliPath,
    'run',
    '--config',
    hostOnly ? 'config/vitest.browser-host.config.ts' : 'config/vitest.browser.config.ts',
    '--project=browser',
    '--passWithNoTests=false',
    `--maxWorkers=${maxWorkers}`,
    ...group,
  ];
  const environment = withBrowserHeapLimit({
    ...process.env,
    FORGEAX_BROWSER_ENTITY_VISIBILITY: '0',
    FORGEAX_BROWSER_CROSS_ORIGIN_ISOLATED: group.includes(
      'packages/app/__tests__/worker-policy.browser.test.ts',
    )
      ? '1'
      : '0',
    FORGEAX_BROWSER_PREVIEW_ONLY: group.every((file) => file.startsWith('apps/preview/'))
      ? '1'
      : '0',
    FORGEAX_BROWSER_SURFACE_ONLY: group.includes(surfaceProvenanceBrowserFile) ? '1' : '0',
    FORGEAX_BROWSER_PACK_READINESS: producerReadiness,
    FORGEAX_TOOL_PREVIEW: '1',
  });
  const run = () =>
    runBrowserCommand(command, {
      cwd: rootDir,
      env: environment,
      timeoutMs: groupTimeoutMs,
      gpuLease: !hostOnly,
      label: `Vitest browser group ${groupIndex}/${groupCount} files=${group.join(',')}`,
    });
  const first = await run();
  if (first.status === 0) return;
  if (first.signal === 'SIGKILL') {
    process.stderr.write(
      `[vitest] browser group ${groupIndex} memory-pressure=${JSON.stringify(readMemoryPressureDiagnostics())}\n`,
    );
  }
  if (first.cancelled || (!first.timedOut && !isRetryableOutput('vitest', first.output))) {
    throw new Error(`Vitest browser group ${groupIndex} failed; ${first.failure}`);
  }

  process.stderr.write(
    `::warning::Vitest browser group ${groupIndex}/${groupCount} reported ${first.timedOut ? 'a bounded timeout' : 'a retry signature (cause unclassified)'}; retrying only this group once with a fresh process\n`,
  );
  const second = await run();
  if (second.status !== 0) {
    throw new Error(
      `Vitest browser group ${groupIndex} failed after one isolated retry; ${second.failure}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let files = browserTestFiles();
  if (!files.includes(r32floatCapabilityGenerationTest))
    files.push(r32floatCapabilityGenerationTest);
  if (options.files.length) {
    for (const file of options.files)
      if (!files.includes(file)) throw new Error(`browser file is not in the gate roster: ${file}`);
    files = [...new Set(options.files)];
    console.log('[vitest] DIAGNOSTIC selection; full browser CI is still required');
  }
  const groups = planGroups(files, options.groupSize);
  if (groups.length === 0) throw new Error('no browser test files were discovered');
  const shardAssignment = assignBrowserGroupsToShards(
    groups,
    options.shardCount,
    options.shardStrategy,
    {
      tailSeconds: process.env.FORGEAX_BROWSER_FIXED_SMOKE === '1' ? ciBrowserShardTailSeconds : [],
      concurrency: options.groupConcurrency,
    },
  );
  const selectedGroups = groups.filter(
    (_group, groupIndex) => shardAssignment[groupIndex] === options.shardIndex,
  );
  if (selectedGroups.length === 0) {
    throw new Error(
      `browser shard ${options.shardIndex + 1}/${options.shardCount} selected no groups from ${groups.length}`,
    );
  }

  if (options.dryRun) {
    for (const [index, group] of groups.entries()) {
      if (shardAssignment[index] !== options.shardIndex) continue;
      process.stdout.write(
        `group-${String(index + 1).padStart(2, '0')} (${group.length} files): ${group.join(', ')}\n`,
      );
    }
    return;
  }

  // Host groups can start before shader preparation. Admit the same point
  // profile once, outside the GPU lease, before the first native consumer.
  const profileInputs = path.join(rootDir, 'node_modules/.cache/forgeax-build/browser-shaders');
  let shaderPreparation;
  const prepareShaders = () =>
    (shaderPreparation ??= (async () => {
      const prepared = await runBrowserCommand(
        [
          process.execPath,
          'scripts/forgeax/prepare-shader-release-inputs.mjs',
          '--build',
          '--profile',
          'point-ssao',
          '--input',
          profileInputs,
          ...(process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST
            ? ['--shared-input-manifest', process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST]
            : []),
        ],
        { cwd: rootDir, label: 'browser point-shadow shader producer' },
      );
      if (prepared.status !== 0)
        throw new Error(`browser shader preparation failed; ${prepared.failure}`);
    })());

  const cliPath = resolveCliPath();
  const selectedIndexes = groups
    .map((_group, index) => index)
    .filter((index) => shardAssignment[index] === options.shardIndex);
  await runGroups({
    groups: selectedIndexes,
    concurrency: options.groupConcurrency,
    order: browserGroupRunOrder(groups, selectedIndexes, options.groupConcurrency),
    isExclusive: (index) => browserGroupRequiresExclusiveRunner(groups[index]),
    runGroupImpl: async (index) => {
      if (!browserGroupIsHostOnly(groups[index])) await prepareShaders();
      await runGroup({
        cliPath,
        group: groups[index],
        groupIndex: index + 1,
        groupCount: groups.length,
        maxWorkers: options.maxWorkers,
      });
    },
  });
  process.stdout.write(
    `[vitest] split browser passed: groups=${groups.length}, selected=${selectedGroups.length}, files=${files.length}, shard=${options.shardIndex + 1}/${options.shardCount}, strategy=${options.shardStrategy}, groupConcurrency=${options.groupConcurrency}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[vitest] split browser failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
