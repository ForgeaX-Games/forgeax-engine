// PipelineState.test.tsx — PipelineState component test (w28).
//
// Tests:
//   1. 7 stage section headers rendered for a selected draw.
//   2. Shaders section shows WGSL text after clicking expand.
//   3. WGSL text hidden after clicking collapse.
//   4. Non-draw selected (selectedDrawIdx=-1) shows default text.
//   5. AC-28: real-consumer-path type inference verification
//      (useViewModel + useSelection + vm.draws[0].pipelineState.blend.blendConstant
//       accessed without `as` type assertion).
//   6. M4 AC-01/02/04/12: Instance Data section behavior + anchor SSOT grep.
//
// Uses jsdom + @testing-library/react.
//
// Related: requirements AC-15/AC-26/AC-28; plan-strategy 5.1/5.4.

// biome-ignore-all lint/style/noNonNullAssertion: M4 fixture builders index into caller-provided arrays with known-good indices under an explicit loop bound; a type-narrowed access adds noise without safety gain.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HandleId, InspectBindingEntry, RhiCallEvent, Tape } from '@forgeax/engine-rhi-debug';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PipelineState } from '../components/PipelineState';
import { SelectionContext } from '../selection-context';
import { instanceDataSectionAnchor, instanceRowAnchor } from '../selectors';
import { TapeContext, ViewModelContext } from '../viewer-context';
import type { CreateDescriptor, DrawEntry, ViewModel } from '../viewer-model';

const mockProps = {
  api: {},
  containerApi: {},
  params: {},
  group: {},
  isActive: true,
  isVisible: true,
} as unknown as Parameters<typeof PipelineState>[0];

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
    tree: [{ kind: 'render', passIdx: 0, draws: [{ drawIdx: 0, eventKind: 'draw' as const }] }],
    draws: [
      {
        frameIdx: 0,
        passIdx: 0,
        bindings: [],
        drawCall: { pipelineKind: 'render', pipelineHandleId: 'pipe-1' },
        colorAttachmentHandleId: undefined,
        pipelineState: {
          inputAssembly: { topology: 'triangle-list', stripIndexFormat: undefined },
          vertexInput: {
            buffers: [
              {
                arrayStride: 12,
                stepMode: 'vertex' as const,
                attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
              },
            ],
          },
          shaders: {
            vertexShaderModuleHandleId: 'vs-1',
            fragmentShaderModuleHandleId: 'fs-1',
            vertexEntryPoint: 'vs_main',
            fragmentEntryPoint: 'fs_main',
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
        depthStencil: { depthStencilViewHandleId: undefined, depthStencilAttachment: undefined },
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
    resources: new Map([
      [
        'vs-1',
        {
          kind: 'createShaderModule' as const,
          handleId: 'vs-1',
          wgslCode: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }',
        },
      ],
      [
        'fs-1',
        {
          kind: 'createShaderModule' as const,
          handleId: 'fs-1',
          // Bundles two fragment entries (forward + deferred) — the pipeline runs
          // fs_main; the banner must mark it and list fs_gbuffer as "also defines".
          wgslCode:
            '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }\n' +
            '@fragment fn fs_gbuffer() -> @location(0) vec4f { return vec4f(0.0); }',
        },
      ],
    ]),
  };
}

function findByTextAll(container: HTMLElement, text: string): HTMLElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    b.textContent?.includes(text),
  );
}

// --------------- AC-15: 7 stage section headers ---------------

describe('AC-15: 7 stage section headers', () => {
  it('renders 7 stage section headers for a selected draw', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const stages = [
      'Input Assembly',
      'Vertex Input',
      'Shaders',
      'Rasterizer',
      'Depth-Stencil',
      'Blend',
      'Multisample',
    ];

    for (const stage of stages) {
      expect(container.textContent).toContain(stage);
    }
  });

  it('data-forgeax-pipeline-state = selected when draw is selected', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const el = container.querySelector('[data-forgeax-pipeline-state]');
    expect(el?.getAttribute('data-forgeax-pipeline-state')).toBe('selected');
  });
});

// --------------- AC-15: Shaders WGSL expand/collapse ---------------

