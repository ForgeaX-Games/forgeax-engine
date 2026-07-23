import { describe, expect, it } from 'vitest';
import { ASSET_CHANGED_EVENT, createAssetChangedEvent } from '../dev/asset-change-events.js';
import { createUiDependencyIndex } from '../dev/ui-dependency-index.js';
import { classifyWatchedPath } from '../dev/watcher.js';

describe('GUID-rich UI refresh events', () => {
  it('maps watcher-relative HTML, CSS, and companion paths to absolute provenance', () => {
    const index = createUiDependencyIndex();
    index.recordSuccess('GUID-HUD', [
      '/workspace/assets/hud.ui.html',
      'hud.ui.css',
      'images/logo.png',
    ]);

    for (const filename of ['hud.ui.html', 'hud.ui.css', 'images/logo.png']) {
      const classification = classifyWatchedPath(filename);
      expect(classification.kind).toBe(filename.endsWith('.png') ? 'source' : 'sidecar');
      expect(index.change(filename, 7).guids).toEqual(['guid-hud']);
    }
  });

  it('includes every dependency hit, source provenance, and revision', () => {
    const message = createAssetChangedEvent({
      guids: ['UI-A'],
      sourcePath: 'hud.ui.css',
      revision: 12,
      event: 'change',
      kind: 'sidecar',
    });
    expect(message).toEqual({
      type: 'custom',
      event: ASSET_CHANGED_EVENT,
      data: {
        file: 'hud.ui.css',
        guids: ['ui-a'],
        sourcePath: 'hud.ui.css',
        revision: 12,
        event: 'change',
        kind: 'sidecar',
      },
    });
  });

  it('does not emit a targeted event when there are no dependency hits', () => {
    expect(
      createAssetChangedEvent({
        guids: [],
        sourcePath: 'unrelated.reel.json',
        revision: 1,
        event: 'change',
        kind: 'source',
      }),
    ).toBeUndefined();
  });
});
