import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '../index';

interface Frame {
  readonly count: number;
}

const feature = {
  identity: 'prepared.graphics.negative',
  extract: () => ok<Frame>({ count: 1 }),
  prepare(data, context) {
    void data;
    void context.graphics;

    // @ts-expect-error prepared callbacks cannot access a raw device
    context.graphics.device;
    // @ts-expect-error prepared callbacks cannot access a command encoder
    context.graphics.commandEncoder;
    // @ts-expect-error prepared callbacks cannot access the full pipeline context
    context.graphics.pipelineContext;
    // @ts-expect-error prepared callbacks cannot issue submit work
    context.graphics.submit;
    // @ts-expect-error prepared callbacks cannot issue compute work
    context.graphics.compute;
    // @ts-expect-error prepared callbacks cannot access storage buffers
    context.graphics.storageBuffer;
    // @ts-expect-error prepared callbacks cannot issue indirect draws
    context.graphics.drawIndirect;
    // @ts-expect-error prepared callbacks cannot access backend-specific handles
    context.graphics.backendHandle;
    return ok(undefined);
  },
  contribute(data, context) {
    void data;
    void context.graphics;
    // The legacy graph-only entry remains the only way to add ordinary graph work.
    void context.staging.addPass;

    // @ts-expect-error contribution cannot access a raw device
    context.graphics.device;
    // @ts-expect-error contribution cannot access a command encoder
    context.graphics.commandEncoder;
    // @ts-expect-error contribution cannot access the full pipeline context
    context.graphics.pipelineContext;
    // @ts-expect-error contribution cannot issue submit work
    context.graphics.submit;
    // @ts-expect-error contribution cannot issue compute work
    context.graphics.compute;
    // @ts-expect-error contribution cannot access storage buffers
    context.graphics.storageBuffer;
    // @ts-expect-error contribution cannot issue indirect draws
    context.graphics.drawIndirect;
    // @ts-expect-error contribution cannot access backend-specific handles
    context.graphics.backendHandle;
    return ok(undefined);
  },
} satisfies RenderFeature<Frame>;

void feature;