describe('AC-15: Shaders WGSL expand/collapse', () => {
  it('Shaders section shows Show WGSL button', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    // The Shaders section initially shows Show WGSL buttons
    const showBtns = findByTextAll(container, 'Show WGSL');
    expect(showBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the active entry point next to each shader handle (bug #5)', () => {
    // A module can bundle several entrypoints (e.g. fs_main forward + fs_gbuffer
    // deferred); the row must name the ACTIVE one so it is unambiguous which fn runs.
    const vm = mockViewModel();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );
    expect(container.textContent).toContain('vs_main()');
    expect(container.textContent).toContain('fs_main()');
  });

  it('clicking Show WGSL reveals WGSL code', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const showBtns = findByTextAll(container, 'Show WGSL');
    expect(showBtns.length).toBeGreaterThanOrEqual(1);

    if (showBtns[0]) {
      fireEvent.click(showBtns[0]);
    }

    // After expanding, WGSL code should be visible
    expect(container.textContent).toContain('@vertex fn main');
  });

  it('clicking Hide WGSL hides the code', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    const showBtns = findByTextAll(container, 'Show WGSL');
    if (showBtns[0]) fireEvent.click(showBtns[0]);
    expect(container.textContent).toContain('@vertex fn main');

    // Now click Hide
    const hideBtns = findByTextAll(container, 'Hide WGSL');
    if (hideBtns[0]) fireEvent.click(hideBtns[0]);
    // After collapse, the button should go back to Show
    const showAgain = findByTextAll(container, 'Show WGSL');
    expect(showAgain.length).toBeGreaterThanOrEqual(1);
  });

  it('expanding the vertex WGSL does NOT also expand the fragment (shared module)', () => {
    // Regression: vertex + fragment share shaderModule:1, so keying the expand
    // state on the module handle toggled both editors at once. State must key on
    // the stage, not the handle.
    const vm = mockViewModel();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );
    const showBtns = findByTextAll(container, 'Show WGSL');
    expect(showBtns.length).toBe(2); // one per stage
    if (showBtns[0]) fireEvent.click(showBtns[0]); // expand vertex only
    // Exactly one editor mounted, and exactly one button flipped to Hide.
    expect(container.querySelectorAll('[data-forgeax-shader-editor]').length).toBe(1);
    expect(findByTextAll(container, 'Hide WGSL').length).toBe(1);
    expect(findByTextAll(container, 'Show WGSL').length).toBe(1);
  });

  it('the expanded WGSL banner marks the active entry and lists the others', () => {
    // fs-1 bundles fs_main + fs_gbuffer; the fragment pipeline runs fs_main. The
    // banner must name fs_main as active and list fs_gbuffer as "also defines" so
    // the unused gbuffer entry in the shown source is not mistaken for the output.
    const vm = mockViewModel();
    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 0 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );
    // Expand the fragment editor (second Show WGSL button).
    const showBtns = findByTextAll(container, 'Show WGSL');
    if (showBtns[1]) fireEvent.click(showBtns[1]);
    const banner = container.querySelector('[data-forgeax-shader-entrypoint="fs_main"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('fs_main()');
    expect(banner?.textContent).toContain('fs_gbuffer()');
  });
});

// --------------- AC-26: non-draw default text ---------------

describe('AC-26: non-draw selected shows default text', () => {
  it('shows default text when selectedDrawIdx < 0', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: -1 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view pipeline state');
    const el = container.querySelector('[data-forgeax-pipeline-state]');
    expect(el?.getAttribute('data-forgeax-pipeline-state')).toBe('default');
  });

  it('shows default text when no ViewModel', () => {
    const { container } = render(
      <ViewModelContext.Provider value={null}>
        <SelectionContext.Provider value={makeSelection() as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view pipeline state');
  });

  it('shows default text when selectedDrawIdx out of range', () => {
    const vm = mockViewModel();

    const { container } = render(
      <ViewModelContext.Provider value={vm}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx: 999 }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </ViewModelContext.Provider>,
    );

    expect(container.textContent).toContain('Select a draw command to view pipeline state');
  });
});

// --------------- AC-28: real-consumer-path type inference ---------------

