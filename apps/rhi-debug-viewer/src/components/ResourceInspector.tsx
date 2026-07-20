// ResourceInspector.tsx — resource inspector panel with categorized tables (w26).
//
// Displays all create* resources from viewModel.resources, organized by category:
//   Buffers, Textures, Samplers, BindGroupLayouts, PipelineLayouts,
//   Pipelines, ShaderModules.
//
// Features:
//   - GPU usage flag decoding to human-readable strings.
//   - Handle hyperlinks: clicking a handleId scrolls + highlights the matching row.
//   - Cross-panel handle linking via handleLink context.
//   - Search/filter input across resource names and handleIds.
//
// Related: requirements AC-19/AC-26/AC-27; plan-strategy D-5; research Finding 8.

import type { IDockviewPanelProps } from 'dockview-react';
import { Search } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { type BufferConsumer, bufferBindingConsumers } from '../buffer-binding';
import {
  type BufferViewType,
  buildBufferContentDisplay,
  formatViewValue,
  getBufferBlobData,
  getBufferContentSource,
} from '../buffer-content';
import { useSelection } from '../selection-context';
import { resourceInspectorAnchor, resourceRowAnchor } from '../selectors';
import { useTape, useViewModel } from '../viewer-context';
import type { CreateDescriptor } from '../viewer-model';
import { CodeMirrorWidget } from './CodeMirrorWidget';

// ============================================================================
// Usage flag decoding
// ============================================================================

// GPUBufferUsage constants (WebGPU spec §24.1)
// pnpm-lint: direct literals avoid GPUBufferUsage crash in jsdom tests.
const BUFFER_USAGE_MAP: readonly [number, string][] = [
  [0x0001, 'MAP_READ'],
  [0x0002, 'MAP_WRITE'],
  [0x0004, 'COPY_SRC'],
  [0x0008, 'COPY_DST'],
  [0x0010, 'INDEX'],
  [0x0020, 'VERTEX'],
  [0x0040, 'UNIFORM'],
  [0x0080, 'STORAGE'],
  [0x0100, 'INDIRECT'],
  [0x0200, 'QUERY_RESOLVE'],
];

function decodeBufferUsage(usage: number): string {
  const flags = BUFFER_USAGE_MAP.filter(([flag]) => (usage & flag) !== 0).map(([, label]) => label);
  return flags.length > 0 ? flags.join(' | ') : `0x${usage.toString(16)}`;
}

// GPUTextureUsage constants (WebGPU spec §24.1.2)
const TEXTURE_USAGE_MAP: readonly [number, string][] = [
  [0x01, 'COPY_SRC'],
  [0x02, 'COPY_DST'],
  [0x04, 'TEXTURE_BINDING'],
  [0x08, 'STORAGE_BINDING'],
  [0x10, 'RENDER_ATTACHMENT'],
];

function decodeTextureUsage(usage: number): string {
  const flags = TEXTURE_USAGE_MAP.filter(([flag]) => (usage & flag) !== 0).map(
    ([, label]) => label,
  );
  return flags.length > 0 ? flags.join(' | ') : `0x${usage.toString(16)}`;
}

function textureDimensionLabel(d: GPUTextureDimension): string {
  if (d === '1d') return '1D';
  if (d === '2d') return '2D';
  if (d === '3d') return '3D';
  return d;
}

// ============================================================================
// Resource categorization
// ============================================================================

type ResourceCategory =
  | 'Buffers'
  | 'Textures'
  | 'Samplers'
  | 'BindGroupLayouts'
  | 'PipelineLayouts'
  | 'Pipelines'
  | 'ShaderModules';

interface CategorizedResources {
  readonly category: ResourceCategory;
  readonly items: readonly CreateDescriptor[];
}

function categorizeResources(
  resources: ReadonlyMap<string, CreateDescriptor>,
): readonly CategorizedResources[] {
  const cats: Record<ResourceCategory, CreateDescriptor[]> = {
    Buffers: [],
    Textures: [],
    Samplers: [],
    BindGroupLayouts: [],
    PipelineLayouts: [],
    Pipelines: [],
    ShaderModules: [],
  };

  for (const desc of resources.values()) {
    switch (desc.kind) {
      case 'createBuffer':
        cats.Buffers.push(desc);
        break;
      case 'createTexture':
        cats.Textures.push(desc);
        break;
      case 'createSampler':
        cats.Samplers.push(desc);
        break;
      case 'createBindGroupLayout':
        cats.BindGroupLayouts.push(desc);
        break;
      case 'createPipelineLayout':
        cats.PipelineLayouts.push(desc);
        break;
      case 'createRenderPipeline':
      case 'createShaderModule':
        if (desc.kind === 'createRenderPipeline') {
          cats.Pipelines.push(desc);
        } else {
          cats.ShaderModules.push(desc);
        }
        break;
    }
  }

  const result: CategorizedResources[] = [];
  const order: ResourceCategory[] = [
    'Buffers',
    'Textures',
    'Samplers',
    'BindGroupLayouts',
    'PipelineLayouts',
    'Pipelines',
    'ShaderModules',
  ];
  for (const cat of order) {
    if (cats[cat].length > 0) {
      result.push({ category: cat, items: cats[cat] });
    }
  }
  return result;
}

