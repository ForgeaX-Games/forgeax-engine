import type { AssemblyError, AssemblyErrorCode } from '../assembly/errors';

declare const error: AssemblyError;
const code: AssemblyErrorCode = error.code;
const expected: string = error.expected;
const hint: string = error.hint;
const phase: 'backend' | 'construction' | 'cleanup' = error.detail.phase;

void code;
void expected;
void hint;
void phase;
