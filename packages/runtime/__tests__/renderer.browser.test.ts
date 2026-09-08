// renderer.browser.test.ts - vitest browser project (AC-05) RHI/engine
// API integration test.
//
// Trigger: root vitest.config.ts `browser` project (`*.browser.test.ts`
// glob). Environment: playwright provider chromium instance (v4 form:
// provider: playwright() factory + instances:[{browser:'chromium'}]).
//
// Scope (M2.4 / w11 acceptanceCheck):
//   (a) `createRenderer({ canvas })` constructs the WebGPU pipeline
//   (b) `draw(world)` records 1 frame
//   (c) assert `renderer.inspect().capabilities.backendKind === 'webgpu'`
//       (the WebGPU path is active; charter proposition 5 consistent
//       abstraction)
//
// Note: v4 imports go through `vitest/browser` (not the v3
// `@vitest/browser/context`). Inside the browser, chromium must launch
// with the WebGPU flag (CI injects via ci.yml; on local dev without the
// flag this case will skip / fail - in a fully-equipped CI environment
// this case PASSES, AC-05 is delivered).

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { afterEach, describe, expect, it } from 'vitest';

import { createRenderer } from '../src/createRenderer';

describe('renderer.browser - WebGPU path RHI contract (AC-05)', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;

  afterEach(() => {
    renderer = undefined;
    canvas = undefined;
  });

  it('createRenderer({ canvas }) takes the WebGPU path and can draw 1 frame', async () => {
    // (a) prepare a real canvas (vitest browser project runs inside
    // chromium with full DOM API).
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    // pre-check: navigator.gpu must be available inside chromium. If it
    // is not (chromium flags missing / old version), this test fails with
    // an explicit reason (charter proposition 4 explicit failure: silent
    // fallback to webgl2 must not turn AC-05 into a false green).
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[renderer.browser] code: 'webgpu-unavailable'; hint: WebGPU is not enabled in this browser; ci.yml injects via chrome stable channel + --enable-unsafe-webgpu --enable-features=Vulkan; on local dev use chrome --enable-unsafe-webgpu",
      );
    }

    // (a) createRenderer - async factory. Inject empty shader manifest via
    // `data:` URL: vitest browser dev server has no `/shaders/manifest.json`
    // mount (that path is only served by hello-cube / hello-triangle's
    // `@forgeax/engine-vite-plugin-shader generateBundle` hook). Default would
    // fetch an empty body and ShaderRegistry rejects with
    // `manifest-malformed`. `fetch()` accepts data URLs (WHATWG) and an
    // empty `entries: []` is a valid manifest schema.
    const created = await createRenderer(canvas, {}, { shaderManifestUrl: 'data:application/json,{"entries":[]}' });
    if (!created.ok) throw created.error;
    renderer = created.value;

    // (c) inspect the bounded capability POD; backend is not a second public
    // Renderer field.
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

    // (b) draw 1 frame: pass an empty World. D-S2 RenderSystem reports
    // 'render-system-no-camera' through onError but draw itself returns
    // void.
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    world.update(1 / 60).unwrap();
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);
  });
});
