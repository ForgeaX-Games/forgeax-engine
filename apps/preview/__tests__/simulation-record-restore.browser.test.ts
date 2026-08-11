import { createApp, type App, type BootstrapContext } from '@forgeax/engine-app';
import { AudioSource, audioPlugin } from '@forgeax/engine-audio';
import { FixedTime } from '@forgeax/engine-ecs';
import type { InputBackend } from '@forgeax/engine-input';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { AudioClipAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap } from '../../../templates/game-default/main';
import { compareSimulationEvidence } from '../../../templates/game-default/assets/plugins/simulation-evidence';

const runtimeBinding = createStandaloneRuntimeAssetBinding(
  import.meta.env.FORGEAX_RUNTIME_SCOPE_ID ?? 'preview-simulation',
);

function inputBackend(): InputBackend {
  return {
    sample: () => ({
      downKeys: new Set<string>(),
      upKeys: new Set<string>(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    }),
    detach: () => undefined,
  };
}

function context(app: App): BootstrapContext {
  return {
    assets: app.renderer.assets,
    app,
    renderer: app.renderer,
  };
}

function pcmClip(): AudioClipAsset {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index) ?? 0;
  };
  text(0, 'RIFF');
  view.setUint32(4, 38, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 2, true);
  view.setInt16(44, 0, true);
  return { kind: 'audio', sourceKey: 'm4-preview-tone.wav', bytes };
}

