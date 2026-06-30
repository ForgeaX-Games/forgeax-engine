// TextureViewer.test.tsx — TextureViewer component test (w29).
//
// Tests:
//   1. Thumbnail list includes color RTs, depth-stencil, and bound textures.
//   2. Per-texture status badge renders correct text for each variant.
//   3. Clicking a different thumbnail switches preview (DOM-level, no GPU).
//   4. Non-draw selection shows default text.
//
// GPU functions (readbackTexturePixels etc.) are never invoked in jsdom.
// The test verifies DOM structure from the pure-React rendering path.
//
// Related: requirements AC-16/AC-18/AC-26; plan-strategy 5.1/5.2.

import type { RhiCallEvent, Tape } from '@forgeax/engine-rhi-debug';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextureViewer } from '../components/TextureViewer';
import { SelectionContext } from '../selection-context';
import { TapeContext, ViewModelContext } from '../viewer-context';
import type { ViewModel } from '../viewer-model';

const mockProps = {
  api: {},
  containerApi: {},
  params: {},
  group: {},
  isActive: true,
  isVisible: true,
} as unknown as Parameters<typeof TextureViewer>[0];

function makeSelection(overrides: { selectedDrawIdx?: number; selectedCommandIdx?: number } = {}) {
  return {
    selectedDrawIdx: overrides.selectedDrawIdx ?? -1,
    selectedCommandIdx: overrides.selectedCommandIdx ?? -1,
    setSelectedDrawIdx: () => {},
    setSelectedCommandIdx: () => {},
  } as const;
}

function mockViewModel(): ViewModel {
  return {
    tree: [
      {
        kind: 'render',
        passIdx: 0,
        draws: [{ drawIdx: 0, eventKind: 'draw' as const }],
      },
    ],
    draws: [
      {
        frameIdx: 0,
        passIdx: 0,
        bindings: [
          { groupIndex: 0, entryIndex: 0, handleId: 'tex-1', kind: 'texture' as const },
          { groupIndex: 0, entryIndex: 1, handleId: 'sampler-1', kind: 'sampler' as const },
        ],
        drawCall: { pipelineKind: 'render', pipelineHandleId: 'pipe-1' },
        colorAttachmentHandleId: 'rt-0',
        pipelineState: {
          inputAssembly: { topology: 'triangle-list', stripIndexFormat: undefined },
          vertexInput: { buffers: [] },
          shaders: {
            vertexShaderModuleHandleId: undefined,
            fragmentShaderModuleHandleId: undefined,
          },
          rasterizer: { cullMode: 'none' as const, frontFace: 'ccw' as const },
          depthStencil: {
            format: 'depth24plus' as const,
            depthWriteEnabled: true,
            depthCompare: 'less' as const,
            stencilFront: {
              compare: 'always' as const,
              failOp: 'keep' as const,
              depthFailOp: 'keep' as const,
              passOp: 'keep' as const,
            },
            stencilBack: {
              compare: 'always' as const,
              failOp: 'keep' as const,
              depthFailOp: 'keep' as const,
              passOp: 'keep' as const,
            },
            stencilReadMask: 0xffffffff,
            stencilWriteMask: 0xffffffff,
            depthBias: 0,
            depthBiasSlopeScale: 0,
            depthBiasClamp: 0,
            stencilReference: 0,
          },
          blend: {
            colorTargets: [
              { format: 'rgba8unorm' as const, color: undefined, alpha: undefined, writeMask: 0xf },
            ],
            blendConstant: undefined,
          },
          multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
        },
        vertexBuffers: new Map(),
        depthStencil: {
          depthStencilViewHandleId: 'ds-0',
          depthStencilAttachment: {
            depthClearValue: 0,
            depthLoadOp: 'clear' as const,
            depthStoreOp: 'store' as const,
            stencilLoadOp: 'clear' as const,
            stencilStoreOp: 'store' as const,
          } as GPURenderPassDepthStencilAttachment,
        },
      },
    ],
    meta: { totalDraws: 1, totalPasses: 1, hasCompute: false },
    commands: [
      {
        passIdx: 0,
        eventIdx: 0,
        isDraw: true,
        kind: 'draw',
        groupLabel: undefined,
        markerLabel: undefined,
      },
    ],
    resources: new Map(),
  };
}

/**
 * Build a minimal Tape whose `tex-1` bound texture resolves to a createTexture of
 * the given format/dimension. The mock draw's binding handleId is `tex-1` (a direct
 * texture handle, no view event), so resolveTextureDescriptor finds it by handleId.
 *
 * `arrayLayers` sets the source texture's depthOrArrayLayers (slice count); it is
 * used to drive the slice selector for cube-array / 2d-array textures.
 */
