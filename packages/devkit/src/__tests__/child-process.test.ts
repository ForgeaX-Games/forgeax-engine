import { describe, expect, it } from 'vitest';
import { commandInvocation, execFileCommand } from '../child-process.js';

describe('commandInvocation', () => {
  it('executes commands directly on POSIX platforms', () => {
    expect(commandInvocation('pnpm', ['install'], 'linux', 'ignored')).toEqual({
      file: 'pnpm',
      args: ['install'],
      options: {},
    });
  });

  it('routes Windows command shims through ComSpec', () => {
    expect(
      commandInvocation(
        'npm',
        ['install', '--prefix', 'C:\\Games\\ForgeaX Game'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'install', '--prefix', 'C:\\Games\\ForgeaX Game'],
      options: { windowsVerbatimArguments: false },
    });
  });

  it('executes a harmless Node command through the platform adapter', async () => {
    await expect(
      execFileCommand(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1])',
        'ForgeaX & Game',
      ]),
    ).resolves.toEqual({ stdout: 'ForgeaX & Game', stderr: '' });
  });
});