describe('Preview authored simulation record/restore', () => {
  let host: HTMLDivElement | undefined;
  let apps: Array<{ stop(): unknown }> = [];

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'display:flex;width:640px;height:240px';
    document.body.appendChild(host);
  });

  afterEach(() => {
    for (const app of apps) app.stop();
    apps = [];
    host?.remove();
    host = undefined;
  });

  it('records the authored World and restores it into a fresh registered target', async () => {
    const sourceCanvas = document.createElement('canvas');
    const targetCanvas = document.createElement('canvas');
    sourceCanvas.id = 'app';
    for (const canvas of [sourceCanvas, targetCanvas]) {
      canvas.width = 320;
      canvas.height = 240;
      canvas.style.cssText = 'width:320px;height:240px';
      host?.appendChild(canvas);
    }

    const create = async (canvas: HTMLCanvasElement) => {
      const result = await createApp(
        canvas,
        {
          input: inputBackend(),
          plugins: [audioPlugin(), physicsPlugin('rapier-3d')],
        },
        { importTransport: createDevImportTransport(runtimeBinding) },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      result.value.renderer.assets.configureRuntimeBinding(runtimeBinding);
      apps.push(result.value);
      return result.value;
    };

    const source = await create(sourceCanvas);
    const target = await create(targetCanvas);
    await bootstrap(source.world, context(source));

    sourceCanvas.removeAttribute('id');
    targetCanvas.id = 'app';
    await bootstrap(target.world, context(target));
    target.world.despawnAll().unwrap();
    targetCanvas.removeAttribute('id');
    sourceCanvas.id = 'app';
    expect(target.world.inspect().entityCount).toBe(0);

    const clip = source.world.allocSharedRef('AudioClipAsset', pcmClip());
    const audioEntity = source.world
      .spawn({ component: AudioSource, data: { clip, playing: true, spatialBlend: 1 } })
      .unwrap();
    source.world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
        { component: Collider, data: { shape: ColliderShapeValue.cuboid } },
        { component: CollidingEntities, data: { entities: [] } },
      )
      .unwrap();
    source.world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.cuboid } },
        { component: CollidingEntities, data: { entities: [] } },
      )
      .unwrap();

    for (let index = 0; index < 8; index += 1) source.world.update(1 / 60).unwrap();
    const collisionRows = [...source.world.query({ read: [CollidingEntities] }).unwrap()];
    const collisionEntities = collisionRows.flatMap((row) => [
      ...source.world.get(row.entity, CollidingEntities).unwrap().entities,
    ]);
    expect(collisionEntities.length).toBeGreaterThan(0);
    const record = source.world.simulationRecord();
    expect(record.ok, record.ok ? undefined : JSON.stringify(record.error)).toBe(true);
    if (!record.ok) return;

    const participantIds = record.value.participants.map((participant) => participant.id);
    expect(participantIds).toEqual(
      expect.arrayContaining(['forgeax.physics.rapier-3d', 'forgeax.audio.ecs']),
    );
    expect(participantIds).toContain('forgeax.audio.host-webaudio');
    const physicsState = record.value.participants.find(
      (participant) => participant.id === 'forgeax.physics.rapier-3d',
    )?.state as { bodies?: readonly unknown[] } | undefined;
    const audioState = record.value.participants.find(
      (participant) => participant.id === 'forgeax.audio.ecs',
    )?.state as { intents?: readonly unknown[]; playing?: readonly unknown[] } | undefined;
    expect(physicsState?.bodies?.length ?? 0).toBeGreaterThan(0);
    expect((audioState?.intents?.length ?? 0) + (audioState?.playing?.length ?? 0)).toBeGreaterThan(0);

    expect(target.world.getResource(FixedTime).tick).toBe(0);
    const restored = target.world.simulationRestore(record.value);
    expect(restored.ok, restored.ok ? undefined : JSON.stringify(restored.error)).toBe(true);
    expect(target.world.inspect().entityCount).toBe(record.value.world.entities.length);
    expect(target.world.getResource(FixedTime).tick).toBe(record.value.recordTick);
    const sourceRecordAfterRun = record;
    const targetRecordAfterRun = target.world.simulationRecord();
    expect(targetRecordAfterRun.ok).toBe(true);
    if (!targetRecordAfterRun.ok) return;
    const sourcePhysicsStateAfterRun = sourceRecordAfterRun.value.participants.find(
      (participant) => participant.id === 'forgeax.physics.rapier-3d',
    )?.state as { collisionPairs?: readonly [number, readonly number[]][] } | undefined;
    const targetPhysicsStateAfterRun = targetRecordAfterRun.value.participants.find(
      (participant) => participant.id === 'forgeax.physics.rapier-3d',
    )?.state as { collisionPairs?: readonly [number, readonly number[]][] } | undefined;
    const sourceAudioStateAfterRun = sourceRecordAfterRun.value.participants.find(
      (participant) => participant.id === 'forgeax.audio.ecs',
    )?.state as { intents?: readonly unknown[]; playing?: readonly unknown[] } | undefined;
    const targetAudioState = targetRecordAfterRun.value.participants.find(
      (participant) => participant.id === 'forgeax.audio.ecs',
    )?.state as { intents?: readonly unknown[]; playing?: readonly unknown[] } | undefined;
    const sourceAudioEvents =
      (sourceAudioStateAfterRun?.intents?.length ?? 0) +
      (sourceAudioStateAfterRun?.playing?.length ?? 0);
    const targetAudioEvents =
      (targetAudioState?.intents?.length ?? 0) + (targetAudioState?.playing?.length ?? 0);
    const sourceCollisionPairs = sourcePhysicsStateAfterRun?.collisionPairs ?? [];
    const targetCollisionPairs = targetPhysicsStateAfterRun?.collisionPairs ?? [];
    const sourceCollisionEvents = sourceCollisionPairs.reduce(
      (count, [, others]) => count + others.length,
      0,
    );
    const targetCollisionEvents = targetCollisionPairs.reduce(
      (count, [, others]) => count + others.length,
      0,
    );
    const targetEntityCount = targetRecordAfterRun.value.world.entities.length;
    const danglingEntityRefs = targetCollisionPairs.reduce(
      (count, [entity, others]) =>
        count +
        (entity >= targetEntityCount ? 1 : 0) +
        others.filter((other) => other >= targetEntityCount).length,
      0,
    );
    const extraEvents = Math.abs(sourceAudioEvents - targetAudioEvents);
    const report = compareSimulationEvidence({
      source: sourceRecordAfterRun.value,
      target: targetRecordAfterRun.value,
      collision: { sourceCount: sourceCollisionEvents, targetCount: targetCollisionEvents },
      audio: { sourceCount: sourceAudioEvents, targetCount: targetAudioEvents },
      cleanup: { danglingEntityRefs, extraEvents },
    });
    expect(report.ok, report.ok ? undefined : JSON.stringify(report.error)).toBe(true);
    if (report.ok) {
      expect(report.value.verdict, JSON.stringify(report.value.mismatches)).toBe('match');
      expect(report.value.entries.map((entry) => entry.domain)).toEqual(
        expect.arrayContaining(['world', 'collision', 'audio', 'cleanup', 'final-invariant']),
      );
      expect(collisionEntities.length).toBeGreaterThan(0);
      expect(sourceCollisionEvents).toBeGreaterThan(0);
      expect(sourceAudioEvents).toBeGreaterThan(0);
      expect(danglingEntityRefs).toBe(0);
      expect(extraEvents).toBe(0);
    }

    const targetRecord = target.world.simulationRecord();
    expect(targetRecord.ok).toBe(true);
    if (targetRecord.ok) {
      expect(targetRecord.value.world.entities.length).toBe(record.value.world.entities.length);
      expect(targetRecord.value.participants.map((participant) => participant.id)).toEqual(participantIds);
    }
  }, 60_000);
});
