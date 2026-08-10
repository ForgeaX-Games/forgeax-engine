import { beforeEach, describe, expect, it } from 'vitest';
import directionalCase from '../cases/directional-urp.json' with { type: 'json' };
import { captureForgeax } from '../../../src/main';
import type { SceneCase } from '../../../src/contracts/types';

const sceneCase = directionalCase as unknown as SceneCase;

describe('direct-light URP browser producer evidence', () => {
  beforeEach(() => {
    document.body.innerHTML = '<canvas id="forgeax"></canvas>';
  });

  it('captures linear HDR from the current producer attachment', async () => {
    const capture = await captureForgeax(sceneCase);
    const observation = capture.observations?.linearHdr;

    expect(observation?.status).toBe('ready');
    expect(observation?.format).toBe('rgba16float');
    expect(observation?.bytes?.byteLength).toBeGreaterThan(0);
    expect(observation?.rawHash).toMatch(/^[0-9a-f]{8,}$/);
    expect(observation?.frameId).toBeTypeOf('number');
    expect(observation?.pipelineId).toBe('forgeax::urp');
    expect(observation?.backendId).toBeTypeOf('string');
    expect(capture.config.readback?.linearReadback).toBe(true);
    expect(capture.config.readback?.namedAttachment).toBe(true);
  });
});
