import type { ImportProduct } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeUiArtifact,
  rewriteUiSourceTokens,
  type UiArtifactPayload,
  uiArtifactMimeType,
} from '../index.js';

function product(input: {
  readonly html: string;
  readonly css: string;
  readonly artifacts?: Readonly<
    Record<string, { readonly mediaType: string; readonly bytes: Uint8Array }>
  >;
}): ImportProduct<UiArtifactPayload> {
  return {
    assets: [
      {
        guid: 'ui-guid',
        kind: 'ui',
        payload: { guid: 'ui-guid', html: input.html, css: input.css },
        refs: [],
        artifacts: input.artifacts ?? {},
      },
    ],
    sourceDependencies: ['hud.ui.html', 'hud.ui.css'],
  };
}

describe('UI importer artifact finalization', () => {
  it('rewrites HTML and CSS tokens and closes over every local artifact', () => {
    const artifactUrl = vi.fn(({ path, bytes }: { path: string; bytes: Uint8Array }) => {
      expect(bytes).toBeInstanceOf(Uint8Array);
      return `/assets/${path}`;
    });
    const result = finalizeUiArtifact(
      product({
        html: '<img src="ui-token:icons/panel.png">',
        css: '.hud { background: url("ui-token:icons/panel.png"); }',
        artifacts: {
          'icons/panel.png': { mediaType: 'image/png', bytes: Uint8Array.of(1, 2, 3) },
          'fonts/hud.woff2': { mediaType: 'font/woff2', bytes: Uint8Array.of(4, 5) },
        },
      }),
      { artifactUrl },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.asset.html).toBe('<img src="/assets/icons/panel.png">');
    expect(result.value.asset.css).toBe('.hud { background: url("/assets/icons/panel.png"); }');
    expect(result.value.artifacts).toEqual([
      { path: 'icons/panel.png', mimeType: 'image/png' },
      { path: 'fonts/hud.woff2', mimeType: 'font/woff2' },
    ]);
    expect(artifactUrl).toHaveBeenCalledTimes(4);
    expect(result.value).not.toHaveProperty('sourceDependencies');
    expect(result.value).not.toHaveProperty('resourceLedger');
  });

  it('returns a structured failure when HTML or CSS retains an unresolved token', () => {
    const result = finalizeUiArtifact(
      product({ html: '<img src="ui-token:missing.png">', css: '.hud {}' }),
      { artifactUrl: ({ path }) => `/assets/${path}` },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'ui-artifact-token-unresolved',
        expected: 'every ui-token reference to resolve to an imported artifact',
        hint: 'Add the referenced companion artifact to the ImportProduct before transport.',
        detail: { token: 'ui-token:missing.png', guid: 'ui-guid' },
      },
    });
  });

  it('returns a structured failure for a non-UI product', () => {
    const invalid = {
      ...product({ html: '', css: '' }),
      assets: [{ ...product({ html: '', css: '' }).assets[0], kind: 'image' }],
    } as ImportProduct<UiArtifactPayload>;

    const result = finalizeUiArtifact(invalid, { artifactUrl: ({ path }) => path });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'ui-artifact-payload-invalid',
        expected: 'one ui ImportedAsset with guid, html, and css payload',
        hint: 'Return a validated UI asset before finalizing transport artifacts.',
        detail: {},
      },
    });
  });

  it('keeps token rewrite and MIME mapping deterministic at the owner boundary', () => {
    expect(
      rewriteUiSourceTokens(
        'ui-token:hero.png#top ui-token:hero.png#top',
        new Map([['hero.png#top', '/assets/hero.png']]),
      ),
    ).toEqual({ ok: true, value: '/assets/hero.png /assets/hero.png' });
    expect(uiArtifactMimeType('HUD.WOFF2')).toBe('font/woff2');
    expect(uiArtifactMimeType('blob.bin')).toBeUndefined();
  });
});
