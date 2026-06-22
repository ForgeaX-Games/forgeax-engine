import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Monorepo-root anchor for pluginPack roots (see browser project below).
// `new URL('.', import.meta.url)` already yields this file's directory
// (vitest.config.ts sits at the monorepo root), so `fileURLToPath` directly
// produces the repo root. No `dirname()` wrapper - that would walk up to
// `.worktrees/` under worktree checkouts and break pluginPack root resolution.
// charter F1 prefers the single-step explicit form for grep traceability.
const rootDir = fileURLToPath(new URL('.', import.meta.url));

// Root vitest config - declares projects per K-3 split policy:
//
//   - unit layer (per-package + apps + scripts; each retains its own
//     defineProject config). Auto-discovered via globs `packages/*` /
//     `apps/*` / `scripts`; project names like `@forgeax/engine-math` /
//     `@forgeax/engine-runtime`. The inline `name: 'unit'` marker project below is
//     the K-3 three-command SSOT naming anchor (grep gate: vitest.config.ts
//     must contain 'unit' / 'browser' / 'dawn' literal name fields) plus
//     the explicit `--project unit` filter entry; the marker itself runs
//     passWithNoTests, producing no new test work.
//   - browser layer (AC-05): vitest browser mode + playwright provider;
//     file-naming convention `*.browser.test.ts`.
//   - dawn layer (AC-06): dawn.node native binding; setup-webgpu.ts injects
//     globalThis.navigator.gpu; file-naming convention `*.dawn.test.ts`.
//
// Command split (K-3 + AGENTS.md commands):
//   - `pnpm test`         = alias `test:unit` (fastest PR feedback path)
//   - `pnpm test:unit`    = `vitest run --project '!browser' --project '!dawn'`
//                          (per-package + marker 'unit' coverage; leaves
//                          dawn/browser untouched)
//   - `pnpm test:browser` = `vitest run --project browser`
//   - `pnpm test:dawn`    = `vitest run --project dawn`
//   - `pnpm test:all`     = three commands serial (K-3 warning: do NOT
//                          fold into the root `pnpm test`, otherwise a
//                          single chromium / dawn launch failure pollutes
//                          the unit feedback channel)
//
// v4 essentials (research Finding 2.1):
//   - `provider: playwright()` factory (not the v3 string form)
//   - `instances: [{ browser: 'chromium' }]` at minimum one entry
//     (the v3 `browser.name` string short-circuit is removed)
//   - launchOptions.headless is force-ignored -> use `test.browser.headless`
//   - test code imports from `vitest/browser`
//     (not the v3 `@vitest/browser/context`)
//
// Cross-isolation (M2.6 / R10): the dawn project runs node env + dedicated
// setup file; sharing globalThis with unit / browser is mitigated through
// `afterAll` teardown that drops the gpu reference, easing chromium issue
// 387965810 (globalThis.navigator.gpu global pollution preventing node
// process exit).
export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    teardownTimeout: 500,
    projects: [
      // -- unit layer: existing per-package + apps + scripts --
      'packages/*',
      'apps/*',
      // feat-20260515 M4 D-6: nested learn-render workspaces register
      // through the dual-segment glob (pnpm-workspace.yaml#packages
      // mirror). The vitest config form points at each workspace's
      // vite.config.ts so vitest does not try to load `.gitkeep`
      // siblings (other section-* dirs are placeholders awaiting future
      // feats). Without this entry the 7 LearnOpenGL section-1.*
      // placeholder tests (M4 scaffold; M5-M11 fill the real e2e) are
      // skipped under `pnpm test:unit`, and the metrics:check workspace
      // set drifts from the vitest project set (architecture principle
      // #1 SSOT).
      'apps/learn-render/1.getting-started/*/vite.config.ts',
      'apps/hello/triangle',
      'scripts',
      // K-3 naming anchor (marker; passWithNoTests means `--project unit`
      // does not produce a failure signal, it only acts as the SSOT
      // command-entry semantic placeholder).
      {
        test: {
          name: 'unit',
          include: [],
          passWithNoTests: true,
        },
      },
      // -- browser layer: vitest browser mode (AC-05) --
      //
      // M5-followup (feat-20260518-pbr-direct-lighting-mvp): inject
      // `forgeaxShader()` at the project level so the dev server serves
      // `/shaders/manifest.json` with the composed pbr.wgsl + unlit.wgsl
      // entries. Browser tests that call `Engine.create({ canvas })` rely on
      // the default manifest URL — without the plugin the manifest is empty
      // and createRenderer's f_schlick / unlit detection (createRenderer.ts
      // post-w22.9 path) rejects with 'shader-compile-failed'. The previous
      // `EMPTY_MANIFEST_URL` data-URL workaround silently lied: the empty
      // entries array satisfies schema validation but fails the f_schlick
      // identity check downstream. Plugin runs in dev only via
      // configureServer (no build cost).
      {
        // tweak-20260521 D-1: mount pluginPack() alongside forgeaxShader() so
        // vitest browser project tests reach `/pack-index.json` through the
        // plugin's configureServer middleware (real texture fetch path) rather
        // than the silent untextured fallback. Roots are explicit 6-entry SSOT
        // (charter F1 single-grep): four learn-render section local assets/
        // dirs (1.4 / 1.5 / 1.6 / 1.7) plus the two shared NonCommercial
        // submodule subtrees (learn-opengl/textures + learn-opengl/meshes).
        // Order: local-assets first (per-section .pack.json + image meta
        // sidecars), then shared submodule (container.jpg + cube-mesh stub
        // sidecars). Mirrors each section's vite.config.ts plugin order so
        // an AI user reading either entry point sees the same shape.
        //
        // feat-learn-render-3.1: the Sponza model-loading onerror-gate also
        // needs `khronos-gltf-samples/Sponza` scanned (glTF + 69 textures) so
        // its loadByGuid<TextureAsset> path resolves through the pluginPack
        // middleware; the HDR equirect for the Skylight IBL is already covered
        // by the learn-opengl/textures root. `server.fs.allow` widens the dev
        // server sandbox to the monorepo root so main.ts's import.meta.url
        // fetch of Sponza.gltf (outside the per-test dir) is served.
        plugins: [
          forgeaxShader(),
          pluginPack({
            roots: [
              resolve(rootDir, 'apps/learn-render/1.getting-started/4.textures/assets'),
              resolve(rootDir, 'apps/learn-render/1.getting-started/5.transformations/assets'),
              resolve(rootDir, 'apps/learn-render/1.getting-started/6.coordinate-systems/assets'),
              resolve(rootDir, 'apps/learn-render/1.getting-started/7.camera/assets'),
              resolve(rootDir, 'forgeax-engine-assets/learn-opengl/textures'),
              resolve(rootDir, 'forgeax-engine-assets/learn-opengl/meshes'),
              resolve(rootDir, 'forgeax-engine-assets/khronos-gltf-samples/Sponza'),
              // apps/preview e2e (preview.browser.test.ts): the game-default
              // template root holds scene.pack.json + material packs; the
              // submodule subtree holds sky.hdr (loaded via loadByGuid through
              // this middleware). Mirrors apps/preview/vite.config.ts roots.
              resolve(rootDir, 'templates/game-default'),
              resolve(rootDir, 'forgeax-engine-assets/demo-assets/template-game-default'),
            ],
          }),
        ],
        server: {
          fs: { allow: [rootDir] },
        },
        test: {
          name: 'browser',
          include: ['**/*.browser.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.worktrees/**',
            '**/.claude/worktrees/**',
          ],
          browser: {
            enabled: true,
            // playwright provider launchOptions: channel = 'chrome-beta'
            // picks the system Chrome Beta binary (full WebGPU build, unlike
            // the bundled chromium_headless_shell which strips WebGPU).
            // launchOptions.args inject the same flag set Three.js + Babylon
            // use for headless WebGPU on ubuntu-latest + lavapipe. Prior CI
            // relied on the smoke harness's `playwright install chrome-beta`
            // step to seed the binary; smoke moved to dawn-node
            // (feat-20260509-lavapipe-mapasync-lifecycle w2 K-1 amend C-ii)
            // so ci.yml installs chrome-beta independently. charter
            // proposition 4 explicit-failure: when WebGPU is unreachable
            // the test throws code: 'webgpu-unavailable'.
            //
            // launchOptions MUST live at the playwright() factory call
            // (single global config) - the provider only reads
            // `this.options.launchOptions`, not per-instance launchOptions
            // (verified at @vitest/browser-playwright@4.1.5/dist/index.js:869).
            provider: playwright({
              launchOptions: {
                channel: 'chrome-beta',
                args: [
                  '--enable-unsafe-webgpu',
                  '--enable-features=Vulkan',
                  '--use-vulkan=swiftshader',
                  '--disable-vulkan-surface',
                  '--ignore-gpu-blocklist',
                  '--disable-gpu-driver-bug-workarounds',
                  // feat-20260619-audio-resource-ownership-deterministic-reclaim M5:
                  // browser tests need AudioContext to start in 'running' state
                  // without a real user gesture (headless chromium autoplay policy
                  // gate). The engine's production gesture-resume listener is correct
                  // and must NOT be altered; this flag lifts the gate in test only.
                  '--autoplay-policy=no-user-gesture-required',
                ],
              },
            }),
            instances: [{ browser: 'chromium' }],
            headless: !!process.env.CI,
          },
        },
      },
      // -- browser-no-webgpu layer: chromium WITHOUT WebGPU flags --
      //
      // feat-20260525-rhi-delete-webgl2-stub M4: verifies that when
      // navigator.gpu is absent (chromium launched without --enable-unsafe-webgpu),
      // createRenderer does NOT silently return a no-op renderer (old channel 4).
      // Acceptable outcomes: either channel 3 (rhi-wgpu wasm with internal
      // webgl backend) succeeds, OR createRenderer throws EngineEnvironmentError
      // (loud failure, not silent). File convention: *.browser-no-webgpu.test.ts.
      {
        plugins: [forgeaxShader()],
        test: {
          name: 'browser-no-webgpu',
          include: ['**/*.browser-no-webgpu.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.worktrees/**',
            '**/.claude/worktrees/**',
          ],
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: {
                channel: 'chrome-beta',
                args: ['--disable-features=WebGPU', '--disable-gpu-driver-bug-workarounds'],
              },
            }),
            instances: [{ browser: 'chromium' }],
            headless: !!process.env.CI,
          },
        },
      },
      // -- dawn layer: dawn.node native binding (AC-06) --
      //
      // The `**/*.dawn.test.ts` glob picks every dawn test under the repo,
      // but feat-20260511-rhi-wgpu-impl M4 (w24) also explicitly lists the
      // rhi-wgpu integration test path in the include array so the package
      // surface is grep-discoverable from this config file alone (charter
      // proposition 1 progressive disclosure: single-import / single-config
      // anchor lets AI users locate the dawn project participants without
      // walking the filesystem). feat-20260531-render-consume-global-transform-
      // hierarchy M3 (w13) likewise lists the transform-hierarchy AC-08
      // parent-moves-child-follows pixel-diff so `pnpm test:dawn` visibly
      // includes the visual-evidence path (the CI smoke step runs the
      // apps/hello/transform-hierarchy/scripts/smoke-dawn.mjs counterpart).
      {
        test: {
          name: 'dawn',
          environment: 'node',
          // Soft-GPU first-call flake mitigation (nightly #270 -> recurred #276):
          // on CI macos-arm64 / windows-latest the *first* dawn.node GPU call in a
          // file (e.g. createComputePipeline w08) intermittently exceeds the default
          // 5 s testTimeout while every other call returns in <200 ms (locally
          // 27/27 in ~140 ms, unreproducible). Raise the per-test budget and allow
          // two retries so a single cold-start stall no longer reds the gate; the
          // retry is harmless for the stable common case (no retry consumed when
          // the first attempt passes). Scoped to the dawn project only.
          testTimeout: 30000,
          retry: 2,
          include: [
            '**/*.dawn.test.ts',
            'packages/rhi-wgpu/src/__tests__/**/*.dawn.test.ts',
            'packages/runtime/src/__tests__/transform-hierarchy-pixel-diff.dawn.test.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.worktrees/**',
            '**/.claude/worktrees/**',
          ],
          setupFiles: ['./vitest.setup-webgpu.ts'],
        },
      },
    ],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // Exclude test fixtures, mocks, and generated build artifacts so the
      // global threshold reflects production source coverage. `__tests__/`
      // hosts vitest test files plus shared fixtures (`_arbs.ts` /
      // `_fixtures.ts` / `__mocks__/gpu-device.ts`); `wgpu-wasm/pkg/` is the
      // merged wasm-pack output (generated JS bindings, not hand-authored
      // source — feat-20260511-naga-rhi-wgpu-merge M1 productionised the
      // archived @forgeax/engine-naga-wasm-shim into this single bundle). Keeping
      // these inside the threshold pool penalised production-source
      // contributions disproportionately (charter proposition 4 explicit
      // failure: thresholds must measure the SUT, not its scaffolding).
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.mjs',
        '**/*.test-d.ts',
        '**/coverage/**',
        '**/wgpu-wasm/pkg/**',
        '**/scripts/**',
        '**/build.mjs',
        '**/vitest.config.ts',
        '**/tsup.config.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
  },
});
