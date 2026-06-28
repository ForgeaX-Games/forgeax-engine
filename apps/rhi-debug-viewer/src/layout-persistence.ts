// layout-persistence.ts — localStorage layout persistence for dockview workspace.
//
// Serializes/deserializes dockview layout via toJSON/fromJSON with schema versioning.
// Increment LAYOUT_SCHEMA_VERSION when panels are added or removed.
// Version mismatch discards saved layout and falls back to default.
//
// Related: requirements AC-22/AC-23/AC-24; plan-strategy D-6.

import type { DockviewApi, SerializedDockview } from 'dockview-react';

/** Schema version — increment when the panel set changes (add/remove/rename panels). */
export const LAYOUT_SCHEMA_VERSION = 1;

/** localStorage key: forgeax-viewer-layout-v<schemaVersion> */
export const LAYOUT_STORAGE_KEY = `forgeax-viewer-layout-v${LAYOUT_SCHEMA_VERSION}`;

/**
 * Build the versioned key prefix for version-mismatch detection.
 * Any key matching 'forgeax-viewer-layout-v<otherVersion>' indicates a stale layout.
 */
function isStaleLayoutKey(key: string): boolean {
  return key.startsWith('forgeax-viewer-layout-v') && key !== LAYOUT_STORAGE_KEY;
}

/**
 * Try to load a saved layout from localStorage.
 * Returns the parsed layout on success, or null if:
 *   - No saved layout exists for the current version
 *   - JSON.parse fails (corrupt data)
 *   - Version mismatch (stale key detected)
 */
function loadSavedLayout(): SerializedDockview | null {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt layout — discard
    return null;
  }
}

/**
 * Save the current dockview layout to localStorage under the versioned key.
 * Cleans up stale layout keys from older schema versions.
 */
function saveLayout(api: DockviewApi): void {
  const serialized = api.toJSON();
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(serialized));

  // Clean up stale version keys
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && isStaleLayoutKey(key)) {
      localStorage.removeItem(key);
    }
  }
}

/**
 * Wire layout persistence: load saved layout on mount, auto-save on changes.
 * Returns a dispose function for cleanup.
 *
 * @param api — DockviewApi instance from onReady callback.
 * @param applyDefaultLayout — callback to re-apply the default 4-panel layout.
 */
export function wireLayoutPersistence(
  api: DockviewApi,
  applyDefaultLayout: () => void,
): () => void {
  // Attempt to load saved layout
  let loaded = false;
  const saved = loadSavedLayout();
  if (saved) {
    try {
      api.fromJSON(saved);
      loaded = true;
    } catch {
      // fromJSON threw — discard and fall through to default
    }
  }
  if (!loaded) {
    applyDefaultLayout();
  }

  // Auto-save on any layout change
  const disposable = api.onDidLayoutChange(() => {
    saveLayout(api);
  });

  return () => disposable.dispose();
}

/**
 * Reset to default layout: clear dockview workspace and re-apply defaults.
 *
 * @param api — DockviewApi instance.
 * @param applyDefaultLayout — callback to re-apply the default 4-panel layout.
 */
export function resetToDefaultLayout(api: DockviewApi, applyDefaultLayout: () => void): void {
  api.clear();
  applyDefaultLayout();
}