// ============================================================================
// Table renderers
// ============================================================================

function ResourceTable({
  category,
  items,
  filter,
  highlightedHandle,
  onHandleClick,
  expandedWgsl,
  onToggleWgsl,
  expandedBuffers,
  onToggleBuffer,
  bufferViewType,
  onBufferViewType,
  contentSource,
  blobData,
  consumerMap,
  onDrawClick,
}: {
  category: ResourceCategory;
  items: readonly CreateDescriptor[];
  filter: string;
  highlightedHandle: string | null;
  onHandleClick: (handleId: string) => void;
  expandedWgsl: Set<string>;
  onToggleWgsl: (handleId: string) => void;
  expandedBuffers: Set<string>;
  onToggleBuffer: (handleId: string) => void;
  bufferViewType: BufferViewType;
  onBufferViewType: (handleId: string, vt: BufferViewType) => void;
  contentSource: Map<string, string>;
  blobData: Map<string, ArrayBuffer | null>;
  consumerMap: Map<string, readonly BufferConsumer[]>;
  onDrawClick: (drawIdx: number) => void;
}) {
  const filtered = useMemo(() => {
    if (!filter) return items;
    const lower = filter.toLowerCase();
    return items.filter((item) => item.handleId.toLowerCase().includes(lower));
  }, [items, filter]);

  if (filtered.length === 0) {
    return null;
  }

  return (
    <div className="mb-3">
      <div className="px-2 py-1 text-xs font-medium text-brand border-b border-border">
        {category} ({filtered.length})
      </div>
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((item) => (
          <ResourceRow
            key={item.handleId}
            item={item}
            isHighlighted={highlightedHandle === item.handleId}
            onHandleClick={onHandleClick}
            expandedWgsl={expandedWgsl}
            onToggleWgsl={onToggleWgsl}
            expandedBuffers={expandedBuffers}
            onToggleBuffer={onToggleBuffer}
            bufferViewType={bufferViewType}
            onBufferViewType={onBufferViewType}
            contentSourceMap={contentSource}
            blobDataMap={blobData}
            consumerMap={consumerMap}
            onDrawClick={onDrawClick}
          />
        ))}
      </div>
    </div>
  );
}

