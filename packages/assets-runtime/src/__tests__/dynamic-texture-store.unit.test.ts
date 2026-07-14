// @forgeax/engine-assets-runtime -- DynamicTextureStore coverage (fix issue #709).
// Transient per-frame video texture store: configureGpuDevice / uploadFrame
// (allocate-once + resize-realloc + copy) / getView / destroyAll, driven by a
// small in-memory device stub (no GPU).

import type { Result, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type CopyExternalImageSource,
  type DynamicTextureDevice,
  DynamicTextureStore,
} from '../dynamic-texture-store';

interface Counters {
  created: number;
  destroyed: number;
  copies: number;
}

function makeDevice(counters: Counters): DynamicTextureDevice {
  let nextTex = 0;
  return {
    createTexture: () => {
      counters.created++;
      return ok({ tag: `tex-${nextTex++}` } as unknown as Texture);
    },
    createTextureView: (tex: Texture) =>
      ok({ tag: `view-of-${(tex as unknown as { tag: string }).tag}` } as unknown as TextureView),
    destroyTexture: () => {
      counters.destroyed++;
      return ok(undefined) as Result<void, RhiError>;
    },
    queue: {
      copyExternalImageToTexture: () => {
        counters.copies++;
        return ok(undefined) as Result<void, RhiError>;
      },
    },
  };
}

const CLIP = toShared<'VideoAsset'>(2000) as Handle<'VideoAsset', 'shared'>;
const SOURCE = {} as CopyExternalImageSource;

describe('DynamicTextureStore', () => {
  it('returns undefined before a device is wired', () => {
    const store = new DynamicTextureStore();
    expect(store.uploadFrame(CLIP, SOURCE, 16, 16)).toBeUndefined();
  });

  it('returns undefined for a non-positive source size', () => {
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice({ created: 0, destroyed: 0, copies: 0 }));
    expect(store.uploadFrame(CLIP, SOURCE, 0, 16)).toBeUndefined();
    expect(store.uploadFrame(CLIP, SOURCE, 16, -1)).toBeUndefined();
  });

  it('allocates once, then re-uploads in place for a steady-size clip', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));

    const a = store.uploadFrame(CLIP, SOURCE, 32, 32);
    const b = store.uploadFrame(CLIP, SOURCE, 32, 32);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
    expect(counters.created).toBe(1); // allocate-once
    expect(counters.copies).toBe(2); // re-uploaded each frame
    if (a?.ok && b?.ok) expect(a.value).toBe(b.value); // same view reused
  });

  it('reallocates (destroys old, creates new) when the source size changes', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));
    store.uploadFrame(CLIP, SOURCE, 32, 32);
    store.uploadFrame(CLIP, SOURCE, 64, 64);
    expect(counters.created).toBe(2);
    expect(counters.destroyed).toBe(1);
  });

  it('getView returns the current view after an upload, undefined before', () => {
    const store = new DynamicTextureStore();
    expect(store.getView(CLIP)).toBeUndefined();
    store.configureGpuDevice(makeDevice({ created: 0, destroyed: 0, copies: 0 }));
    store.uploadFrame(CLIP, SOURCE, 8, 8);
    expect(store.getView(CLIP)).toBeDefined();
  });

  it('destroyAll destroys every transient texture and clears the map', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));
    store.uploadFrame(CLIP, SOURCE, 8, 8);
    store.uploadFrame(toShared<'VideoAsset'>(2001) as Handle<'VideoAsset', 'shared'>, SOURCE, 8, 8);
    store.destroyAll();
    expect(counters.destroyed).toBe(2);
    expect(store.getView(CLIP)).toBeUndefined();
  });

  it('surfaces a structured error when texture allocation fails', () => {
    const store = new DynamicTextureStore();
    store.configureGpuDevice({
      createTexture: () => ({ ok: false, error: { code: 'rhi-not-available' } }) as never,
      createTextureView: () => ok({} as unknown as TextureView),
      destroyTexture: () => ok(undefined) as Result<void, RhiError>,
      queue: { copyExternalImageToTexture: () => ok(undefined) as Result<void, RhiError> },
    });
    const res = store.uploadFrame(CLIP, SOURCE, 8, 8);
    expect(res?.ok).toBe(false);
  });
});
