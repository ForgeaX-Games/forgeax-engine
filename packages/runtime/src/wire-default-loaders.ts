// @forgeax/engine-runtime - wireDefaultLoaders + audio placeholder
// (feat-20260603-asset-import-loader-injection M1 / w5 + w8).
//
// wireDefaultLoaders (w5) is a one-line host helper that wires the engine's
// default loader set onto a `LoaderRegistry`, mirroring the Console
// `wireDefaultInspectors` shape (packages/console/src/wire-default-inspectors.ts;
// research Finding 8). An AI user that has wired inspectors once recognises the
// same form here at near-zero cost (requirements §AI User Affordances).
//
// The default set is the engine's own loaders (the loader objects live in
// @forgeax/engine-runtime alongside AssetRegistry), so this helper registers
// them directly rather than taking an injectors argument (Console's injectors
// exist to keep console from value-importing runtime; that constraint does not
// apply here). Custom loaders for novel kinds are added by the host with a
// direct `registry.register(loader)`.
//
// Default set (11 kinds):
//   inline pack-payload (7): mesh / scene / cube-texture / material / skeleton /
//     skin / animation-clip
//   upstream-branch (2):     texture / font
//   placeholder (1):         audio (D-3, see audioLoaderPlaceholder below)
//   descriptor-only (1):     video (feat-20260623-world-space-video-asset M2 / w4;
//                            pure {url} payload, no pixel decode)
//
// Deliberately NOT registered (AC-02 exclusion): sampler / render-pipeline /
// shader — these have no inline loader today; `loadByGuid` on them surfaces
// `loader-not-registered` (charter P3) rather than a silent miss.

import { INLINE_PACK_LOADERS, UPSTREAM_ENTRY_LOADERS } from './asset-registry';
import { audioLoaderPlaceholder } from './audio-loader-placeholder';
import { LoaderRegistry } from './loader-registry';
import { videoLoader } from './video-loader';

export { audioLoaderPlaceholder } from './audio-loader-placeholder';
export { videoLoader } from './video-loader';

/**
 * Wire the engine's default loader set (7 inline + texture + font + audio
 * placeholder + video = 11 kinds) onto `registry` in one call. Returns the
 * same `registry` for chaining (so `wireDefaultLoaders(new LoaderRegistry())`
 * is a one-expression wired registry).
 *
 * @example
 * ```ts
 * import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-runtime';
 * const loaders = wireDefaultLoaders(new LoaderRegistry());
 * // loaders.get('mesh') / .get('texture') / .get('font') / .get('audio')
 * // / .get('video') are now non-undefined;
 * // sampler / render-pipeline / shader stay undefined.
 * ```
 */
export function wireDefaultLoaders(registry: LoaderRegistry): LoaderRegistry {
  for (const loader of INLINE_PACK_LOADERS) registry.register(loader);
  for (const loader of UPSTREAM_ENTRY_LOADERS) registry.register(loader);
  registry.register(audioLoaderPlaceholder);
  registry.register(videoLoader);
  return registry;
}

/**
 * Convenience factory: a fresh `LoaderRegistry` pre-wired with the default
 * loader set. The production assembly point (`createRenderer`) and tests pass
 * the result into `new LoaderRegistry()` (D-7 constructor-injection;
 * loaders always wired at construction — used by `AssetRegistry` internally
 * via `createDefaultLoaderRegistry()` and by host code / tests independently) — no setter / no
 * illegal intermediate state).
 */
export function createDefaultLoaderRegistry(): LoaderRegistry {
  return wireDefaultLoaders(new LoaderRegistry());
}
