import type { ImportProduct } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { finalizeUiArtifact } from '../ui-artifact-finalizer.js';

type UiPayload = { guid: string; html: string; css: string };

describe('finalizeUiArtifact', () => {
  it('returns only final html/css and public companion URLs', () => {
    const product = {
      assets: [
        {
          guid: 'ui-guid',
          kind: 'ui',
          payload: {
            guid: 'ui-guid',
            html: '<img src="ui-token:hero.png">',
            css: '.hero { background: url("ui-token:hero.png"); }',
          },
          refs: [],
        },
      ],
      artifacts: [{ path: 'hero.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
      sourceDependencies: ['ui.html', 'ui.css', 'hero.png'],
    } satisfies ImportProduct<UiPayload>;

    const result = finalizeUiArtifact(product, {
      artifactUrl: (artifact) => `/assets/${artifact.path}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.asset.html).toContain('/assets/hero.png');
    expect(result.value.asset.css).toContain('/assets/hero.png');
    expect(result.value.asset.html).not.toMatch(/ui-token:|sourceDependencies|base64|data:/);
    expect(result.value.asset.css).not.toMatch(/ui-token:|sourceDependencies|base64|data:/);
    expect(result.value.artifacts).toEqual([{ path: 'hero.png', mimeType: 'image/png' }]);
    expect(result.value).not.toHaveProperty('resourceLedger');
  });

  it('fails structurally when a token has no matching artifact', () => {
    const result = finalizeUiArtifact(
      {
        assets: [
          {
            guid: 'ui-guid',
            kind: 'ui',
            payload: { guid: 'ui-guid', html: '<img src="ui-token:missing">', css: '' },
            refs: [],
          },
        ],
        artifacts: [],
        sourceDependencies: [],
      } satisfies ImportProduct<UiPayload>,
      { artifactUrl: (artifact) => `/assets/${artifact.path}` },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ui-artifact-token-unresolved');
    expect(result.error.hint).toContain('artifact');
  });
});
