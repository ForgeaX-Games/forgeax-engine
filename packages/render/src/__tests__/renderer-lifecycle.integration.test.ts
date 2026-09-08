import { describe, expect, it } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { DeviceScope, LifecycleTransaction } from '../device/device-scope';
import { RenderRecoveryError } from '../errors/recover';
import { LifecycleConstructionError, type RenderError } from '../errors/render';

describe('renderer lifecycle', () => {
  it('rejects missing construction input', async () => {
    await expect(constructRenderer(undefined, { rhi })).rejects.toBeDefined();
  });

  it('keeps the lifecycle tree structural and independent from a GPU backend', async () => {
    const scope = DeviceScope.create(60, 'renderer');
    const transaction = new LifecycleTransaction(scope);
    transaction.add({
      kind: 'scene-table',
      create: () => ({ id: 'scene-table' }),
      cleanup: () => undefined,
    });

    const result = await transaction.commit();

    expect(result.ok).toBe(true);
    expect(scope.generation).toBe(60);
    expect(scope.resourceDelta()).toBe(1);
  });

  it('keeps lifecycle and recovery failures structured without message parsing', () => {
    const receipt = { owner: 'renderer', generation: 61, resourceCount: 0 } as const;
    const lifecycleError = new LifecycleConstructionError({
      owner: receipt.owner,
      generation: receipt.generation,
      operation: 'create',
      resourceKind: 'pipeline',
      cause: new Error('driver failure'),
      cleanupFailures: [],
      receipt,
    });
    const renderError: RenderError = lifecycleError;
    expect(renderError.code).toBe('lifecycle-construction-failed');
    expect(renderError.detail.owner).toBe('renderer');
    expect(renderError.detail.receipt).toEqual(receipt);
    expect(renderError.hint).toContain('recover');

    const recoveryError = new RenderRecoveryError('recover-lifecycle-failed', {
      owner: receipt.owner,
      generation: receipt.generation,
      recovery: 'recover',
      receipt,
      cause: lifecycleError,
    });
    expect(recoveryError.code).toBe('recover-lifecycle-failed');
    expect(recoveryError.detail.receipt).toEqual(receipt);
    expect(recoveryError.hint).toContain('rebuild');
  });
});

import { rhi } from '@forgeax/engine-rhi-null';