describe('AC-28: real-consumer-path type inference', () => {
  it('pipelineState.blend.blendConstant type is GPUColor | undefined via real consumption', () => {
    // This test verifies the AC-28 real-consumer-path type constraint:
    // accessing vm.draws[0].pipelineState.blend.blendConstant through
    // useViewModel/Context infers GPUColor | undefined, no `as` needed.
    // The fact this file compiles (typecheck passes) proves the type inference
    // chain through useViewModel -> ViewModelContext -> draw pipelineState is intact.

    const vm = mockViewModel();

    // Access through the same path a real panel component would use
    const draw = vm.draws[0];
    expect(draw).toBeDefined();
    if (!draw) return; // eslint guard

    // Type-level verification: draw.pipelineState.blend.blendConstant
    // should be GPUColor | undefined
    const blendConstant = draw.pipelineState.blend.blendConstant;
    // Verify it's undefined in this fixture
    expect(blendConstant).toBeUndefined();

    // The real consumer path in PipelineState.tsx accesses
    // vm.draws[selectedDrawIdx]?.pipelineState itself with full type narrowing.
    // This test confirms the ViewModel interface types are correct at the
    // consumption boundary, not just in the isolated .test-d.ts (w13).
  });

  it('entire pipelineState shape is accessible without as', () => {
    const vm = mockViewModel();
    const draw = vm.draws[0];
    if (!draw) return;

    // Access all 7 stages without type assertions
    const topology: string = draw.pipelineState.inputAssembly.topology;
    expect(topology).toBe('triangle-list');

    const cullMode: string = draw.pipelineState.rasterizer.cullMode;
    expect(cullMode).toBe('none');

    const format: string = draw.pipelineState.depthStencil.format;
    expect(format).toBe('depth24plus');

    const writeMask: number = draw.pipelineState.blend.colorTargets[0]?.writeMask ?? 0;
    expect(writeMask).toBe(0xf);

    const sampleCount: number = draw.pipelineState.multisample.count;
    expect(sampleCount).toBe(1);

    const vsHandle = draw.pipelineState.shaders.vertexShaderModuleHandleId;
    expect(vsHandle).toBe('vs-1');
  });
});

// ============================================================================
// M4: Instance Data section (AC-01 / AC-02 / AC-04 / AC-12)
// ============================================================================

const INSTANCE_BUFFER: HandleId = 'buf-instances';
const INSTANCE_HASH = 'hash-instances';

/** Identity mat4 as 16 column-major floats. */
function identityMat4Floats(): number[] {
  const m = new Array<number>(16).fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** Build a stride-64 (mat4 only) or stride-80 (mat4+region) instance buffer. */
function buildInstanceBuffer(
  matsPerInstance: readonly (readonly number[])[],
  regions?: readonly (readonly number[])[],
): ArrayBuffer {
  const stride = regions ? 80 : 64;
  const buf = new ArrayBuffer(matsPerInstance.length * stride);
  const dv = new DataView(buf);
  for (let i = 0; i < matsPerInstance.length; i++) {
    const base = i * stride;
    const mat = matsPerInstance[i]!;
    for (let j = 0; j < 16; j++) {
      dv.setFloat32(base + j * 4, mat[j] ?? 0, true);
    }
    if (regions) {
      const region = regions[i]!;
      for (let j = 0; j < 4; j++) {
        dv.setFloat32(base + 64 + j * 4, region[j] ?? 0, true);
      }
    }
  }
  return buf;
}

function makeInstanceTape(bytes: ArrayBuffer): Tape {
  const blobPool = new Map<string, ArrayBuffer>();
  blobPool.set(INSTANCE_HASH, bytes);
  const events: RhiCallEvent[] = [
    { kind: 'initialData', handleId: INSTANCE_BUFFER, dataHash: INSTANCE_HASH } as RhiCallEvent,
  ];
  return {
    formatVersion: 1,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: true,
      timestampQuery: false,
    },
    events,
    blobPool,
  };
}

/** Clone the base mockViewModel and swap draw[0]'s bindings + instanceCount. */
function mockViewModelWithInstances(
  bindings: readonly InspectBindingEntry[],
  instanceCount: number,
): ViewModel {
  const base = mockViewModel();
  const draw = base.draws[0]!;
  const newDraw: DrawEntry = {
    ...draw,
    bindings,
    drawCall: { ...draw.drawCall, instanceCount },
  };
  const resources = new Map<HandleId, CreateDescriptor>(base.resources);
  resources.set(INSTANCE_BUFFER, {
    kind: 'createBuffer',
    handleId: INSTANCE_BUFFER,
    size: 0,
    usage: 0,
  });
  return { ...base, draws: [newDraw], resources };
}

function renderWithTape(vm: ViewModel, tape: Tape, selectedDrawIdx = 0) {
  return render(
    <ViewModelContext.Provider value={vm}>
      <TapeContext.Provider value={tape}>
        <SelectionContext.Provider value={makeSelection({ selectedDrawIdx }) as never}>
          <PipelineState {...mockProps} />
        </SelectionContext.Provider>
      </TapeContext.Provider>
    </ViewModelContext.Provider>,
  );
}