function tapeWithBoundTexture(
  format: string,
  dimension: '2d' | 'cube' | '2d-array' | 'cube-array' = '2d',
  arrayLayers = dimension === 'cube' || dimension === 'cube-array' ? 6 : 1,
): Tape {
  const events: RhiCallEvent[] = [
    {
      kind: 'createTexture',
      handleId: 'tex-1',
      desc: { size: [64, 64, 1], format, dimension: '2d', usage: 0x14 },
    } as RhiCallEvent,
  ];
  // Non-2d is expressed via a view over the texture (view dimension wins). The
  // source texture carries the real array layer count.
  if (dimension !== '2d') {
    events[0] = {
      kind: 'createTexture',
      handleId: 'src-1',
      desc: { size: [64, 64, arrayLayers], format, dimension: '2d', usage: 0x14 },
    } as RhiCallEvent;
    events.push({
      kind: 'createTextureView',
      sourceHandleId: 'src-1',
      resultHandleId: 'tex-1',
      desc: { dimension },
    } as RhiCallEvent);
  }
  return {
    formatVersion: 1,
    rhiCapsRecorded: {} as Tape['rhiCapsRecorded'],
    events,
    blobPool: new Map(),
  };
}

function renderWithTape(vm: ViewModel, tape: Tape, selectedDrawIdx = 0) {
  return render(
    <ViewModelContext.Provider value={vm}>
      <TapeContext.Provider value={tape}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </TapeContext.Provider>
    </ViewModelContext.Provider>,
  );
}

/** Locate the bound-texture (`Texture tex-1`) thumbnail element. */
function boundThumb(container: HTMLElement): Element | undefined {
  return Array.from(container.querySelectorAll('[data-forgeax-texture-thumbnail]')).find((el) =>
    el.textContent?.includes('Texture tex-1'),
  );
}

// --------------- bound-texture format resolution + previewability ---------------

describe('bound-texture format resolution', () => {
  it('resolves the real createTexture format (not hard-coded unknown)', () => {
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('rgba8unorm'));
    const thumb = boundThumb(container);
    expect(thumb).toBeDefined();

    // Select the bound-texture thumbnail so the main preview shows its format.
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: rgba8unorm');
    expect(container.textContent).not.toContain('format: unknown');
  });

  it('a previewable 2D rgba8unorm bound texture does not show the fallback message', () => {
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('rgba8unorm'));
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    // jsdom has no WebGPU, so the optimistic status seeds 'no-webgpu' (not the
    // honest "not directly previewable" fallback used for non-2D/non-8bit formats).
    expect(container.textContent).not.toContain('not directly previewable');
  });

  it('a 3D bound texture shows the honest not-previewable fallback', () => {
    // 2d-array / cube are now previewable; a 3d view is not in SLICEABLE_DIMENSIONS.
    const tape3d = tapeWithBoundTexture('rgba8unorm', '2d-array');
    (tape3d.events[1] as { desc: { dimension: string } }).desc.dimension = '3d';
    const { container } = renderWithTape(mockViewModel(), tape3d);
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('not directly previewable');
  });

  it('a float-format bound texture (r32float) is now previewable (host decode, no fallback)', () => {
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('r32float'));
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: r32float');
    // Any uncompressed color format is decoded to RGBA8 on the host now, so it
    // must NOT show the honest "not directly previewable" fallback.
    expect(container.textContent).not.toContain('not directly previewable');
  });

  it('an HDR rgba16float cube bound texture is previewable (host decode, no fallback)', () => {
    const { container } = renderWithTape(
      mockViewModel(),
      tapeWithBoundTexture('rgba16float', 'cube'),
    );
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: rgba16float');
    expect(container.textContent).not.toContain('not directly previewable');
  });

  it('a compressed bc7 bound texture still shows the honest not-previewable fallback', () => {
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('bc7-rgba-unorm'));
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: bc7-rgba-unorm');
    // Compressed formats have no formatInfo entry -> no host decode -> fallback.
    expect(container.textContent).toContain('not directly previewable');
  });

  it('a 2D depth32float bound texture is previewable (no fallback) via the depth path', () => {
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('depth32float'));
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: depth32float');
    // A 2D depth texture routes through readbackDepthAuto (grayscale), so it must
    // NOT show the honest "not directly previewable" fallback — same as color.
    expect(container.textContent).not.toContain('not directly previewable');
  });

  it('a 2D depth24plus-stencil8 bound texture is previewable (blit depth path)', () => {
    const { container } = renderWithTape(
      mockViewModel(),
      tapeWithBoundTexture('depth24plus-stencil8'),
    );
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: depth24plus-stencil8');
    expect(container.textContent).not.toContain('not directly previewable');
  });

  it('a cube-array depth32float bound texture is previewable (no fallback)', () => {
    const { container } = renderWithTape(
      mockViewModel(),
      tapeWithBoundTexture('depth32float', 'cube-array', 12),
    );
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(container.textContent).toContain('format: depth32float');
    expect(container.textContent).not.toContain('not directly previewable');
  });

  it('the preview canvas fills the viewport in fit mode (upscales small textures)', () => {
    // Regression lock for the "Fit does nothing on a 1x1 texture" report: fit mode
    // must size the canvas element to the container (w-full h-full) so object-contain
    // UPSCALES a tiny bitmap. The old `max-w-*` fit left a 1px texture at 1px. jsdom
    // can't lay out CSS, but the className branch keys on the default zoom='fit', so we
    // assert the class string regardless of WebGPU availability.
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('rgba8unorm'));
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    const canvas = container.querySelector('canvas[data-forgeax-rt-canvas]');
    expect(canvas).not.toBeNull();
    const cls = canvas?.getAttribute('class') ?? '';
    expect(cls).toContain('w-full');
    expect(cls).toContain('h-full');
    expect(cls).toContain('object-contain');
    // The buggy fit used max-w-full/max-h-full, which never upscales — must be gone.
    expect(cls).not.toContain('max-w-full');
    expect(cls).not.toContain('max-h-full');
  });
});

