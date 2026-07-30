import type { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '../features/types';

type Frame = {
  readonly count: number;
};

const feature = {
  identity: 'synthetic.context-boundary',
  extract(context) {
    const worlds: readonly World[] = context.worlds;
    const owner: number = context.owner;
    const frameNumber: number = context.frameNumber;
    void worlds;
    void owner;
    void frameNumber;

    // @ts-expect-error extract must not receive a prepare-stage runtime surface
    context.runtime;
    // @ts-expect-error extract must not receive a GPU command encoder
    context.encoder;
    return ok({ count: worlds.length });
  },
  prepare(data, context) {
    const count: number = data.count;
    const caps = context.caps;
    const resources = context.resources;
    const targets = context.targets;
    const frame = context.frame;
    const reportError = context.reportError;
    void count;
    void caps;
    void resources;
    void targets;
    void frame;
    void reportError;

    // @ts-expect-error prepare must not receive the live World collection
    context.worlds;
    // @ts-expect-error prepare must not receive the complete pipeline context
    context.pipeline;
    // @ts-expect-error prepare must not receive a raw device
    context.device;
    // @ts-expect-error prepare must not expose submit or compute commands
    context.submit;
    // @ts-expect-error prepare must not expose storage or indirect commands
    context.storageBuffer;
    // @ts-expect-error prepare must not expose the full command encoder
    context.commandEncoder;
    return ok(undefined);
  },
  contribute(data, context) {
    const count: number = data.count;
    const frame = context.frame;
    const resources = context.resources;
    const targets = context.targets;
    const reportError = context.reportError;
    void count;
    void frame;
    void resources;
    void targets;
    void reportError;

    // @ts-expect-error contribute must not receive the live World collection
    context.worlds;
    // @ts-expect-error contribute must not receive the complete pipeline context
    context.pipeline;
    // @ts-expect-error contribute must not expose raw device access
    context.device;
    // @ts-expect-error contribute must not expose submit, compute, or storage commands
    context.submit;
    // @ts-expect-error contribute must not expose indirect draw commands
    context.drawIndirect;
    // @ts-expect-error Wave1 stops at the graph seam and exposes no GPU commands
    context.commands;
    return ok(undefined);
  },
} satisfies RenderFeature<Frame>;

void feature;
