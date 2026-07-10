import type { ResolveContext } from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder, TextureView } from '@forgeax/engine-rhi';
import { buildBeginRenderPassDescriptor } from '../pipeline-spec';
import type { _InternalRenderPipelineContext } from '../render-pipeline-context';
import { getOrCreateFromChain } from './mesh-ssbo';

/**
 * feat-20260531-skybox-env-background M2 / w8: skybox pass recording stub.
 * Renders a fullscreen triangle that samples a cubemap using the camera's
 * inverseViewProj from the View UBO and writes the result to the hdrColor
 * render target. The pass runs after shadow and before main (D-1 topology).
 *
 * This stub early-returns when skyboxActive is false -- the actual execute
 * body is implemented in M3 / w16 (recordSkyboxPass execute). The render-
 * graph still declares the pass so the compile() step validates the
 * dependency edges (shadow -> skybox -> main) even before the execute
 * body is filled in.
 */
export function recordSkyboxPass(c: _InternalRenderPipelineContext): void {
  // Early-return when skybox is not active (no SkyboxBackground entity,
  // or tonemap is disabled -- plan-strategy D-2 NOTE). The graph still
  // compiles because the pass declaration is unconditional; only the
  // execute body is gated on skyboxActive.
  if (!c.skyboxActive) return;
  const skyboxSnapshot = c.skybox;
  if (skyboxSnapshot === undefined) return;

  const { runtime, store, encoder, pipelineState } = c;

  // Guard: hdrColorView must be allocated (tonemapActive implies it)
  const hdrColorView = pipelineState.perPassResources.hdrColorView;
  if (hdrColorView === null) return;

  // feat-20260604 M2 / w10: under MSAA the skybox + main passes share the
  // count=4 multisample target (hdrColorMsaa); only the main pass (last to
  // write) resolves to the single-sample hdrColor (D-8 -- avoids a wasteful
  // mid-chain resolve). The skybox pass writes the multisample target with no
  // resolveTarget and uses the count=4 skybox pipeline variant.
  const skyboxColorView = c.msaaActive
    ? pipelineState.perPassResources.hdrColorMsaaView
    : hdrColorView;
  if (skyboxColorView === null) return;

  // Guard: pipeline resources must exist (null when manifest has no
  // skybox entry -- legacy manifests continue to boot)
  const skyboxPipeline = c.msaaActive
    ? pipelineState.perPassResources.skyboxPipelineMsaa
    : pipelineState.perPassResources.skyboxPipeline;
  const skyboxBgl = pipelineState.perPassResources.skyboxBindGroupLayout;
  const skyboxSampler = pipelineState.perPassResources.skyboxSampler;
  if (skyboxPipeline === null || skyboxBgl === null || skyboxSampler === null) return;

  // Resolve cubemap GPU view from AssetRegistry. Returns undefined if
  // the cubemap has not been uploaded yet (async equirect upload in
  // progress). In that case, degradation to main pass loadOp:'clear'
  // is handled by the passCtx.skyboxActive gate above -- if the
  // cubemap isn't ready, skyboxActive is already false (see w18).
  // biome-ignore lint/suspicious/noExplicitAny: branded Handle cast from raw number
  const cubemapView = store.getCubemapGpuView(skyboxSnapshot.equirectHandle as any);
  if (cubemapView === undefined) return;

  // Identity-cached skybox BindGroup keyed on the cubemap GpuView. The only
  // varying binding is the cubemap view (sampler + View UBO are stable); it is
  // recreated on each internal equirect-to-cubemap projection (which may happen
  // mid-app asynchronously), so keying on its identity rebuilds exactly when the
  // cubemap changes. This supersedes the prior `hdrTextureWidth`/`Height`
  // size-guard, which tracked the wrong resource (the skybox BindGroup never
  // binds hdrColor -- it writes the color attachment) and missed cubemap
  // re-projections that reused the old cached bind group.
  const skyboxBg = getOrCreateFromChain(
    c.frameState.postProcessBgCache,
    [cubemapView as unknown as object],
    'skybox',
    () => {
      const skyboxBgRes = runtime.device.createBindGroup({
        label: 'skybox-bg',
        layout: skyboxBgl,
        entries: [
          {
            binding: 0,
            resource: { kind: 'textureView', value: cubemapView },
          },
          {
            binding: 1,
            resource: { kind: 'sampler', value: skyboxSampler },
          },
          {
            binding: 2,
            resource: {
              kind: 'buffer',
              value: { buffer: pipelineState.viewUniformBuffer },
            },
          },
        ],
      });
      if (!skyboxBgRes.ok) throw skyboxBgRes.error;
      return skyboxBgRes.value;
    },
    c.bindGroupCounts,
  );

  // Skybox pass: clear hdrColor (first pass writing to it),
  // draw fullscreen triangle, write cubemap colour.
  // No depth/stencil -- skybox is the far plane; main pass depth test rejects
  // occluded skybox pixels (plan-strategy D-1). HDR target ('rgba16float') is
  // declared on specAttachments for descriptor parity, even though color-only
  // policies do not gate on format.
  const skyboxPass = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [skyboxColorView] },
      'skybox',
    ) as never,
  );

  skyboxPass.setPipeline(skyboxPipeline);
  skyboxPass.setBindGroup(0, skyboxBg);
  skyboxPass.draw(3);
  skyboxPass.end();
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13c: FXAA post-process
 * fullscreen pass, extracted verbatim from recordFrame. copyTextureToTexture
 * (swap-chain -> intermediate) then a fullscreen FXAA fragment pass writes
 * the anti-aliased result back into the swap-chain view, all on the SHARED
 * frame encoder (c.encoder). The pre-pass copy stays inside this closure
 * (graph first version models copy as a pass-internal op, not a separate
 * graph node). Gated on camera.antialias==='fxaa'. Driven by the 'fxaa'
 * graph pass.
 */
