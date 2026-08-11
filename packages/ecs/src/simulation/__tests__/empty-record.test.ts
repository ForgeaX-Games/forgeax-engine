import { describe, expect, it } from 'vitest';
import { World } from '../../world';

describe('empty SimulationRecordV1 path', () => {
  it('records and restores an empty World without bypassing the contract', () => {
    const source = new World();
    const recordResult = source.simulationRecord();

    expect(recordResult.ok).toBe(true);
    if (!recordResult.ok) return;
    expect(recordResult.value.formatVersion).toBe(1);
    expect(recordResult.value.recordTick).toBe(0);
    expect(recordResult.value.world.entities).toEqual([]);
    expect(recordResult.value.participants).toEqual([]);
    expect(recordResult.value.trace).toEqual([]);

    const target = new World();
    const baseline = target.simulationFingerprint();
    const restored = target.simulationRestore(recordResult.value);
    expect(restored.ok).toBe(true);
    expect(target.simulationFingerprint()).toBe(baseline);
  });

  it('keeps an empty record fingerprint stable and rejects corruption before mutation', () => {
    const source = new World();
    const record = source.simulationRecord().unwrap();
    const target = new World();
    const baseline = target.simulationFingerprint();

    const corrupted = target.simulationRestore({ ...record, fingerprint: 'simulation-v1:corrupt' });
    expect(corrupted.ok).toBe(false);
    if (!corrupted.ok) expect(corrupted.error.code).toBe('simulation-record-invalid');
    expect(target.simulationFingerprint()).toBe(baseline);
    expect(source.simulationRecord().unwrap().fingerprint).toBe(record.fingerprint);
  });
});
