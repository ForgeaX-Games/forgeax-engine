// @forgeax/engine-runtime — VideoElementProvider contract + Resource key
// (feat-20260623-world-space-video-asset M3 / w9).
//
// D-1: the channel by which a host HTMLVideoElement reaches the engine is a
// host-registered `VideoElementProvider` stored as a World Resource. The host
// implements this interface, owns the `<video>` DOM lifecycle (create / set
// src / autoplay / mute / dispose) single-sidedly, and registers it via
// `world.insertResource(VIDEO_ELEMENT_PROVIDER_KEY, provider)`. The engine's
// per-frame record stage (`render-system-record.ts` `videoTextureView`) reads
// it back each draw via `world.getResource(VIDEO_ELEMENT_PROVIDER_KEY)` and asks
// for the element to sample — it NEVER constructs an HTMLVideoElement, sets
// `.src`, or touches the DOM (requirements constraint: HTMLVideoElement is
// host-provided). There is no separate ECS "video player system" to register.
//
// Why a World Resource (not an ECS field): the ECS schema vocab is closed
// (component.ts:315-333) and admits no opaque/object field type, so an
// HTMLVideoElement reference cannot live inside a component. A World Resource
// is the typed singleton channel for host-owned services — the same shape used
// by AnimationAssetResolver / TransparentSortConfig (research Finding 5,
// plan-strategy D-1; plan-decisions F-3 correction: this uses the REAL World
// Resource API insertResource/getResource, not audio's direct-parameter
// injection).
//
// This module is a pure contract: an interface plus a typed key constant, no
// runtime behavior. Behavior is exercised by w10/w11 via a mock provider
// (the host's real implementation lives in the M5 demo, w20).

import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';

/**
 * Resource key under which the host inserts its {@link VideoElementProvider}.
 *
 * Consumers import this constant rather than the bare string so a typo
 * degrades to an import error rather than a silent missing-resource at runtime
 * (charter P3). Naming mirrors `ANIMATION_ASSET_RESOLVER_KEY` /
 * `TRANSPARENT_SORT_CONFIG_KEY`.
 *
 * @example Host registers its provider once per World:
 *   world.insertResource(VIDEO_ELEMENT_PROVIDER_KEY, myProvider);
 *   // ...the record stage reads it back each renderer.draw...
 */
export const VIDEO_ELEMENT_PROVIDER_KEY = 'VideoElementProvider' as const;

/**
 * Host-implemented bridge from a VideoPlayer entity (+ its `clip` handle) to
 * the host-owned HTMLVideoElement the engine samples each frame.
 *
 * The engine calls {@link getElement} during the video tick; the host returns
 * the element it owns for that clip, or `undefined` when no element is
 * available yet (clip not loaded / metadata pending / host has none). The
 * engine treats `undefined` as "no source this frame" and routes through the
 * structured failure / degrade path (AC-10) rather than sampling garbage.
 *
 * The engine NEVER mutates the returned element — it only reads it for the
 * per-frame `copyExternalImageToTexture` upload (M4). DOM lifecycle is the
 * host's sole responsibility (D-1).
 */
export interface VideoElementProvider {
  /**
   * Return the host-owned HTMLVideoElement for the given entity + clip, or
   * `undefined` when none is available this frame.
   *
   * @param entity - the VideoPlayer entity requesting its element.
   * @param clipHandle - the entity's `VideoPlayer.clip` handle
   *   (`Handle<'VideoAsset','shared'>`).
   */
  getElement(
    entity: EntityHandle,
    clipHandle: Handle<'VideoAsset', 'shared'>,
  ): HTMLVideoElement | undefined;
}
