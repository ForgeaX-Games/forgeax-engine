// tape-source URL handoff -- reviewer opens editor-captured artifacts cross-origin.
//
// Covers the handoff path separately from manual File import: the two fetched
// artifacts must reconstruct the same Tape, while HTTP failures remain a
// structured read-failure that App can present to the user.

import { assembleReport } from '@forgeax/engine-rhi-debug';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- fixture builder is runtime-only .mjs without declarations.
import { buildHelloCubeFixture } from '../../fixtures/build-hello-cube-tape.mjs';
import { loadTapeFromUrls } from '../tape-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadTapeFromUrls', () => {
  it('reconstructs a tape from the editor artifact pair', async () => {
    const { json, blob } = buildHelloCubeFixture();
    const report = JSON.stringify(assembleReport({ json, passOffsets: [], valid: true }));
    // Use a structural fetch response rather than Node's Response. Vitest's
    // jsdom FileReader must receive jsdom Blobs; Node 24's Response.blob()
    // returns an incompatible realm object even though browser fetch does not.
    const response = (body: BlobPart): Response =>
      ({
        ok: true,
        status: 200,
        blob: async () => new Blob([body]),
      }) as Response;
    const fetchMock = vi.fn(async (url: string) =>
      response(url.endsWith('.tape.bin') ? blob : report),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadTapeFromUrls(
      'http://localhost:15290/__forgeax-debug/artifact?file=frame-0.tape.bin',
      'http://localhost:15290/__forgeax-debug/artifact?file=frame-0.report.json',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events.length).toBeGreaterThan(0);
  });

  it('returns a read failure when the capture artifact is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );

    const result = await loadTapeFromUrls('http://localhost/tape', 'http://localhost/report');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect('kind' in result.error && result.error.kind).toBe('read-failure');
      expect(result.error.message).toContain('404/404');
    }
  });
});
