import type { UiAsset } from './asset.js';
import type { UiResult } from './errors.js';
import { uiError } from './errors.js';

export interface UiLoader {
  load(payload: unknown): UiResult<UiAsset>;
}

export function createUiLoader(): UiLoader {
  return {
    load(payload) {
      if (!payload || typeof payload !== 'object')
        return uiError('invalid-asset', 'payload is not an object');
      const candidate = payload as Record<string, unknown>;
      if (
        typeof candidate.guid !== 'string' ||
        !candidate.guid ||
        typeof candidate.html !== 'string' ||
        typeof candidate.css !== 'string'
      ) {
        return uiError('invalid-asset', 'guid, html, and css are required strings');
      }
      return {
        ok: true,
        value: { guid: candidate.guid, html: candidate.html, css: candidate.css },
      };
    },
  };
}