// --------------- bound-texture slice selector (cube / cube-array / 2d-array) ---------------

/** Locate the slice <select> in the preview header. */
function sliceSelect(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>('[data-forgeax-texture-slice]');
}

describe('bound-texture slice selector', () => {
  it('a plain 2D texture shows NO slice selector', () => {
    const { container } = renderWithTape(mockViewModel(), tapeWithBoundTexture('rgba8unorm'));
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    expect(sliceSelect(container)).toBeNull();
  });

  it('a cube texture shows a 6-option face-named selector (+X..-Z)', () => {
    const { container } = renderWithTape(
      mockViewModel(),
      tapeWithBoundTexture('rgba8unorm', 'cube'),
    );
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    const sel = sliceSelect(container);
    expect(sel).not.toBeNull();
    const opts = Array.from(sel?.options ?? []).map((o) => o.textContent);
    expect(opts).toEqual(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
  });

  it('a cube-array texture labels slices "L{layer} {face}"', () => {
    const { container } = renderWithTape(
      mockViewModel(),
      tapeWithBoundTexture('depth32float', 'cube-array', 12),
    );
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    const sel = sliceSelect(container);
    expect(sel).not.toBeNull();
    expect(sel?.options.length).toBe(12);
    expect(sel?.options[0]?.textContent).toBe('L0 +X');
    expect(sel?.options[6]?.textContent).toBe('L1 +X');
    expect(sel?.options[11]?.textContent).toBe('L1 -Z');
  });

  it('a 2d-array texture labels slices "Layer N"', () => {
    const { container } = renderWithTape(
      mockViewModel(),
      tapeWithBoundTexture('rgba8unorm', '2d-array', 3),
    );
    const thumb = boundThumb(container);
    if (thumb) fireEvent.click(thumb);
    const sel = sliceSelect(container);
    expect(sel).not.toBeNull();
    const opts = Array.from(sel?.options ?? []).map((o) => o.textContent);
    expect(opts).toEqual(['Layer 0', 'Layer 1', 'Layer 2']);
  });
});

// --------------- AC-16: thumbnail list + per-texture status badge ---------------

describe('AC-16: thumbnail list rendering', () => {
  it('renders thumbnails for color RT, depth-stencil, and bound textures', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // The container should have texture-viewer anchor set to 'selected'
    const el = container.querySelector('[data-forgeax-texture-viewer]');
    expect(el?.getAttribute('data-forgeax-texture-viewer')).toBe('selected');

    // Thumbnails should include color RT and depth
    expect(container.textContent).toContain('Color RT 0');
    expect(container.textContent).toContain('Depth');

    // Bound texture (tex-1 of kind 'texture') should appear
    expect(container.textContent).toContain('Texture tex-1');
  });

  it('each thumbnail has a status badge', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // All textures in this fixture should have 'ok' status
    const badges = container.querySelectorAll('[data-forgeax-texture-thumbnail] span');
    const okBadges = Array.from(badges).filter((b) => b.textContent?.includes('ok'));
    expect(okBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('data-forgeax-texture-thumbnail anchors are present on thumbnails', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const thumbs = container.querySelectorAll('[data-forgeax-texture-thumbnail]');
    expect(thumbs.length).toBeGreaterThanOrEqual(2);
    // Verify they have numeric index values
    expect(thumbs[0]?.getAttribute('data-forgeax-texture-thumbnail')).toBe('0');
  });
});

// --------------- AC-18: per-texture status badge renders correct text ---------------

describe('AC-18: per-texture status badge', () => {
  it('status badges are rendered with correct text for ok status', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Status badges should contain 'ok' text
    expect(container.textContent).toMatch(/ok/);
  });

  it('depth attachment with depth24plus is now previewable (blit) — NOT error', () => {
    // Behavior change: depth24plus's depth plane is non-copyable, but it is now
    // previewed via the depth-sampling blit (blitDepthToR32), so its thumbnail no
    // longer carries the 'error' badge. (Previously it degraded to 'error' since
    // there was no readback path.) The optimistic status seeds ok/no-webgpu.
    const vm = mockViewModel(); // fixture's depthStencil.format = 'depth24plus'

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const depthThumb = Array.from(
      container.querySelectorAll('[data-forgeax-texture-thumbnail]'),
    ).find((el) => el.textContent?.includes('Depth'));
    expect(depthThumb).toBeDefined();
    expect(depthThumb?.textContent).not.toMatch(/error/);
  });

  it('main preview area shows selected texture info', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Main preview area should show the initially selected (first) thumbnail's info
    expect(container.textContent).toContain('Color RT 0');
    expect(container.textContent).toContain('format');
  });
});

