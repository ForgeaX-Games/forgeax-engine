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
// D-2 (feat-20260705-runtime-tier2-decomposition): the two seed tables
// INLINE_PACK_LOADERS + UPSTREAM_ENTRY_LOADERS are the SSOT here (imported from
// the extracted loader modules created by w4). D-2 terminal (M3 / w32):
// videoLoader now lives in @forgeax/engine-graphics-extras and is statically
// imported + wired here (assets-runtime -> graphics-extras forward edge; ci.yml
// builds graphics-extras before assets-runtime). Only the audio placeholder
// stays caller-supplied via `extraLoaders` (OOS-9 -- its final home is coupled
// with the audio unified import path). The sole production assembly site
// (createRenderer, w10) passes `[audioLoaderPlaceholder]` to complete the
// 11-kind set. This keeps the F4 reverse edge (wire -> audio loader) broken
// while keeping registration behaviour equivalent.
//
// Default set wired internally (10 kinds):
//   inline pack-payload (6): mesh / scene / material / skeleton / skin /
//     animation-clip
//   upstream-branch (3):     texture / font / equirect
//   video (1):               video (videoLoader, graphics-extras)
//
// Deliberately NOT registered (AC-02 exclusion): sampler / render-pipeline /
// shader -- these have no inline loader today; `loadByGuid` on them surfaces
// `loader-not-registered` (charter P3) rather than a silent miss.

import { videoLoader } from '@forgeax/engine-graphics-extras';
import type { Loader } from '@forgeax/engine-types';
import { LoaderRegistry } from './loader-registry';
import { INLINE_PACK_LOADERS } from './loaders/inline-pack';
import { UPSTREAM_ENTRY_LOADERS } from './loaders/upstream-entry';

/**
 * Wire the engine's default loader set (10 engine-owned kinds: 6 inline +
 * texture + font + equirect + video) plus any `extraLoaders` onto `registry` in
 * one call. Returns the same `registry` for chaining (so `wireDefaultLoaders(new
 * LoaderRegistry())` is a one-expression wired registry). The `extraLoaders` are
 * appended after the defaults; the production assembly point (createRenderer)
 * passes `[audioLoaderPlaceholder]` to complete the 11-kind set.
 *
 * @example
 * ```ts
 * import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-assets-runtime';
 * const loaders = wireDefaultLoaders(new LoaderRegistry());
 * // loaders.get('mesh') / .get('texture') / .get('font') / .get('video') are
 * // non-undefined; audio is supplied via extraLoaders at the assembly point;
 * // sampler / render-pipeline / shader stay undefined.
 * ```
 */
export function wireDefaultLoaders(
  registry: LoaderRegistry,
  extraLoaders: readonly Loader[] = [],
): LoaderRegistry {
  for (const loader of INLINE_PACK_LOADERS) registry.register(loader);
  for (const loader of UPSTREAM_ENTRY_LOADERS) registry.register(loader);
  registry.register(videoLoader);
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
