// viewer-model.ts — thin re-export of the shared FrameModel SSOT.
//
// The whole-frame analysis (buildViewModel) used to live here; it now lives in
// @forgeax/engine-rhi-debug/frame-model so the viewer UI and the AI CLI (`summary`
// subcommand + inspect-offline pipelineState) consume one source of truth — the AI
// inspects with the same operations the UI exposes (charter F1).
//
// The app keeps the `ViewModel` / `buildViewModel` names (window.__forgeaxViewer,
// AC-14) as aliases over the package's FrameModel / buildFrameModel.

export type {
  CommandEntry,
  CreateDescriptor,
  DrawDepthStencil,
  DrawEntry,
  DrawPipelineState,
  FrameModel,
  FrameModelMeta,
  PassDrawItem,
  PassNode,
} from '@forgeax/engine-rhi-debug/frame-model';

import type { FrameModel, FrameModelMeta } from '@forgeax/engine-rhi-debug/frame-model';

export { buildFrameModel as buildViewModel } from '@forgeax/engine-rhi-debug/frame-model';

/** The viewer's name for the shared {@link FrameModel}. */
export type ViewModel = FrameModel;
/** The viewer's name for {@link FrameModelMeta}. */
export type ViewModelMeta = FrameModelMeta;
