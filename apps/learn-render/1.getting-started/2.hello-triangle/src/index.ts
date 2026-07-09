// apps/learn-render/1.getting-started/2.hello-triangle/src/index.ts
// LearnOpenGL section 1.2 - Hello Triangle (forgeax mapping).
//
// LO 1.2 covers `glGenVertexArrays + glGenBuffers + glBufferData + glDraw
// Arrays(GL_TRIANGLES, 0, 3)`. In forgeax the equivalent surface is a
// `world.spawn` with the builtin `HANDLE_TRIANGLE` mesh handle plus the
// 4-component unlit path (Transform / MeshFilter / MeshRenderer / Camera);
// no DirectionalLight because the LO 1.2 fragment shader is literally
// `FragColor = vec4(1.0, 0.5, 0.2, 1.0)` — flat orange, no lighting. The
// engine's v1 fragment shader (`PBR_FALLBACK_WGSL` in
// packages/runtime/src/createRenderer.ts) outputs `material.baseColor`
// directly, so `MeshRenderer.baseColor{R,G,B}` is the literal pixel color
// (charter proposition 5 consistent abstraction - the same factory +
// spawn idiom drives every learn-render example, LO 1.2 just lands the
// first visible triangle on top of the LO 1.1 baseline).
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO-specific configuration
//                                       (clear color, scene spawn, three
//                                       entities: triangle / camera /
//                                       directional light).
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06) so AI users locate the recipe via a single
//     `rg "// 1\. engine usage"` call across the seven learn-render
//     workspaces.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file; AI users read the 3 sections + the apps/hello/triangle
//     README cross-reference and have the full LO 1.2 -> forgeax picture.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; `await renderer.ready` returns a
//     `Result` whose `.ok === false` branch is logged via console.error
//     - we do not silently fall back to a console-only mode.
//   - P4 (consistent abstraction):  the same `Engine.create({ canvas,
//     clearColor })` factory + ECS spawn (Transform / MeshFilter /
//     MeshRenderer / Camera) is the entry across every learn-render
//     example; LO 1.2 just adds the visible triangle on top of the LO
//     1.1 baseline (LO §1.1 = clearColor only via the engine's clear-
//     pass-only frame path; Case E softening).

// 1. engine usage - the public Engine.create factory, the
// EngineEnvironmentError narrowing class, and the minimal ECS surface
// (World + Transform + Camera + MeshFilter + MeshRenderer + the triangle
// handle constant) needed to drive a single visible triangle frame. No
// DirectionalLight: LO 1.2 renders flat orange.
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  Engine,
  EngineEnvironmentError,
  HANDLE_TRIANGLE,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// 2. example-specific glue - LO 1.2 lands the first visible triangle.
// Color matches the LO 1.2 fragment shader literal
// `FragColor = vec4(1.0, 0.5, 0.2, 1.0)` (orange). The engine v1 frag
// shader outputs `material.baseColor` directly, so the MeshRenderer rgb
// is the on-screen pixel color (no light contribution). The clear color
// matches LO 1.1 / 1.3 teal so the captured frame is comparable across
// the seven learn-render examples.
function spawnTriangleScene(world: World): void {
  // Triangle entity (Transform + MeshFilter + MeshRenderer) at origin /
  // identity rotation / unit scale. Color = LO 1.2 frag literal orange
  // (1.0, 0.5, 0.2). metallic / roughness are unused on the engine v1
  // frag path (the fallback shader outputs baseColor directly) but the
  // schema requires the fields.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 0,
        posZ: 0,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
    {
      component: MeshRenderer,
      data: {},
    },
  );
  // Camera entity (Transform + Camera) at z=3 looking down -z (RH
  // identity quaternion convention). Frustum (fov 45 deg, aspect 1,
  // near 0.1, far 100) keeps the unit-scale triangle visible.
  world.spawn(
    {
      component: Transform,
      data: {
        posX: 0,
        posY: 0,
        posZ: 3,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );
}

// 3. bootstrap - locate the canvas the index.html document declares,
// hand it to Engine.create, await renderer.ready (the engine internal
// pipeline + RHI handshake), spawn the triangle scene, drive an rAF
// loop with `renderer.draw(world)`, expose a capture hook on globalThis
// for downstream readback paths, then log the resolved backend so the
// AI user can verify "WebGPU path live + triangle drawn" without
// opening DevTools.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error(
    "[learn-render 1.2 hello-triangle] missing <canvas id='app'> in index.html",
  );
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const renderer = await Engine.create(target, {}, forgeaxBundlerAdapter());
    renderer.onError((e) => {
      console.error('[learn-render 1.2 hello-triangle] renderer.onError:', e.code, e.hint);
      const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
      if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
    });
    const ready = await renderer.ready;
    if (!ready.ok) {
      console.error('[learn-render 1.2 hello-triangle] renderer.ready failed:', ready.error);
      return;
    }
    const world = new World();
    spawnTriangleScene(world);
    // rAF-driven render loop - one `renderer.draw(world)` per compositor
    // tick. The engine-internal RenderSystem walks the World query graph
    // (Extract / Prepare / Record three stages) and submits one GPU
    // command buffer per call (D-S2 / AC-09 - RenderSystem is NOT
    // registered to user schedule; renderer.draw(world) is the sole
    // invocation site).
    const tick = (): void => {
      const drawn = renderer.draw([world], { owner: 0 });
      if (!drawn.ok) {
        console.error('[learn-render 1.2 hello-triangle] draw failed:', drawn.error);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Capture hook for downstream readback paths (bench-screenshot
    // recorder, vitest browser smoke). Re-draws the world before
    // sampling so the canvas presents a fresh frame on every snapshot.
    // Body delegates to renderer.readPixels() (engine API since
    // 2026-05-17; AGENTS.md §Breaking changes) -- the recipe lives in
    // packages/runtime/src/createRenderer.ts now (architecture
    // principle 1 SSOT).
    type CaptureHook = () => Promise<Uint8Array>;
    const win = window as unknown as { __captureHelloTriangle?: CaptureHook };
    win.__captureHelloTriangle = async (): Promise<Uint8Array> => {
      renderer.draw([world], { owner: 0 });
      const r = await renderer.readPixels();
      if (!r.ok) throw new Error(`[learn-render 1.2 hello-triangle] readPixels failed: ${r.error.code} -- ${r.error.hint ?? ''}`);
      return r.value;
    };
    console.warn(`[learn-render 1.2 hello-triangle] backend=${renderer.backend}`);
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      console.error('[learn-render 1.2 hello-triangle] no usable backend:', err);
    } else {
      console.error('[learn-render 1.2 hello-triangle] bootstrap error:', err);
    }
  }
}
