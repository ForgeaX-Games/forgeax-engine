import { resolveReflectionProbeBinding } from '../record/frame-lighting';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { ReflectionProbeRecordState } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';

export function materialBindingKey(
  source: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
  handle: number,
): string {
  return `${source.worldId}:${source.entityKey}:${handle}`;
}

/** Per-object bindings and pass membership are part of an indirect batch's resource identity. */
export function projectMaterialBindingClasses(
  rows: readonly Pick<ValidatedRenderable, 'source'>[],
  probes?: Pick<ReflectionProbeRecordState, 'selections' | 'table'>,
): ReadonlyMap<string, string> {
  const classes = new Map<string, string>();
  for (const row of rows) {
    const selection = probes?.selections.get(`${row.source.worldId}:${row.source.entityKey}`);
    const probe =
      selection === undefined
        ? undefined
        : resolveReflectionProbeBinding(selection, probes?.table).probeIndex;
    const materials =
      row.source.materials.length > 0 ? row.source.materials : [row.source.material];
    for (const material of materials) {
      const handle = material.materialHandle ?? -1;
      const passClass = material.deferredPass === true ? '' : 'forward';
      if (probe !== undefined || passClass !== '')
        classes.set(materialBindingKey(row.source, handle), `${passClass}|probe:${probe ?? ''}`);
    }
  }
  return classes;
}
