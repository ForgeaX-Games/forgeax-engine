// @forgeax/engine-runtime - video loader (feat-20260623-world-space-video-asset M2 / w4).
//
// Descriptor-only loader for the 'video' asset kind. VideoAsset is a pure
// `{ url }` descriptor (no pixel decode, no import/cook pipeline — OOS-1);
// the runtime resolves it into an HTMLVideoElement via the host-provided
// `VideoElementProvider` World Resource (plan-strategy D-1).
//
// The loader returns the payload as VideoAsset synchronously — no fetch,
// no decode, no fail-fast. Pattern: audioLoaderPlaceholder (same shape,
// but videoLoader returns success instead of the placeholder's structured
// error since video has a real runtime path via the host provider).
//
// Registered in wireDefaultLoaders alongside the other 10 default kinds
// (plan-strategy D-7: engine-own kind goes in the default set so AI users
// don't have to manually register it).

import type { Loader, VideoAsset } from '@forgeax/engine-types';

export const videoLoader: Loader<VideoAsset> = {
  kind: 'video',
  load(payload: Record<string, unknown>): VideoAsset {
    return payload as unknown as VideoAsset;
  },
};
