import type {
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RhiRenderBundleEncoder,
  RhiRenderCommands,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import type { Bookkeeper } from './bookkeeping';
import { RhiNullRenderPassEncoder } from './pass-encoders';

export const bundles = new WeakMap<
  RenderBundle,
  {
    readonly draws: number;
    readonly bindGroups: number;
    readonly resources: readonly object[];
  }
>();

export function createRenderBundleEncoder(
  bookkeeper: Bookkeeper,
  _desc: RenderBundleEncoderDescriptor,
): RhiRenderBundleEncoder {
  const pass = new RhiNullRenderPassEncoder(bookkeeper, null, 'bundle');
  const resources: object[] = [];
  let finished = false;
  const capture =
    (method: keyof RhiRenderCommands, resourceIndex?: number) =>
    (...args: unknown[]) => {
      if (finished)
        throw new RhiError({
          code: 'command-encoder-finished',
          expected: 'an unfinished bundle encoder',
          hint: 'create a new bundle encoder',
        });
      if (resourceIndex !== undefined) resources.push(args[resourceIndex] as object);
      Reflect.apply(pass[method], pass, args);
    };
  return {
    setPipeline: capture('setPipeline', 0),
    setVertexBuffer: capture('setVertexBuffer', 1),
    setIndexBuffer: capture('setIndexBuffer', 0),
    setBindGroup: capture('setBindGroup', 1),
    draw: capture('draw'),
    drawIndexed: capture('drawIndexed'),
    drawIndirect: capture('drawIndirect', 0),
    drawIndexedIndirect: capture('drawIndexedIndirect', 0),
    pushDebugGroup: capture('pushDebugGroup'),
    popDebugGroup: capture('popDebugGroup'),
    insertDebugMarker: capture('insertDebugMarker'),
    finish() {
      if (finished)
        return err(
          new RhiError({
            code: 'command-encoder-finished',
            expected: 'an unfinished bundle encoder',
            hint: 'create a new bundle encoder',
          }),
        );
      finished = true;
      for (const resource of resources) {
        const valid = bookkeeper.validateOwnership(resource);
        if (!valid.ok) return valid;
      }
      const bundle = bookkeeper.register('RenderBundle') as unknown as RenderBundle;
      bundles.set(bundle, { draws: pass.drawCount, bindGroups: pass.bindGroupCount, resources });
      return ok(bundle);
    },
  };
}
