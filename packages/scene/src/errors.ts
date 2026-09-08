import type { EntityHandle } from '@forgeax/engine-ecs';

export type SceneErrorCode = 'hierarchy-broken' | 'hierarchy-cycle';

/** Scene-instantiation failures owned by the scene package. */
export type SceneInstanceErrorCode = 'component-not-defined' | 'scene-override-type-mismatch';

export { ComponentNotDefinedError } from '@forgeax/engine-ecs/projection';

export interface SceneErrorDetail {
  readonly entity: EntityHandle;
  readonly parent: EntityHandle;
}

export class SceneError extends Error {
  readonly code: SceneErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneErrorDetail | undefined;

  constructor(args: {
    code: SceneErrorCode;
    expected: string;
    hint: string;
    detail?: SceneErrorDetail;
  }) {
    super(`[SceneError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'SceneError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}
