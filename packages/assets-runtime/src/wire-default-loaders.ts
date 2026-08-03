// @forgeax/engine-assets-runtime - wireDefaultLoaders + seed-table SSOT
// (feat-20260603-asset-import-loader-injection M1 / w5 + w8; restructured by
// feat-20260705-runtime-tier2-decomposition M1 / w8, D-2).
//
// wireDefaultLoaders is a one-line host helper that wires the engine's default
// loader set onto a `LoaderRegistry`, mirroring the Console
// `wireDefaultInspectors` shape (packages/console/src/wire-default-inspectors.ts;
// research Finding 8). An AI user that has wired inspectors once recognises the
// same form here at near-zero cost (requirements §AI User Affordances).
//
// The two seed tables INLINE_PACK_LOADERS + PACK_ARTIFACT_LOADERS are the
// default set. videoLoader lives in graphics-extras and is wired here. The
// renderer supplies its concrete Web Audio loader through `extraLoaders`, so
// this package remains independent of the Web Audio backend while the
// production registry still has all 13 engine-owned kinds.
//
// Default set wired internally (13 kinds):
//   inline pack-payload (8): mesh / scene / sampler / material / skeleton /
//     skin / animation-clip / animation-graph
//   upstream-branch (3):     texture / font / equirect
//   video (1):               video (videoLoader, graphics-extras)
//   UI (1):                  ui (engine-ui)
//
// Deliberately NOT registered (AC-02 exclusion): render-pipeline / shader --
// these have no inline loader today; `loadByGuid` on them surfaces
// `loader-not-registered` (charter P3) rather than a silent miss.

import { videoLoader } from '@forgeax/engine-graphics-extras';
import type { Loader } from '@forgeax/engine-types';
import { createUiLoader, type UiAsset } from '@forgeax/engine-ui';
import { LoaderRegistry } from './loader-registry';
import { INLINE_PACK_LOADERS } from './loaders/inline-pack';
import { PACK_ARTIFACT_LOADERS } from './loaders/pack-artifact';

const uiPayloadLoader = createUiLoader();
const uiLoader: Loader<UiAsset> = {
  kind: 'ui',
  load: (payload) => {
    const result = uiPayloadLoader.load(payload);
    return result.ok ? result.value : undefined;
  },
};

/**
 * Wire the engine's default loader set (13 engine-owned kinds: 8 inline +
 * texture + font + equirect + video + UI) plus any `extraLoaders` onto `registry` in
 * one call. Returns the same `registry` for chaining (so `wireDefaultLoaders(new
 * LoaderRegistry())` is a one-expression wired registry). The `extraLoaders` are
 * appended after the defaults; the production assembly point injects its
 * concrete audio catalog-entry loader to complete the 12-kind set.
 *
 * @example
 * ```ts
 * import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-assets-runtime';
 * const loaders = wireDefaultLoaders(new LoaderRegistry());
 * // loaders.get('mesh') / .get('texture') / .get('font') / .get('video') are
 * // non-undefined; audio is supplied via extraLoaders at the assembly point;
 * // render-pipeline / shader stay undefined.
 * ```
 */
export function wireDefaultLoaders(
  registry: LoaderRegistry,
  extraLoaders: readonly Loader[] = [],
): LoaderRegistry {
  for (const loader of INLINE_PACK_LOADERS) registry.register(loader);
  for (const loader of PACK_ARTIFACT_LOADERS) registry.register(loader);
  registry.register(videoLoader);
  registry.register(uiLoader);
  for (const loader of extraLoaders) registry.register(loader);
  return registry;
}

/**
 * Convenience factory: a fresh `LoaderRegistry` pre-wired with the default
 * loader set (plus any `extraLoaders`). The production assembly point
 * (`createRenderer`) and tests pass the result into `new LoaderRegistry()` (D-7
 * constructor-injection; loaders always wired at construction -- used by
 * `AssetRegistry` internally via `createDefaultLoaderRegistry(extraLoaders)` and
 * by host code / tests independently) -- no setter / no illegal intermediate
 * state).
 */
export function createDefaultLoaderRegistry(extraLoaders: readonly Loader[] = []): LoaderRegistry {
  return wireDefaultLoaders(new LoaderRegistry(), extraLoaders);
}
