// PipelineState.tsx — pipeline state panel for the selected draw (w24).
//
// Seven collapsible sections (RenderDoc-style):
//   1. Input Assembly — topology, stripIndexFormat
//   2. Vertex Input — per-slot buffer layout (arrayStride, stepMode, attributes)
//   3. Shaders — vertex/fragment module handles + inline expandable WGSL source
//   4. Rasterizer — cullMode, frontFace
//   5. Depth-Stencil — format, depthCompare, depthWriteEnabled, stencil state
//   6. Blend — per-target blend state + blendConstant
//   7. Multisample — count, mask, alphaToCoverageEnabled
//
// When no draw is selected, shows default text for non-draw command.
//
// Related: requirements AC-15/AC-26; plan-strategy D-5; RenderDoc prior art.
// biome-ignore-all lint/suspicious/noArrayIndexKey: vertex buffer slots, attributes, and color targets are hardware-stable ordered lists; compound keys include semantic identifiers (arrayStride, shaderLocation, format).

import type { IDockviewPanelProps } from 'dockview-react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useSelection } from '../selection-context';
import { pipelineStateAnchor } from '../selectors';
import { useViewModel } from '../viewer-context';
import type { CreateDescriptor, DrawEntry } from '../viewer-model';
import { CodeMirrorShader } from './CodeMirrorShader';

type SectionId =
  | 'ia'
  | 'vertexInput'
  | 'shaders'
  | 'rasterizer'
  | 'depthStencil'
  | 'blend'
  | 'multisample';

const SECTION_LABELS: Record<SectionId, string> = {
  ia: 'Input Assembly',
  vertexInput: 'Vertex Input',
  shaders: 'Shaders',
  rasterizer: 'Rasterizer',
  depthStencil: 'Depth-Stencil',
  blend: 'Blend',
  multisample: 'Multisample',
};

const ALL_SECTIONS: readonly SectionId[] = [
  'ia',
  'vertexInput',
  'shaders',
  'rasterizer',
  'depthStencil',
  'blend',
  'multisample',
];

function topologyLabel(t: string): string {
  switch (t) {
    case 'point-list':
      return 'Point List';
    case 'line-list':
      return 'Line List';
    case 'line-strip':
      return 'Line Strip';
    case 'triangle-list':
      return 'Triangle List';
    case 'triangle-strip':
      return 'Triangle Strip';
    default:
      return t;
  }
}

function cullLabel(c: string): string {
  switch (c) {
    case 'none':
      return 'None';
    case 'front':
      return 'Front';
    case 'back':
      return 'Back';
    default:
      return c;
  }
}

function compareLabel(c: string): string {
  if (c === 'never') return 'Never';
  if (c === 'less') return 'Less';
  if (c === 'equal') return 'Equal';
  if (c === 'less-equal') return 'LessEqual';
  if (c === 'greater') return 'Greater';
  if (c === 'not-equal') return 'NotEqual';
  if (c === 'greater-equal') return 'GreaterEqual';
  if (c === 'always') return 'Always';
  return c;
}

function blendFactorLabel(f: string): string {
  if (f === 'zero') return 'Zero';
  if (f === 'one') return 'One';
  if (f === 'src') return 'SrcColor';
  if (f === 'one-minus-src') return 'OneMinusSrcColor';
  if (f === 'src-alpha') return 'SrcAlpha';
  if (f === 'one-minus-src-alpha') return 'OneMinusSrcAlpha';
  if (f === 'dst') return 'DstColor';
  if (f === 'one-minus-dst') return 'OneMinusDstColor';
  if (f === 'dst-alpha') return 'DstAlpha';
  if (f === 'one-minus-dst-alpha') return 'OneMinusDstAlpha';
  if (f === 'constant') return 'Constant';
  if (f === 'one-minus-constant') return 'OneMinusConstant';
  if (f === 'src-alpha-saturated') return 'SrcAlphaSaturated';
  return f;
}

function blendOpLabel(o: string): string {
  if (o === 'add') return 'Add';
  if (o === 'subtract') return 'Subtract';
  if (o === 'reverse-subtract') return 'RevSubtract';
  if (o === 'min') return 'Min';
  if (o === 'max') return 'Max';
  return o;
}