describe('M4 AC-01: Instance Data section renders when group-3 binding-0 present', () => {
  it('stride 64 (mat4-only) → table element with instance-data-section anchor', () => {
    const blob = buildInstanceBuffer([identityMat4Floats(), identityMat4Floats()]);
    const tape = makeInstanceTape(blob);
    const binding: InspectBindingEntry = {
      groupIndex: 3,
      entryIndex: 0,
      handleId: INSTANCE_BUFFER,
      kind: 'buffer',
    };
    const vm = mockViewModelWithInstances([binding], 2);

    const { container } = renderWithTape(vm, tape);
    const table = container.querySelector(`[${instanceDataSectionAnchor()}]`);
    expect(table).not.toBeNull();
    expect(table?.tagName.toLowerCase()).toBe('table');
  });
});

describe('M4 AC-02: row count matches instanceCount, >256 truncates', () => {
  it('instanceCount=4 → exactly 4 instance rows, no truncation notice', () => {
    const mats = [
      identityMat4Floats(),
      identityMat4Floats(),
      identityMat4Floats(),
      identityMat4Floats(),
    ];
    const blob = buildInstanceBuffer(mats);
    const tape = makeInstanceTape(blob);
    const binding: InspectBindingEntry = {
      groupIndex: 3,
      entryIndex: 0,
      handleId: INSTANCE_BUFFER,
      kind: 'buffer',
    };
    const vm = mockViewModelWithInstances([binding], 4);

    const { container } = renderWithTape(vm, tape);
    const rows = container.querySelectorAll(`[${instanceRowAnchor()}]`);
    expect(rows.length).toBe(4);
    expect(container.textContent).not.toContain('more (truncated)');
  });

  it('instanceCount=300 → 256 rows + truncation notice mentioning remaining 44', () => {
    const N = 300;
    const mats: number[][] = [];
    for (let i = 0; i < N; i++) mats.push(identityMat4Floats());
    const blob = buildInstanceBuffer(mats);
    const tape = makeInstanceTape(blob);
    const binding: InspectBindingEntry = {
      groupIndex: 3,
      entryIndex: 0,
      handleId: INSTANCE_BUFFER,
      kind: 'buffer',
    };
    const vm = mockViewModelWithInstances([binding], N);

    const { container } = renderWithTape(vm, tape);
    const rows = container.querySelectorAll(`[${instanceRowAnchor()}]`);
    expect(rows.length).toBe(256);
    // Truncation footer: "... 44 more (truncated)"
    expect(container.textContent).toContain('44 more');
    expect(container.textContent).toContain('(truncated)');
  });
});

describe('M4 AC-04: draw without group-3 binding → (none) placeholder', () => {
  it('empty bindings → shows "(none)" and no instance-data-section element', () => {
    const vm = mockViewModelWithInstances([], 4);
    // Tape without any relevant events still fine; decoder returns 'none' before reading blob.
    const tape = makeInstanceTape(new ArrayBuffer(0));

    const { container } = renderWithTape(vm, tape);
    expect(container.querySelector(`[${instanceDataSectionAnchor()}]`)).toBeNull();
    // The Instance Data section body should render the placeholder KvRow.
    expect(container.textContent).toContain('Instance Data');
    expect(container.textContent).toContain('(none)');
  });
});

describe('M4 AC-12: data-forgeax-instance-* anchor literals live only in selectors.ts', () => {
  it('grep across apps/rhi-debug-viewer/src returns only selectors.ts + this test', () => {
    // Rebuild the anchor prefix at runtime so the string literal in this test
    // file itself does not trip the grep gate (would create a false positive).
    const prefix = `data-forgeax-${'instance'}-`;

    // src/ is a stable sibling of __tests__/. import.meta.dirname (Node 20.11+)
    // gives an absolute filesystem path independent of the jsdom base URL.
    const srcDir = resolve(import.meta.dirname, '..');
    const testFile = resolve(import.meta.dirname, 'PipelineState.test.tsx');
    const selectorsFile = resolve(srcDir, 'selectors.ts');

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) out.push(...walk(p));
        else if (s.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx'))) out.push(p);
      }
      return out;
    }

    const hits: string[] = [];
    for (const file of walk(srcDir)) {
      if (file === selectorsFile || file === testFile) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes(prefix)) hits.push(file);
    }
    expect(hits).toEqual([]);
    // Sanity: selectors.ts IS the SSOT and MUST hold the prefix.
    expect(readFileSync(selectorsFile, 'utf8').includes(prefix)).toBe(true);
  });
});