// ── feat-20260531-bloom-first-declarative-render-graph-pass / w14 ──
// Bloom execute closure placeholders. Real implementations in w15.
// The graph must declare execute callbacks for addPass; these empty stubs
// keep compile() satisfied until w15 fills in the actual record logic.
//
// Gate: bloom === 'off' || !tonemapActive => early-return (AC-04/AC-05).
// The closures receive RenderPipelineContext and route to w15 record functions.

export function recordBloomBrightPass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const { runtime, pipelineState, encoder, camera, tonemapActive, frameState, bindGroupCounts } =
    _c;
  const pp = pipelineState.perPassResources;

  // Double gate: bloom=off => zero-overhead; tonemap=none => no HDR domain
  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomBrightPipeline === null ||
    pp.bloomBrightBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomBrightParamsBuffer === null
  )
    return;

  // M1 / w7: bloom intermediate textures owned by render-graph. Resolve
  // the GPU TextureView via the resolve context passed by graph.execute().
  const bloomBrightView = resolve?.resolve('bloomBright') as TextureView | undefined;
  const hdrColorView = resolve?.resolve('hdrColor') as TextureView | undefined;
  if (!bloomBrightView || !hdrColorView) return;
  const bglBright = pp.bloomBrightBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const paramsBuffer = pp.bloomBrightParamsBuffer;

  // 2. Write threshold UBO (16 B std140: threshold f32 + 12 B pad).
  const brightParams = new Float32Array(4);
  brightParams[0] = camera.bloomThreshold;
  brightParams[1] = 0;
  brightParams[2] = 0;
  brightParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(paramsBuffer, 0, brightParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 3. Identity-cached BindGroup (1 tex + 1 sampler + 1 UBO). Keyed on the
  // graph-resolved hdrColor TextureView: resize retires hdrColor and the new
  // view yields a WeakMap miss -> rebuild referencing the live texture.
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [hdrColorView as unknown as object],
    'bloom-bright',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'bloom-bright-bg',
        layout: bglBright,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: hdrColorView } },
          { binding: 1, resource: { kind: 'sampler', value: bloomSampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: paramsBuffer } } },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    bindGroupCounts,
  );

  // 4. Render pass into the 1/2-res intermediate.
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [bloomBrightView] },
      'bloom-bright',
    ) as never,
  );
  pass.setPipeline(pp.bloomBrightPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordBloomBlurHPass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const {
    runtime,
    pipelineState,
    encoder,
    camera,
    targetW,
    tonemapActive,
    frameState,
    bindGroupCounts,
  } = _c;
  const pp = pipelineState.perPassResources;

  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomBlurHPipeline === null ||
    pp.bloomBlurBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomBlurHParamsBuffer === null
  )
    return;

  // M1 / w7: bloom intermediate textures owned by render-graph. Resolve
  // via the resolve context passed by graph.execute().
  const bloomBlurHView = resolve?.resolve('bloomBlurH') as TextureView | undefined;
  const bloomBrightView = resolve?.resolve('bloomBright') as TextureView | undefined;
  if (!bloomBlurHView || !bloomBrightView) return;
  const bglBlur = pp.bloomBlurBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const paramsBuffer = pp.bloomBlurHParamsBuffer;

  // 2. Write H-axis blur params into the H-only UBO (bug-20260625: a separate
  // buffer per axis so V's write cannot clobber H's before the GPU runs).
  // H-axis: texel offset along x only.
  const bw = Math.floor(targetW / 2);
  const blurParams = new Float32Array(4);
  blurParams[0] = bw > 0 ? 1.0 / bw : 1.0; // texelSize.x
  blurParams[1] = 0; // texelSize.y = 0 for H pass
  blurParams[2] = camera.bloomBlurRadius;
  blurParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(paramsBuffer, 0, blurParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 3. Identity-cached BindGroup (reads bloomBright from graph). Keyed on the
  // graph-resolved bloomBright view so resize rebuilds against the new texture.
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [bloomBrightView as unknown as object],
    'bloom-blur-h',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'bloom-blur-h-bg',
        layout: bglBlur,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: bloomBrightView } },
          { binding: 1, resource: { kind: 'sampler', value: bloomSampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: paramsBuffer } } },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    bindGroupCounts,
  );

  // 4. Render pass into bloomBlurH intermediate (graph-owned).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [bloomBlurHView] },
      'bloom-blur',
    ) as never,
  );
  pass.setPipeline(pp.bloomBlurHPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordBloomBlurVPass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const {
    runtime,
    pipelineState,
    encoder,
    camera,
    targetH,
    tonemapActive,
    frameState,
    bindGroupCounts,
  } = _c;
  const pp = pipelineState.perPassResources;

  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomBlurVPipeline === null ||
    pp.bloomBlurBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomBlurVParamsBuffer === null
  )
    return;

  // M1 / w7: bloom intermediate textures owned by render-graph. Resolve
  // via the resolve context passed by graph.execute().
  const bloomBlurVView = resolve?.resolve('bloomBlurV') as TextureView | undefined;
  const bloomBlurHView = resolve?.resolve('bloomBlurH') as TextureView | undefined;
  if (!bloomBlurVView || !bloomBlurHView) return;
  const bglBlur = pp.bloomBlurBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const paramsBuffer = pp.bloomBlurVParamsBuffer;

  // 2. Write V-axis blur params into the V-only UBO (bug-20260625: separate
  // buffer per axis -- see the H pass comment).
  // V-axis: texel offset along y only.
  const bh = Math.floor(targetH / 2);
  const blurParams = new Float32Array(4);
  blurParams[0] = 0; // texelSize.x = 0 for V pass
  blurParams[1] = bh > 0 ? 1.0 / bh : 1.0; // texelSize.y
  blurParams[2] = camera.bloomBlurRadius;
  blurParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(paramsBuffer, 0, blurParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 3. Identity-cached BindGroup (reads bloomBlurH from graph). Keyed on the
  // graph-resolved bloomBlurH view so resize rebuilds against the new texture.
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [bloomBlurHView as unknown as object],
    'bloom-blur-v',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'bloom-blur-v-bg',
        layout: bglBlur,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: bloomBlurHView } },
          { binding: 1, resource: { kind: 'sampler', value: bloomSampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: paramsBuffer } } },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    bindGroupCounts,
  );

  // 4. Render pass into bloomBlurV intermediate (graph-owned).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [bloomBlurVView] },
      'bloom-blur',
    ) as never,
  );
  pass.setPipeline(pp.bloomBlurVPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordBloomCompositePass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const { runtime, pipelineState, encoder, camera, tonemapActive, frameState, bindGroupCounts } =
    _c;
  const pp = pipelineState.perPassResources;

  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomCompositePipeline === null ||
    pp.bloomCompositeBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomCompositeParamsBuffer === null
  )
    return;

  // M1 / w7: hdrColor + bloomBlurV textures owned by render-graph.
  // bug-20260625: composite READS hdrColor (scene, binding 0) and WRITES the
  // separate hdrComposited target -- never the same texture in one pass.
  const hdrColorView = resolve?.resolve('hdrColor') as TextureView | undefined;
  const bloomBlurVView = resolve?.resolve('bloomBlurV') as TextureView | undefined;
  const hdrCompositedView = resolve?.resolve('hdrComposited') as TextureView | undefined;
  if (!hdrColorView || !bloomBlurVView || !hdrCompositedView) return;
  const bglComposite = pp.bloomCompositeBindGroupLayout;
  const bloomSampler = pp.bloomSampler;
  const paramsBuffer = pp.bloomCompositeParamsBuffer;

  // 1. Write composite params UBO (16 B std140: intensity + 12 B pad).
  const compositeParams = new Float32Array(4);
  compositeParams[0] = camera.bloomIntensity;
  compositeParams[1] = 0;
  compositeParams[2] = 0;
  compositeParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(paramsBuffer, 0, compositeParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 2. Identity-cached BindGroup (2 tex: hdrColor + bloomBlurV, 1 sampler,
  // 1 UBO). Keys on both sampled views: resize retires both hdrColor and
  // bloomBlurV, so a two-node chain rebuilds when either identity changes.
  const bindGroup = getOrCreateFromChain(
    frameState.postProcessBgCache,
    [hdrColorView as unknown as object, bloomBlurVView as unknown as object],
    'bloom-composite',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'bloom-composite-bg',
        layout: bglComposite,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: hdrColorView } },
          { binding: 1, resource: { kind: 'textureView', value: bloomBlurVView } },
          { binding: 2, resource: { kind: 'sampler', value: bloomSampler } },
          {
            binding: 3,
            resource: { kind: 'buffer', value: { buffer: paramsBuffer } },
          },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    bindGroupCounts,
  );

  // 3. Render pass: write the separate hdrComposited target (bug-20260625).
  // The fragment shader outputs the COMPLETE composited colour
  // (scene + intensity*bloom, sampling scene from hdrColor itself), so the
  // destination needs no prior content -> loadOp='clear' (no stale dependency
  // on hdrComposited's previous-frame content, and no in-place hazard).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [hdrCompositedView] },
      'bloom-composite',
      { colorLoadOp: 'clear' },
    ) as never,
  );
  pass.setPipeline(pp.bloomCompositePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordFxaaPass(c: _InternalRenderPipelineContext): void {
  const { runtime, pipelineState, encoder, camera, targetW, targetH, currentTexture } = c;
  // feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / w14:
  // refactored to use FullscreenPostProcessPass primitive. The FXAA pass
  // reads the swap-chain (via copyTextureToTexture -> fxaaIntermediate),
  // then executes a fullscreen FXAA fragment pass that writes the
  // anti-aliased result back into the swap-chain non-srgb storage view
  // (R-COLORSPACE: source is already sRGB-encoded; writing through srgb
  // view would double-encode — see color-space contract below).
  //
  // D-1 copy approach: encoder.copyTextureToTexture from swap-chain to
  // graph-owned fxaaIntermediate, then FXAA pass writes swap-chain.
  const fxaaActive = camera.antialias === 'fxaa';
  if (
    fxaaActive &&
    pipelineState.perPassResources.fxaaPipeline !== null &&
    pipelineState.perPassResources.fxaaBindGroupLayout !== null &&
    pipelineState.perPassResources.fxaaSampler !== null &&
    pipelineState.perPassResources.fxaaIntermediateTexture !== null &&
    pipelineState.perPassResources.fxaaIntermediateView !== null
  ) {
    // Copy swap-chain content to the graph-owned fxaaIntermediate texture.
    const swapTex = currentTexture as never;
    encoder.copyTextureToTexture(
      { texture: swapTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      {
        texture: pipelineState.perPassResources.fxaaIntermediateTexture as never,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: 0 },
      },
      { width: targetW, height: targetH, depthOrArrayLayers: 1 },
    );

    // Compose the 2-entry FXAA BindGroup (input texture + sampler). The
    // primitive resolves both through the pre-built BGL/sampler stored in
    // perPassResources (built once in createRenderer's ready phase). The bind
    // group is identity-cached on the graph-owned fxaaIntermediate view: on
    // resize the graph retires the old intermediate texture and the writeback
    // installs a new view, so the WeakMap key changes -> rebuild against the
    // live texture (D-3: physical texture identity invalidation). The prior
    // `=== null` single-slot cache never rebuilt and submitted a destroyed
    // texture after resize.
    const fxaaBglLayout = pipelineState.perPassResources.fxaaBindGroupLayout;
    const fxaaSampler = pipelineState.perPassResources.fxaaSampler;
    const fxaaIntermediateView = pipelineState.perPassResources.fxaaIntermediateView;
    const fxaaBg = getOrCreateFromChain(
      c.frameState.postProcessBgCache,
      [fxaaIntermediateView as object],
      'fxaa',
      () => {
        const fxaaBgRes = runtime.device.createBindGroup({
          label: 'fxaa-bg',
          layout: fxaaBglLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'textureView',
                value: fxaaIntermediateView,
              },
            },
            {
              binding: 1,
              resource: { kind: 'sampler', value: fxaaSampler },
            },
          ],
        });
        if (!fxaaBgRes.ok) throw fxaaBgRes.error;
        return fxaaBgRes.value;
      },
      c.bindGroupCounts,
    );

    // R-COLORSPACE: write through the swap-chain's non-srgb storage view
    // (bgra8unorm). FXAA's source is ALREADY sRGB-encoded (verbatim copy
    // of swap-chain, sampled through non-srgb view → no decode). The shader
    // works in gamma space and emits sRGB-encoded values — writing through
    // the srgb view would double-encode and brighten every pixel.
    const fxaaStorageViewRes = runtime.device.createTextureView(currentTexture, {});
    if (!fxaaStorageViewRes.ok) {
      runtime.errorRegistry.fire(fxaaStorageViewRes.error);
      return;
    }
    const fxaaPass: RhiRenderPassEncoder = encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['bgra8unorm'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [fxaaStorageViewRes.value] },
        'fxaa',
      ) as never,
    );
    fxaaPass.setPipeline(pipelineState.perPassResources.fxaaPipeline);
    fxaaPass.setBindGroup(0, fxaaBg);
    fxaaPass.draw(3, 1, 0, 0);
    fxaaPass.end();
  }
}
