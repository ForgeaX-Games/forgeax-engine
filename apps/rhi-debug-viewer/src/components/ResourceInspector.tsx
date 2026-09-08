import type { ReplayReadbackResult, RhiDebugError } from '@forgeax/engine-rhi-debug';
import { useEffect, useMemo, useState } from 'react';
import { bufferRange, formatBufferHex, formatBufferTyped } from '../buffer-view';
import { useSelection } from '../selection-context';
import { resourceInspectorAnchor, resourceRowAnchor } from '../selectors';
import { useReadResource, useViewModel } from '../viewer-context';

export function ResourceInspector(_props?: { readonly className?: string }) {
  const model = useViewModel();
  const readResource = useReadResource();
  const { selectedWorkIndex, selectedResourceId, selectResource, selectWork } = useSelection();
  const [filter, setFilter] = useState('');
  const [readback, setReadback] = useState<ReplayReadbackResult | null>(null);
  const [readbackError, setReadbackError] = useState<RhiDebugError | null>(null);
  const resources = useMemo(() => {
    const all = model?.resources ?? [];
    const needle = filter.trim().toLowerCase();
    return needle.length === 0
      ? all
      : all.filter((resource) => resource.resourceId.toLowerCase().includes(needle));
  }, [filter, model]);
  const focusedResource =
    resources.find((resource) => resource.resourceId === selectedResourceId) ??
    (selectedWorkIndex >= 0
      ? resources.find((resource) =>
          resource.consumers.some((consumer) => consumer.workIndex === selectedWorkIndex),
        )
      : undefined);
  const selectedResource =
    selectedResourceId === null
      ? undefined
      : model?.resources.find((resource) => resource.resourceId === selectedResourceId);
  const readsBytes = selectedResource?.kind === 'buffer';
  const selected = selectedWorkIndex >= 0 || selectedResourceId !== null;

  const inspectResource = (resourceId: string) => {
    const resource = model
      ? model.resources.find((item) => item.resourceId === resourceId)
      : undefined;
    const consumer = resource?.consumers.find((item) => item.workIndex !== null);
    if (consumer?.workIndex !== null && consumer?.workIndex !== undefined)
      selectWork(consumer.workIndex, consumer.eventIndex, resource?.createEventIndex ?? -1);
    selectResource(resourceId);
  };

  useEffect(() => {
    setReadback(null);
    setReadbackError(null);
    if (selectedResourceId === null || readResource === null || !readsBytes) return;
    const request = new AbortController();
    void readResource(selectedResourceId, undefined, request.signal).then((result) => {
      if (request.signal.aborted) return;
      if (result.ok) setReadback(result.value);
      else setReadbackError(result.error);
    });
    return () => request.abort();
  }, [readResource, readsBytes, selectedResourceId]);

  return (
    <section
      className="forgeax-panel overflow-auto"
      {...{ [resourceInspectorAnchor()]: selected ? 'selected' : 'empty' }}
    >
      <header className="forgeax-panel-header">
        <span>Resource Inspector</span>
        <span className="forgeax-badge">{resources.length} shown</span>
      </header>
      <div className="p-3">
        <label className="forgeax-field-label block">
          <span className="mb-1 block">Filter resources</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="w-full font-mono normal-case tracking-normal"
            placeholder="texture:, buffer:, pipeline:..."
            aria-label="Filter resource IDs"
          />
        </label>
        <div className="max-h-64 space-y-1 overflow-auto pt-3 pr-1">
          {resources.length === 0 ? (
            <p className="text-xs text-muted-foreground">No resources in tape</p>
          ) : (
            resources.map((resource) => (
              <button
                type="button"
                key={resource.resourceId}
                className={
                  selectedResourceId === resource.resourceId
                    ? 'w-full rounded-md border border-brand/35 bg-brand/10 px-2 py-1.5 text-left text-xs text-brand'
                    : 'w-full rounded-md border border-border/70 bg-background/35 px-2 py-1.5 text-left text-xs transition-colors hover:border-brand/25 hover:bg-muted/60'
                }
                onClick={() => inspectResource(resource.resourceId)}
                {...{ [resourceRowAnchor()]: resource.resourceId }}
              >
                <span className="font-mono">{resource.resourceId}</span>
                <span className="ml-2 text-muted-foreground">{resource.kind}</span>
              </button>
            ))
          )}
        </div>
        {selected && (
          <p className="pt-3 text-[10px] text-muted-foreground">
            Linked from workIndex {selectedWorkIndex}
          </p>
        )}
        {focusedResource !== undefined && (
          <div className="mt-3 space-y-1 rounded-lg border border-border/70 bg-background/45 p-2.5 text-xs">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-brand">
              Resource facts
            </div>
            <div className="forgeax-code-block break-all">
              {JSON.stringify(focusedResource.descriptor)}
            </div>
            <div>lifecycle {focusedResource.lifecycle.state}</div>
            <div>consumers {focusedResource.consumers.length}</div>
            {focusedResource.consumers.map((consumer) => (
              <div key={`${consumer.eventIndex}:${consumer.access}`} className="font-mono">
                eventIndex {consumer.eventIndex} workIndex {consumer.workIndex ?? 'none'}{' '}
                {consumer.access}
              </div>
            ))}
          </div>
        )}
        {readsBytes && selectedResourceId !== null && readback !== null && (
          <div className="mt-3 rounded-lg border border-success/25 bg-success/5 p-2.5 text-xs">
            <div className="text-brand">Readback {selectedResourceId}</div>
            {readback.kind === 'texture' ? (
              <div className="font-mono">
                {readback.format ?? 'texture'} {readback.width ?? 0}x{readback.height ?? 0}
                <div data-forgeax-resource-provenance>
                  {readback.provenance.resourceId} {JSON.stringify(readback.provenance.subresource)}
                </div>
              </div>
            ) : (
              <BufferResult result={readback} />
            )}
          </div>
        )}
        {readsBytes && selectedResourceId !== null && readbackError !== null && (
          <div className="mt-3 rounded-lg border border-danger/25 bg-danger/5 p-2.5 text-xs text-danger">
            <div data-forgeax-buffer-status={readbackError.code}>{readbackError.code}</div>
            <div>{readbackError.code}</div>
            <div>{readbackError.hint}</div>
          </div>
        )}
        {readsBytes &&
          selectedResourceId !== null &&
          readback === null &&
          readbackError === null && (
            <div
              className="mt-3 text-xs text-muted-foreground"
              data-forgeax-buffer-status="pending"
            >
              Readback pending
            </div>
          )}
      </div>
    </section>
  );
}

function BufferResult({ result }: { readonly result: ReplayReadbackResult }) {
  const range = bufferRange(result);
  return (
    <div className="space-y-1 font-mono" data-forgeax-buffer-status="ok">
      <div>offset {range.offset}</div>
      <div>size {range.size}</div>
      <div>hex {formatBufferHex(result.bytes)}</div>
      <div>{formatBufferTyped(result.bytes)}</div>
    </div>
  );
}