// --------------- depth-stencil split into Depth + Stencil thumbnails ---------------

/** Clone the mock with a specific depth-stencil format. */
function mockViewModelWithDepthFormat(format: string): ViewModel {
  const vm = mockViewModel();
  const draw = vm.draws[0];
  if (!draw) throw new Error('mock has no draw');
  const patched = {
    ...draw,
    pipelineState: {
      ...draw.pipelineState,
      depthStencil: { ...draw.pipelineState.depthStencil, format },
    },
  };
  return { ...vm, draws: [patched] } as ViewModel;
}

describe('depth-stencil split: Depth + Stencil thumbnails', () => {
  it('depth24plus-stencil8 yields BOTH a Depth and a Stencil thumbnail', () => {
    const vm = mockViewModelWithDepthFormat('depth24plus-stencil8');
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );
    const labels = Array.from(container.querySelectorAll('[data-forgeax-texture-thumbnail]')).map(
      (el) => el.textContent ?? '',
    );
    expect(labels.some((t) => t.includes('Depth'))).toBe(true);
    expect(labels.some((t) => t.includes('Stencil'))).toBe(true);
  });

  it('depth32float (no stencil) yields a Depth thumbnail but NO Stencil', () => {
    const vm = mockViewModelWithDepthFormat('depth32float');
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );
    const labels = Array.from(container.querySelectorAll('[data-forgeax-texture-thumbnail]')).map(
      (el) => el.textContent ?? '',
    );
    expect(labels.some((t) => t.includes('Depth'))).toBe(true);
    expect(labels.some((t) => t.includes('Stencil'))).toBe(false);
  });

  it('both Depth and Stencil thumbnails of depth24plus-stencil8 are NOT error', () => {
    const vm = mockViewModelWithDepthFormat('depth24plus-stencil8');
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );
    const thumbs = Array.from(container.querySelectorAll('[data-forgeax-texture-thumbnail]'));
    const depth = thumbs.find((el) => el.textContent?.includes('Depth'));
    const stencil = thumbs.find((el) => el.textContent?.includes('Stencil'));
    expect(depth?.textContent).not.toMatch(/error/);
    expect(stencil?.textContent).not.toMatch(/error/);
  });
});

// --------------- AC-16: thumbnail click switches preview ---------------

describe('AC-16: thumbnail click switches preview', () => {
  it('clicking a different thumbnail updates main preview label', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // Initially the first thumbnail (Color RT 0) is selected
    expect(container.textContent).toContain('Color RT 0');

    // Click the second thumbnail (Depth)
    const thumbs = container.querySelectorAll('[data-forgeax-texture-thumbnail]');
    expect(thumbs.length).toBeGreaterThanOrEqual(2);

    if (thumbs[1]) {
      fireEvent.click(thumbs[1]);
    }

    // After clicking, the main preview should show depth info
    // The main preview header shows the selected thumbnail's label
    expect(container.textContent).toContain('Depth');
  });
});

// --------------- AC-26: non-draw default text ---------------

describe('AC-26: non-draw selected shows default text', () => {
  it('shows default text when selectedDrawIdx < 0', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: -1 }) as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view textures');
    const el = container.querySelector('[data-forgeax-texture-viewer]');
    expect(el?.getAttribute('data-forgeax-texture-viewer')).toBe('default');
  });

  it('shows default text when no ViewModel', () => {
    const { container } = render(
      <ViewModelContext.Provider value={null}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <TextureViewer {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view textures');
  });
});
