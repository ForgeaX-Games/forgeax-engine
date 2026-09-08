import type { OperationCommandOptions } from '../types.js';
import { decorateResourcePreviewTerminal } from './cli-adapter.js';
import { createToolClient } from './client.js';

export async function runOperationCommand(options: OperationCommandOptions) {
  const client = await createToolClient({ projectRoot: options.root ?? process.cwd() });
  return client
    .run(options.id as string, JSON.parse(options.args as string) as unknown)
    .then(decorateResourcePreviewTerminal);
}