function ResourceRow({
  item,
  isHighlighted,
  onHandleClick,
  expandedWgsl,
  onToggleWgsl,
  expandedBuffers,
  onToggleBuffer,
  bufferViewType,
  onBufferViewType,
  contentSourceMap,
  blobDataMap,
  consumerMap,
  onDrawClick,
}: {
  item: CreateDescriptor;
  isHighlighted: boolean;
  onHandleClick: (handleId: string) => void;
  expandedWgsl: Set<string>;
  onToggleWgsl: (handleId: string) => void;
  expandedBuffers: Set<string>;
  onToggleBuffer: (handleId: string) => void;
  bufferViewType: BufferViewType;
  onBufferViewType: (handleId: string, vt: BufferViewType) => void;
  contentSourceMap: Map<string, string>;
  blobDataMap: Map<string, ArrayBuffer | null>;
  consumerMap: Map<string, readonly BufferConsumer[]>;
  onDrawClick: (drawIdx: number) => void;
}) {
  const handleClick = useCallback(() => {
    onHandleClick(item.handleId);
  }, [item.handleId, onHandleClick]);

  const className = `text-xs px-2 py-0.5 flex items-center gap-2 transition-colors ${
    isHighlighted
      ? 'bg-brand/15 border-l-2 border-brand'
      : 'hover:bg-muted/50 border-l-2 border-transparent'
  }`;

  const detail = renderDetail(item);
  const isShaderModule = item.kind === 'createShaderModule';
  const isBuffer = item.kind === 'createBuffer';
  const isExpandedBuffer = isBuffer && expandedBuffers.has(item.handleId);
  const sourceLabel = isBuffer ? (contentSourceMap.get(item.handleId) ?? '') : '';

  return (
    <div>
      <div className={className} {...{ [resourceRowAnchor()]: item.handleId }}>
        <button
          type="button"
          onClick={handleClick}
          className="text-brand hover:text-brand font-mono shrink-0 text-left"
        >
          {item.handleId}
        </button>
        <span className="text-muted-foreground truncate flex-1 min-w-0">{detail}</span>
        {isBuffer && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleBuffer(item.handleId);
            }}
            className="text-xs text-warning/80 hover:text-warning shrink-0"
          >
            {isExpandedBuffer ? 'Hide' : 'Show'} Content
          </button>
        )}
        {isShaderModule && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleWgsl(item.handleId);
            }}
            className="text-xs text-warning/80 hover:text-warning shrink-0"
          >
            {expandedWgsl.has(item.handleId) ? 'Hide' : 'Show'} WGSL
          </button>
        )}
      </div>
      {isBuffer && isExpandedBuffer && (
        <BufferContentPanel
          item={item}
          contentSource={sourceLabel}
          blobData={blobDataMap.get(item.handleId) ?? null}
          viewType={bufferViewType}
          onViewTypeChange={(vt) => onBufferViewType(item.handleId, vt)}
          consumers={consumerMap.get(item.handleId) ?? []}
          onDrawClick={onDrawClick}
        />
      )}
      {isShaderModule && expandedWgsl.has(item.handleId) && (
        <div className="px-2 pb-1">
          <CodeMirrorWidget wgslCode={item.wgslCode} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Buffer content readback panel (F3, AC-07)
// ============================================================================

const BUFFER_VIEW_TYPES: BufferViewType[] = ['f32', 'u32', 'i32', 'u8'];

function BufferContentPanel({
  item: _item,
  contentSource,
  blobData,
  viewType,
  onViewTypeChange,
  consumers,
  onDrawClick,
}: {
  item: CreateDescriptor & { kind: 'createBuffer' };
  contentSource: string;
  blobData: ArrayBuffer | null;
  viewType: BufferViewType;
  onViewTypeChange: (vt: BufferViewType) => void;
  consumers: readonly BufferConsumer[];
  onDrawClick: (drawIdx: number) => void;
}) {
  const isNotReadable = contentSource.startsWith('not readable');

  return (
    <div className="px-2 pb-1 text-xs">
      <div className="text-muted-foreground mb-1">{contentSource}</div>

      {isNotReadable && <div className="text-warning/80 italic">{contentSource}</div>}

      {!isNotReadable && !blobData && (
        <div className="text-muted-foreground italic">
          (live GPU readback not available in this view — load a tape file)
        </div>
      )}

      {blobData && (
        <>
          {/* View type selector */}
          <div className="flex items-center gap-1 mb-1">
            <span className="text-muted-foreground">View:</span>
            {BUFFER_VIEW_TYPES.map((vt) => (
              <button
                key={vt}
                type="button"
                onClick={() => onViewTypeChange(vt)}
                className={`px-1.5 py-0.5 rounded text-xs font-mono ${
                  vt === viewType
                    ? 'bg-brand/20 text-brand'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {vt}
              </button>
            ))}
          </div>

          {/* Decoded values */}
          <BufferContentValues blobData={blobData} viewType={viewType} />
        </>
      )}

      {/* Consumer list */}
      {consumers.length > 0 && (
        <div className="mt-1">
          <span className="text-muted-foreground">Used by:</span>
          {consumers.map((c) => (
            <button
              key={`${c.drawIdx}-${c.passIdx}-${c.role}-${c.slot ?? 'x'}-${c.groupIndex ?? 'x'}-${c.entryIndex ?? 'x'}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDrawClick(c.drawIdx);
              }}
              className="ml-1 text-brand hover:text-brand/80 font-mono"
            >
              draw#{c.drawIdx}
            </button>
          ))}
          <div className="text-muted-foreground italic mt-0.5">
            {consumers.map((c) => c.details).join('; ')}
          </div>
        </div>
      )}

      {consumers.length === 0 && (
        <div className="text-muted-foreground italic mt-1">no draw consumers found</div>
      )}
    </div>
  );
}

function BufferContentValues({
  blobData,
  viewType,
}: {
  blobData: ArrayBuffer;
  viewType: BufferViewType;
}) {
  const display = useMemo(
    () => buildBufferContentDisplay(blobData, viewType),
    [blobData, viewType],
  );

  const formatted = display.items.map((v, i) => ({
    index: i,
    text: formatViewValue(v, viewType),
  }));

  return (
    <div className="bg-muted/50 rounded p-1.5 font-mono max-h-48 overflow-y-auto">
      <div className="whitespace-pre-wrap break-all leading-relaxed">
        {formatted.map(({ index, text }) => (
          <span key={`${index}-${text.slice(0, 8)}`}>
            <span className="text-muted-foreground select-none">{index}:</span>
            <span>{text}</span>
            {index < formatted.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
      {display.truncated && (
        <div className="text-muted-foreground mt-1 italic">
          … showing first {display.items.length} of {display.totalItems} elements (
          {display.totalBytes} bytes total)
        </div>
      )}
      {!display.truncated && display.totalItems > 0 && (
        <div className="text-muted-foreground mt-1">
          {display.totalItems} elements ({display.totalBytes} bytes)
        </div>
      )}
      {display.totalItems === 0 && (
        <div className="text-muted-foreground italic">
          0 elements ({display.totalBytes} bytes — not enough for {viewType} view)
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sampler descriptor field expansion (F4, AC-08/09)
// ============================================================================

/** Sampler field types we know about from GPUSamplerDescriptor. */
type SamplerField =
  | 'addressModeU'
  | 'addressModeV'
  | 'addressModeW'
  | 'magFilter'
  | 'minFilter'
  | 'mipmapFilter'
  | 'lodMinClamp'
  | 'lodMaxClamp'
  | 'compare'
  | 'maxAnisotropy';

const SAMPLER_FIELDS: readonly SamplerField[] = [
  'addressModeU',
  'addressModeV',
  'addressModeW',
  'magFilter',
  'minFilter',
  'mipmapFilter',
  'lodMinClamp',
  'lodMaxClamp',
  'compare',
  'maxAnisotropy',
];

function samplerFieldLabel(field: SamplerField): string {
  switch (field) {
    case 'addressModeU':
      return 'U';
    case 'addressModeV':
      return 'V';
    case 'addressModeW':
      return 'W';
    case 'magFilter':
      return 'mag';
    case 'minFilter':
      return 'min';
    case 'mipmapFilter':
      return 'mip';
    case 'lodMinClamp':
      return 'lodMin';
    case 'lodMaxClamp':
      return 'lodMax';
    case 'compare':
      return 'cmp';
    case 'maxAnisotropy':
      return 'aniso';
  }
}

function formatSamplerValue(value: unknown): string {
  if (value === undefined) return 'default';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return String(value);
}

function renderSamplerDetail(desc: Partial<GPUSamplerDescriptor> | undefined): string {
  if (desc === undefined) return 'not recorded';

  const parts: string[] = [];
  for (const field of SAMPLER_FIELDS) {
    const key = field as keyof GPUSamplerDescriptor;
    const value = desc[key];
    const label = samplerFieldLabel(field);
    const formatted = formatSamplerValue(value);
    parts.push(`${label}=${formatted}`);
  }

  return parts.join(', ');
}

function renderDetail(item: CreateDescriptor): string {
  switch (item.kind) {
    case 'createBuffer':
      return `size=${item.size}, usage=${decodeBufferUsage(item.usage)}`;
    case 'createTexture':
      return `fmt=${item.format}, ${item.size.join('x')}, ${textureDimensionLabel(item.dimension)}, usage=${decodeTextureUsage(item.usage)}`;
    case 'createSampler':
      return renderSamplerDetail(item.desc);
    case 'createBindGroupLayout':
      return `${item.entries.length} entries`;
    case 'createPipelineLayout':
      return `${item.bglHandleIds.length} BGLs`;
    case 'createRenderPipeline':
      return `vs=${item.vertexShaderModuleHandleId ?? '?'}, fs=${item.fragmentShaderModuleHandleId ?? '?'}`;
    case 'createShaderModule': {
      const preview = item.wgslCode.slice(0, 60).replace(/\n/g, ' ');
      return `WGSL: ${preview}${item.wgslCode.length > 60 ? '…' : ''}`;
    }
    default:
      return '';
  }
}

// ============================================================================
// ResourceInspector component
// ============================================================================

export function ResourceInspector(_props: IDockviewPanelProps) {
  const vm = useViewModel();
  const tape = useTape();
  const { selectedDrawIdx, setSelectedDrawIdx } = useSelection();
  const [filter, setFilter] = useState('');
  const [highlightedHandle, setHighlightedHandle] = useState<string | null>(null);
  const [expandedWgsl, setExpandedWgsl] = useState<Set<string>>(new Set());
  const [expandedBuffers, setExpandedBuffers] = useState<Set<string>>(new Set());
  const [bufferViewTypes, setBufferViewTypes] = useState<Map<string, BufferViewType>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const handleHandleClick = useCallback((handleId: string) => {
    setHighlightedHandle(handleId);
    // Scroll the resource row into view (deferred to allow DOM update).
    // Guarded against missing container or scrollIntoView in test environments.
    setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-forgeax-resource-row="${handleId}"]`);
      try {
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      } catch {
        // scrollIntoView may not be available in jsdom test environment
      }
    }, 0);
  }, []);

  const setExpandedWgslToggle = useCallback((handleId: string) => {
    setExpandedWgsl((prev) => {
      const next = new Set(prev);
      if (next.has(handleId)) next.delete(handleId);
      else next.add(handleId);
      return next;
    });
  }, []);

  const toggleBufferExpand = useCallback((handleId: string) => {
    setExpandedBuffers((prev) => {
      const next = new Set(prev);
      if (next.has(handleId)) next.delete(handleId);
      else next.add(handleId);
      return next;
    });
  }, []);

  const setBufferViewType = useCallback((handleId: string, vt: BufferViewType) => {
    setBufferViewTypes((prev) => {
      const next = new Map(prev);
      next.set(handleId, vt);
      return next;
    });
  }, []);

  const resources = vm?.resources;
  const categorized = useMemo(() => (resources ? categorizeResources(resources) : []), [resources]);

  // Compute buffer content sources and blob data
  const { contentSourceMap, blobDataMap, defaultViewType } = useMemo(() => {
    const csMap = new Map<string, string>();
    const bdMap = new Map<string, ArrayBuffer | null>();
    const dvType: BufferViewType = 'f32';

    if (tape && resources) {
      for (const [handleId, desc] of resources) {
        if (desc.kind !== 'createBuffer') continue;
        const source = getBufferContentSource(tape, handleId, resources);
        if (source.kind === 'blobPool') {
          csMap.set(handleId, `source: blobPool (${source.hashHint.slice(0, 8)})`);
          bdMap.set(handleId, getBufferBlobData(tape, handleId));
        } else if (source.kind === 'liveReadback') {
          csMap.set(handleId, 'source: live GPU readback');
          bdMap.set(handleId, null); // null = live GPU fallback not available in offline view
        } else {
          csMap.set(handleId, source.reason);
          bdMap.set(handleId, null);
        }
      }
    }

    return { contentSourceMap: csMap, blobDataMap: bdMap, defaultViewType: dvType };
  }, [tape, resources]);

  // Compute buffer→draw consumer map
  const consumerMap = useMemo((): Map<string, readonly BufferConsumer[]> => {
    if (!tape || !vm?.draws) return new Map();
    return bufferBindingConsumers(vm.draws, tape.events);
  }, [tape, vm?.draws]);

  const onDrawClickInner = useCallback(
    (drawIdx: number) => {
      setSelectedDrawIdx(drawIdx);
    },
    [setSelectedDrawIdx],
  );

  if (!vm || resources === undefined || resources.size === 0) {
    return (
      <div
        className="p-4 h-full bg-background flex items-center justify-center"
        {...{ [resourceInspectorAnchor()]: 'empty' }}
      >
        <p className="text-xs text-muted-foreground">No resources in tape</p>
      </div>
    );
  }

  return (
    <div
      className="h-full bg-background flex flex-col"
      ref={containerRef}
      {...{ [resourceInspectorAnchor()]: 'loaded' }}
    >
      {/* Search bar */}
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 bg-muted rounded px-2 py-1">
          <Search size={12} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter resources..."
            className="bg-transparent text-xs text-foreground outline-none flex-1 w-0"
          />
        </div>
      </div>

      {/* Resource tables */}
      <div className="flex-1 overflow-y-auto p-1">
        {categorized.map((cat) => (
          <ResourceTable
            key={cat.category}
            category={cat.category}
            items={cat.items}
            filter={filter}
            highlightedHandle={highlightedHandle}
            onHandleClick={handleHandleClick}
            expandedWgsl={expandedWgsl}
            onToggleWgsl={setExpandedWgslToggle}
            expandedBuffers={expandedBuffers}
            onToggleBuffer={toggleBufferExpand}
            bufferViewType={bufferViewTypes.get(cat.items[0]?.handleId ?? '') ?? defaultViewType}
            onBufferViewType={setBufferViewType}
            contentSource={contentSourceMap}
            blobData={blobDataMap}
            consumerMap={consumerMap}
            onDrawClick={onDrawClickInner}
          />
        ))}
      </div>

      {/* Footer info */}
      <div className="px-2 py-1 border-t border-border shrink-0 text-xs text-muted-foreground">
        {resources.size} resources
        {selectedDrawIdx >= 0 && ` | Draw #${selectedDrawIdx}`}
      </div>
    </div>
  );
}
