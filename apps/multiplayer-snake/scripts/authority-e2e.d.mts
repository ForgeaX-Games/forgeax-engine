import type { ChildProcess } from 'node:child_process';

export function startAuthority(options?: { timeoutMs?: number }): Promise<{
  process: ChildProcess;
  port: number;
  kill: () => Promise<void>;
}>;
export function stopAuthority(
  process: ChildProcess,
  options?: { directory?: string; timeoutMs?: number },
): Promise<void>;
