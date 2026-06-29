// selectors.ts — sole definition point for all data-forgeax-* anchor constants (AC-13).
//
// All string literals containing 'data-forgeax-' MUST appear ONLY in this file.
// Components, smoke scripts, and AI consumers import from here.
//
// Naming convention: data-forgeax-<noun> all lowercase hyphenated,
// continuing the window.__forgeax.captureFrame (PR1) pattern.
//
// Related: plan-strategy D-5 (selectors SSOT); AC-13 (grep verification); charter F1.

/** Load status values for the viewer container. */
export const LOAD_STATUS = Object.freeze(['parse-error', 'loaded', 'empty'] as const);
export type LoadStatus = (typeof LOAD_STATUS)[number];

/**
 * Identity function returning the given load status value.
 * Callers use this to validate and narrow `loadStatus` values at runtime.
 */
export function loadStatus(value: LoadStatus): LoadStatus {
  return value;
}

/** RT (render target) status values for the RT panel. */
export const RT_STATUS = Object.freeze(['ok', 'no-rt', 'no-webgpu', 'error'] as const);
export type RtStatus = (typeof RT_STATUS)[number];

/**
 * Identity function returning the given RT status value.
 * Callers use this to validate and narrow `rtStatus` values at runtime.
 */
export function rtStatus(value: RtStatus): RtStatus {
  return value;
}

/**
 * Attribute name for data-forgeax-draw. Value is the integer draw index.
 *
 * SSOT anchor key consumed by components and smoke scripts.
 * Callers write: `{...{ [drawAnchor()]: String(idx) }}`.
 * Smoke CSS selector: `[data-forgeax-draw="N"]`.
 */
export function drawAnchor(): string {
  return 'data-forgeax-draw';
}

/**
 * Attribute name for data-forgeax-pass. Value is the integer pass index.
 *
 * SSOT anchor key consumed by components and smoke scripts.
 * Callers write: `{...{ [passAnchor()]: String(passIdx) }}`.
 * Smoke CSS selector: `[data-forgeax-pass="N"]`.
 */
export function passAnchor(): string {
  return 'data-forgeax-pass';
}

/**
 * Attribute name for data-forgeax-selected. Value is always "true".
 *
 * SSOT anchor key consumed by TreePanel to mark the active draw row.
 * Callers write: `{...{ [selectedAnchor()]: 'true' }}`.
 * Smoke CSS selector: `[data-forgeax-selected="true"]`.
 */
export function selectedAnchor(): string {
  return 'data-forgeax-selected';
}

/**
 * Attribute name for data-forgeax-load-status. Value is a LoadStatus string.
 *
 * SSOT anchor key consumed by App.tsx and ErrorBanner.tsx.
 * Callers write: `{...{ [loadStatusAnchor()]: 'loaded' }}`.
 * Smoke CSS selector: `[data-forgeax-load-status="loaded"]`.
 */
export function loadStatusAnchor(): string {
  return 'data-forgeax-load-status';
}

/**
 * Attribute name for data-forgeax-rt-status. Value is an RtStatus string.
 *
 * SSOT anchor key consumed by RtPanel.
 * Callers write: `{...{ [rtStatusAnchor()]: status }}`.
 * Smoke CSS selector: `[data-forgeax-rt-status="ok"]`.
 */
export function rtStatusAnchor(): string {
  return 'data-forgeax-rt-status';
}

/**
 * Attribute name for data-forgeax-rt-canvas. Value is always empty string.
 *
 * SSOT anchor key consumed by RtPanel to mark the RT <canvas>.
 * Callers write: `{...{ [rtCanvasAnchor()]: '' }}`.
 * Smoke CSS selector: `canvas[data-forgeax-rt-canvas]`.
 */
export function rtCanvasAnchor(): string {
  return 'data-forgeax-rt-canvas';
}

// ============================================================================
// M7: dockview four-panel anchors (AC-13 SSOT: all data-forgeax-* only here)
// ============================================================================

/**
 * Attribute name for data-forgeax-event-browser. Value is 'draws-only' or 'all-commands'.
 *
 * SSOT anchor consumed by EventBrowser panel to mark its root container.
 * Smoke CSS selector: `[data-forgeax-event-browser]`.
 */
export function eventBrowserAnchor(): string {
  return 'data-forgeax-event-browser';
}

/**
 * Attribute name for data-forgeax-command-row. Value is the integer event index.
 *
 * SSOT anchor consumed by EventBrowser to mark individual command rows.
 * Callers write: `{...{ [commandRowAnchor()]: String(eventIdx) }}`.
 * Smoke CSS selector: `[data-forgeax-command-row="N"]`.
 */
export function commandRowAnchor(): string {
  return 'data-forgeax-command-row';
}

/**
 * Attribute name for data-forgeax-pipeline-state. Value is 'selected' or 'default'.
 *
 * SSOT anchor consumed by PipelineState panel to mark its container.
 * Smoke CSS selector: `[data-forgeax-pipeline-state]`.
 */
export function pipelineStateAnchor(): string {
  return 'data-forgeax-pipeline-state';
}

/**
 * Attribute name for data-forgeax-texture-viewer. Value is 'selected' or 'default'.
 *
 * SSOT anchor consumed by TextureViewer panel to mark its container.
 * Smoke CSS selector: `[data-forgeax-texture-viewer]`.
 */
export function textureViewerAnchor(): string {
  return 'data-forgeax-texture-viewer';
}

/**
 * Attribute name for data-forgeax-texture-thumbnail. Value is the integer thumbnail index.
 *
 * SSOT anchor consumed by TextureViewer to mark individual thumbnail entries.
 * Smoke CSS selector: `[data-forgeax-texture-thumbnail="N"]`.
 */
export function textureThumbnailAnchor(): string {
  return 'data-forgeax-texture-thumbnail';
}

/**
 * Attribute name for data-forgeax-resource-inspector. Value is 'loaded' or 'empty'.
 *
 * SSOT anchor consumed by ResourceInspector panel to mark its container.
 * Smoke CSS selector: `[data-forgeax-resource-inspector]`.
 */
export function resourceInspectorAnchor(): string {
  return 'data-forgeax-resource-inspector';
}

/**
 * Attribute name for data-forgeax-resource-row. Value is the resource handleId string.
 *
 * SSOT anchor consumed by ResourceInspector to mark individual resource rows.
 * Callers write: `{...{ [resourceRowAnchor()]: handleId }}`.
 * Smoke CSS selector: `[data-forgeax-resource-row="<handleId>"]`.
 */
export function resourceRowAnchor(): string {
  return 'data-forgeax-resource-row';
}
