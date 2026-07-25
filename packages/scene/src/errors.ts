export type SceneErrorCode = 'hierarchy-broken';

export class SceneError extends Error {
  readonly code: SceneErrorCode;
  readonly expected: string;
  readonly hint: string;

  constructor(args: { code: SceneErrorCode; expected: string; hint: string }) {
    super(`[SceneError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'SceneError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
  }
}
