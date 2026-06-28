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
import { useSelection } from '../selection-context';
import { resourceInspectorAnchor, resourceRowAnchor } from '../selectors';
import { useViewModel } from '../viewer-context';
import type { CreateDescriptor } from '../viewer-model';

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
}: {
  category: ResourceCategory;
  items: readonly CreateDescriptor[];
  filter: string;
  highlightedHandle: string | null;
  onHandleClick: (handleId: string) => void;
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
      <div className="px-2 py-1 text-xs font-medium text-blue-400/80 border-b border-slate-700/30">
        {category} ({filtered.length})
      </div>
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((item) => (
          <ResourceRow
            key={item.handleId}
            item={item}
            isHighlighted={highlightedHandle === item.handleId}
            onHandleClick={onHandleClick}
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
}: {
  item: CreateDescriptor;
  isHighlighted: boolean;
  onHandleClick: (handleId: string) => void;
}) {
  const handleClick = useCallback(() => {
    onHandleClick(item.handleId);
  }, [item.handleId, onHandleClick]);

  const className = `text-xs px-2 py-0.5 flex items-center gap-2 transition-colors ${
    isHighlighted
      ? 'bg-blue-900/30 border-l-2 border-blue-500'
      : 'hover:bg-slate-800/50 border-l-2 border-transparent'
  }`;

  const detail = renderDetail(item);

  return (
    <div className={className} {...{ [resourceRowAnchor()]: item.handleId }}>
      <button
        type="button"
        onClick={handleClick}
        className="text-blue-400 hover:text-blue-300 font-mono shrink-0 text-left"
      >
        {item.handleId}
      </button>
      <span className="text-slate-500 truncate">{detail}</span>
    </div>
  );
}

function renderDetail(item: CreateDescriptor): string {
  switch (item.kind) {
    case 'createBuffer':
      return `size=${item.size}, usage=${decodeBufferUsage(item.usage)}`;
    case 'createTexture':
      return `fmt=${item.format}, ${item.size.join('x')}, ${textureDimensionLabel(item.dimension)}, usage=${decodeTextureUsage(item.usage)}`;
    case 'createSampler':
      return 'sampler';
    case 'createBindGroupLayout':
      return `${item.entries.length} entries`;
    case 'createPipelineLayout':
      return `${item.bglHandleIds.length} BGLs`;
    case 'createRenderPipeline':
      return `vs=${item.vertexShaderModuleHandleId ?? '?'}, fs=${item.fragmentShaderModuleHandleId ?? '?'}`;
    case 'createShaderModule': {
      const preview = item.wgslCode.slice(0, 60).replace(/\n/g, ' ');
      return preview;
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
  const { selectedDrawIdx } = useSelection();
  const [filter, setFilter] = useState('');
  const [highlightedHandle, setHighlightedHandle] = useState<string | null>(null);
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

  const resources = vm?.resources;
  const categorized = useMemo(() => (resources ? categorizeResources(resources) : []), [resources]);

  if (!vm || resources === undefined || resources.size === 0) {
    return (
      <div
        className="p-4 h-full bg-slate-900 flex items-center justify-center"
        {...{ [resourceInspectorAnchor()]: 'empty' }}
      >
        <p className="text-xs text-slate-500">No resources in tape</p>
      </div>
    );
  }

  return (
    <div
      className="h-full bg-slate-900 flex flex-col"
      ref={containerRef}
      {...{ [resourceInspectorAnchor()]: 'loaded' }}
    >
      {/* Search bar */}
      <div className="px-2 py-1.5 border-b border-slate-700/50 shrink-0">
        <div className="flex items-center gap-1.5 bg-slate-800 rounded px-2 py-1">
          <Search size={12} className="text-slate-500 shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter resources..."
            className="bg-transparent text-xs text-slate-300 outline-none flex-1 w-0"
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
          />
        ))}
      </div>

      {/* Footer info */}
      <div className="px-2 py-1 border-t border-slate-700/50 shrink-0 text-xs text-slate-600">
        {resources.size} resources
        {selectedDrawIdx >= 0 && ` | Draw #${selectedDrawIdx}`}
      </div>
    </div>
  );
}
