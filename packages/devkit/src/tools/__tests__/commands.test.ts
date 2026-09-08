import { describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}));

import { runCommand } from '../commands.js';

describe('operation command input', () => {
  it('reads a JSON request from stdin when input is -', async () => {
    readFileSyncMock.mockReturnValueOnce('invalid');

    const result = await runCommand({ id: 'coverage.tool', input: '-' });

    expect(readFileSyncMock).toHaveBeenCalledWith(0, 'utf8');
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: 'failed', failure: { code: 'tool-invalid-args' } },
    });
  });
});