function stencilOpLabel(o: string): string {
  if (o === 'keep') return 'Keep';
  if (o === 'zero') return 'Zero';
  if (o === 'replace') return 'Replace';
  if (o === 'invert') return 'Invert';
  if (o === 'increment-clamp') return 'IncrementClamp';
  if (o === 'decrement-clamp') return 'DecrementClamp';
  if (o === 'increment-wrap') return 'IncrementWrap';
  if (o === 'decrement-wrap') return 'DecrementWrap';
  return o;
}

function KvRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs py-0.5">
      <span className="text-muted-foreground shrink-0 w-36">{label}:</span>
      <span className="text-foreground font-mono">{value}</span>
    </div>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs font-medium text-brand hover:text-brand transition-colors"
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      {label}
    </button>
  );
}

function VertexInputSection({ draw }: { draw: DrawEntry }) {
  const vi = draw.pipelineState.vertexInput;
  if (vi.buffers.length === 0) {
    return <KvRow label="Buffers" value="(none)" />;
  }
  return (
    <div className="space-y-1">
      {vi.buffers.map((buf, si) => (
        <div key={`vb-${buf.arrayStride}-${si}`} className="ml-2 border-l-2 border-border pl-2">
          <KvRow
            label={`Slot ${si}`}
            value={`stride=${buf.arrayStride}, stepMode=${buf.stepMode}`}
          />
          {buf.attributes.map((attr, _ai) => (
            <KvRow
              key={`attr-${attr.shaderLocation}`}
              label={`  Attr[${attr.shaderLocation}]`}
              value={`${attr.format} offset=${attr.offset}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ShadersSection({
  draw,
  resources,
}: {
  draw: DrawEntry;
  resources: ReadonlyMap<string, CreateDescriptor>;
}) {
  // Keyed by STAGE ('vertex' | 'fragment'), NOT the module handle: vertex and
  // fragment can share one module (e.g. shaderModule:1 holds vs_main + fs_main),
  // so a handle key would toggle both editors at once.
  const [expanded, setExpanded] = useState<Set<'vertex' | 'fragment'>>(new Set());
  const ps = draw.pipelineState.shaders;

  const toggleWgsl = (stageKey: 'vertex' | 'fragment') => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(stageKey)) next.delete(stageKey);
      else next.add(stageKey);
      return next;
    });
  };

  const vsDesc =
    ps.vertexShaderModuleHandleId !== undefined
      ? resources.get(ps.vertexShaderModuleHandleId)
      : undefined;
  const fsDesc =
    ps.fragmentShaderModuleHandleId !== undefined
      ? resources.get(ps.fragmentShaderModuleHandleId)
      : undefined;

  // Append the ACTIVE entry point so a module bundling several entrypoints (e.g.
  // fs_main forward vs fs_gbuffer deferred) is unambiguous: the row shows which
  // function this draw actually runs, not just the module handle.
  const shaderValue = (handleId: string | undefined, entryPoint: string | undefined): string => {
    if (handleId === undefined) return '(none)';
    return entryPoint !== undefined ? `${handleId}  ·  ${entryPoint}()` : handleId;
  };

  return (
    <div className="space-y-1">
      <KvRow
        label="Vertex Shader"
        value={shaderValue(ps.vertexShaderModuleHandleId, ps.vertexEntryPoint)}
      />
      {vsDesc?.kind === 'createShaderModule' && (
        <div className="ml-2">
          <button
            type="button"
            onClick={() => toggleWgsl('vertex')}
            className="text-xs text-warning/80 hover:text-warning"
          >
            {expanded.has('vertex') ? 'Hide' : 'Show'} WGSL
          </button>
          {expanded.has('vertex') && (
            <CodeMirrorShader
              wgslCode={vsDesc.wgslCode}
              stage="vertex"
              entryPoint={ps.vertexEntryPoint}
            />
          )}
        </div>
      )}
      <KvRow
        label="Fragment Shader"
        value={shaderValue(ps.fragmentShaderModuleHandleId, ps.fragmentEntryPoint)}
      />
      {fsDesc?.kind === 'createShaderModule' && (
        <div className="ml-2">
          <button
            type="button"
            onClick={() => toggleWgsl('fragment')}
            className="text-xs text-warning/80 hover:text-warning"
          >
            {expanded.has('fragment') ? 'Hide' : 'Show'} WGSL
          </button>
          {expanded.has('fragment') && (
            <CodeMirrorShader
              wgslCode={fsDesc.wgslCode}
              stage="fragment"
              entryPoint={ps.fragmentEntryPoint}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DepthStencilSection({ draw }: { draw: DrawEntry }) {
  const ds = draw.pipelineState.depthStencil;
  const sf = ds.stencilFront;
  const sb = ds.stencilBack;
  const sfCompare = sf.compare ?? 'always';
  const sfFail = sf.failOp ?? 'keep';
  const sfDepthFail = sf.depthFailOp ?? 'keep';
  const sfPass = sf.passOp ?? 'keep';
  const sbCompare = sb.compare ?? 'always';
  const sbFail = sb.failOp ?? 'keep';
  const sbDepthFail = sb.depthFailOp ?? 'keep';
  const sbPass = sb.passOp ?? 'keep';
  return (
    <div className="space-y-0.5">
      <KvRow label="Format" value={ds.format} />
      <KvRow label="Depth Write" value={ds.depthWriteEnabled ? 'ON' : 'OFF'} />
      <KvRow label="Depth Compare" value={compareLabel(ds.depthCompare)} />
      <KvRow label="Stencil Ref" value={String(ds.stencilReference)} />
      <KvRow label="Stencil Read Mask" value={`0x${ds.stencilReadMask.toString(16)}`} />
      <KvRow label="Stencil Write Mask" value={`0x${ds.stencilWriteMask.toString(16)}`} />
      <div className="ml-2 border-l-2 border-border pl-2">
        <span className="text-xs text-muted-foreground">Front</span>
        <KvRow label="  Compare" value={compareLabel(sfCompare)} />
        <KvRow label="  Fail" value={stencilOpLabel(sfFail)} />
        <KvRow label="  Z-Fail" value={stencilOpLabel(sfDepthFail)} />
        <KvRow label="  Pass" value={stencilOpLabel(sfPass)} />
      </div>
      <div className="ml-2 border-l-2 border-border pl-2">
        <span className="text-xs text-muted-foreground">Back</span>
        <KvRow label="  Compare" value={compareLabel(sbCompare)} />
        <KvRow label="  Fail" value={stencilOpLabel(sbFail)} />
        <KvRow label="  Z-Fail" value={stencilOpLabel(sbDepthFail)} />
        <KvRow label="  Pass" value={stencilOpLabel(sbPass)} />
      </div>
      <KvRow label="Depth Bias" value={String(ds.depthBias)} />
      <KvRow label="Bias Slope Scale" value={String(ds.depthBiasSlopeScale)} />
      <KvRow label="Bias Clamp" value={String(ds.depthBiasClamp)} />
    </div>
  );
}

function BlendSection({ draw }: { draw: DrawEntry }) {
  const bl = draw.pipelineState.blend;
  return (
    <div className="space-y-0.5">
      {bl.blendConstant !== undefined && (
        <KvRow
          label="Blend Constant"
          value={(() => {
            const c = bl.blendConstant;
            if (Symbol.iterator in Object(c)) {
              const arr = [...(c as Iterable<number>)];
              return `rgba(${arr[0]?.toFixed(3) ?? '?'}, ${arr[1]?.toFixed(3) ?? '?'}, ${arr[2]?.toFixed(3) ?? '?'}, ${arr[3]?.toFixed(3) ?? '?'})`;
            }
            const d = c as { r: number; g: number; b: number; a: number };
            return `rgba(${d.r.toFixed(3)}, ${d.g.toFixed(3)}, ${d.b.toFixed(3)}, ${d.a.toFixed(3)})`;
          })()}
        />
      )}
      {bl.colorTargets.map((ct, ti) => (
        <div key={`rt-${ct.format}-${ti}`} className="ml-2 border-l-2 border-border pl-2">
          <KvRow label={`RT ${ti}`} value={`format=${ct.format}`} />
          <KvRow label="  Write Mask" value={`0x${ct.writeMask.toString(16)}`} />
          {ct.color && (
            <>
              <KvRow label="  Color Src" value={blendFactorLabel(ct.color.srcFactor ?? '')} />
              <KvRow label="  Color Dst" value={blendFactorLabel(ct.color.dstFactor ?? '')} />
              <KvRow label="  Color Op" value={blendOpLabel(ct.color.operation ?? 'add')} />
            </>
          )}
          {ct.alpha && (
            <>
              <KvRow label="  Alpha Src" value={blendFactorLabel(ct.alpha.srcFactor ?? '')} />
              <KvRow label="  Alpha Dst" value={blendFactorLabel(ct.alpha.dstFactor ?? '')} />
              <KvRow label="  Alpha Op" value={blendOpLabel(ct.alpha.operation ?? 'add')} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function PipelineState(_props: IDockviewPanelProps) {
  const vm = useViewModel();
  const { selectedDrawIdx } = useSelection();
  const [openSections, setOpenSections] = useState<Set<SectionId>>(new Set(ALL_SECTIONS));

  const toggleSection = (id: SectionId) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const noDraw = !vm || selectedDrawIdx < 0 || selectedDrawIdx >= vm.draws.length;

  const mode: 'selected' | 'default' = noDraw ? 'default' : 'selected';

  if (noDraw) {
    return (
      <div
        className="p-4 h-full bg-background flex items-center justify-center"
        {...{ [pipelineStateAnchor()]: mode }}
      >
        <p className="text-xs text-muted-foreground">
          Select a draw command to view pipeline state
        </p>
      </div>
    );
  }

  const draw = vm.draws[selectedDrawIdx];
  if (!draw) {
    return (
      <div
        className="p-4 h-full bg-background flex items-center justify-center"
        {...{ [pipelineStateAnchor()]: mode }}
      >
        <p className="text-xs text-muted-foreground">
          Select a draw command to view pipeline state
        </p>
      </div>
    );
  }

  const ps = draw.pipelineState;

  return (
    <div
      className="h-full bg-background flex flex-col overflow-y-auto p-1"
      {...{ [pipelineStateAnchor()]: mode }}
    >
      {/* IA */}
      <SectionHeader
        label={SECTION_LABELS.ia}
        open={openSections.has('ia')}
        onToggle={() => toggleSection('ia')}
      />
      {openSections.has('ia') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <KvRow label="Topology" value={topologyLabel(ps.inputAssembly.topology)} />
          <KvRow label="Strip Index" value={ps.inputAssembly.stripIndexFormat ?? '(none)'} />
        </div>
      )}

      {/* Vertex Input */}
      <SectionHeader
        label={SECTION_LABELS.vertexInput}
        open={openSections.has('vertexInput')}
        onToggle={() => toggleSection('vertexInput')}
      />
      {openSections.has('vertexInput') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <VertexInputSection draw={draw} />
        </div>
      )}

      {/* Shaders */}
      <SectionHeader
        label={SECTION_LABELS.shaders}
        open={openSections.has('shaders')}
        onToggle={() => toggleSection('shaders')}
      />
      {openSections.has('shaders') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <ShadersSection draw={draw} resources={vm.resources} />
        </div>
      )}

      {/* Rasterizer */}
      <SectionHeader
        label={SECTION_LABELS.rasterizer}
        open={openSections.has('rasterizer')}
        onToggle={() => toggleSection('rasterizer')}
      />
      {openSections.has('rasterizer') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <KvRow label="Cull Mode" value={cullLabel(ps.rasterizer.cullMode)} />
          <KvRow label="Front Face" value={ps.rasterizer.frontFace.toUpperCase()} />
        </div>
      )}

      {/* Depth-Stencil */}
      <SectionHeader
        label={SECTION_LABELS.depthStencil}
        open={openSections.has('depthStencil')}
        onToggle={() => toggleSection('depthStencil')}
      />
      {openSections.has('depthStencil') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <DepthStencilSection draw={draw} />
        </div>
      )}

      {/* Blend */}
      <SectionHeader
        label={SECTION_LABELS.blend}
        open={openSections.has('blend')}
        onToggle={() => toggleSection('blend')}
      />
      {openSections.has('blend') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <BlendSection draw={draw} />
        </div>
      )}

      {/* Multisample */}
      <SectionHeader
        label={SECTION_LABELS.multisample}
        open={openSections.has('multisample')}
        onToggle={() => toggleSection('multisample')}
      />
      {openSections.has('multisample') && (
        <div className="ml-2 border-l border-border pl-2 py-1">
          <KvRow label="Count" value={String(ps.multisample.count)} />
          <KvRow label="Mask" value={`0x${ps.multisample.mask.toString(16)}`} />
          <KvRow
            label="Alpha-to-Coverage"
            value={ps.multisample.alphaToCoverageEnabled ? 'ON' : 'OFF'}
          />
        </div>
      )}
    </div>
  );
}
