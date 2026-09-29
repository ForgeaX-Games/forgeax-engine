import { describe, expect, it } from 'vitest';
import {
  beginProbeIblUpdate,
  createProbeIblOutput,
  publishProbeIblOutput,
} from '@forgeax/engine-render';

describe('ReflectionProbe Dawn paired evidence contract', () => {
  it('retains the filtered LKG when PMREM submission fails', () => {
    const output = createProbeIblOutput({ entityKey: 4, resolution: 64, deviceGeneration: 0 });
    const update = beginProbeIblUpdate(output);
    const failed = publishProbeIblOutput(update, { stage: 'raw', ok: false });
    expect(failed.filteredGeneration).toBe(0);
    expect(failed.lkg).toBe(true);
  });

  it('does not promote a raw candidate as a filtered result', () => {
    const output = createProbeIblOutput({ entityKey: 4, resolution: 64, deviceGeneration: 0 });
    const update = beginProbeIblUpdate(output);
    const raw = publishProbeIblOutput(update, { stage: 'raw', ok: true });
    expect(raw.rawGeneration).toBe(update.candidateGeneration);
    expect(raw.filteredGeneration).toBe(0);
  });
});
