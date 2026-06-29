// BindingsPanel.tsx — renders selected draw's bindings table and drawCall summary.
//
// Reads ViewModel.draws[selectedIdx] for per-draw bindings and draw call metadata.
// Each binding row shows: group index / binding slot / resource kind / handleId.
// DrawCall summary shows: pipelineKind, pipeline handleId, and draw-specific
// fields (vertexCount/instanceCount/indexCount for draws, dispatch dimensions
// for compute dispatches).
//
// Imports data-forgeax-* constants from selectors.ts (AC-13).
//
// Related: AC-08/AC-13; plan-strategy D-5 (selectors SSOT).

import type { DrawEntry } from '../viewer-model';

export interface BindingsPanelProps {
  readonly draw: DrawEntry;
}

export function BindingsPanel({ draw }: BindingsPanelProps) {
  return (
    <div className="space-y-4">
      {/* Draw call summary */}
      <section>
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Draw Call</h2>
        <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-3 text-xs font-mono space-y-1">
          <Row label="Pipeline" value={draw.drawCall.pipelineHandleId} />
          <Row label="Kind" value={draw.drawCall.pipelineKind} />
          {draw.drawCall.vertexCount !== undefined && (
            <Row label="Vertices" value={String(draw.drawCall.vertexCount)} />
          )}
          {draw.drawCall.instanceCount !== undefined && draw.drawCall.instanceCount > 1 && (
            <Row label="Instances" value={String(draw.drawCall.instanceCount)} />
          )}
          {draw.drawCall.indexCount !== undefined && (
            <Row label="Indices" value={String(draw.drawCall.indexCount)} />
          )}
          {draw.drawCall.dispatchX !== undefined && (
            <Row
              label="Dispatch"
              value={`${draw.drawCall.dispatchX} x ${draw.drawCall.dispatchY} x ${draw.drawCall.dispatchZ}`}
            />
          )}
        </div>
      </section>

      {/* Binding group entries */}
      <section>
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Bindings</h2>
        {draw.bindings.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No bindings active</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-1.5 px-2 font-medium">Group</th>
                  <th className="py-1.5 px-2 font-medium">Slot</th>
                  <th className="py-1.5 px-2 font-medium">Kind</th>
                  <th className="py-1.5 px-2 font-medium">Handle</th>
                </tr>
              </thead>
              <tbody>
                {draw.bindings.map((b) => (
                  <tr
                    key={`${b.groupIndex}:${b.entryIndex}:${b.handleId}`}
                    className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900"
                  >
                    <td className="py-1 px-2 text-slate-500">@{b.groupIndex}</td>
                    <td className="py-1 px-2">slot {b.entryIndex}</td>
                    <td className="py-1 px-2">
                      <BindingKindBadge kind={b.kind} />
                    </td>
                    <td className="py-1 px-2 text-slate-500">{b.handleId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-slate-400 w-20 flex-shrink-0">{label}</span>
      <span className="text-slate-700 dark:text-slate-300 break-all">{value}</span>
    </div>
  );
}

function BindingKindBadge({ kind }: { readonly kind: string }) {
  const colors: Record<string, string> = {
    buffer: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300',
    texture: 'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300',
    sampler: 'bg-rose-100 dark:bg-rose-900 text-rose-700 dark:text-rose-300',
    textureView: 'bg-cyan-100 dark:bg-cyan-900 text-cyan-700 dark:text-cyan-300',
  };
  const color = colors[kind] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
  return <span className={`px-1.5 py-0.5 rounded font-semibold ${color}`}>{kind}</span>;
}
