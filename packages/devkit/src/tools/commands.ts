import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSerializableValue } from '@forgeax/engine-tool-runtime';
import { type BrowserCapture, createBrowserCapture } from '../software-capture.js';
import type { CommandResult, OperationCommandOptions } from '../types.js';
import { createToolClient, type ToolClient } from './client.js';
import { retiredPreviewTool } from './preview-migration.js';
import { runOperationCommand } from './run-command.js';

export interface ForgeaXExecContext extends ToolClient {
  readonly browser: BrowserCapture;
}

async function commandClient(root: string) {
  try {
    return { ok: true as const, value: await createToolClient({ projectRoot: root }) };
  } catch (cause) {
    return {
      ok: false as const,
      error: {
        code: 'tool-catalog-authority-unreadable',
        expected: 'project plugin modules and tool descriptors to load from the project authority',
        hint: 'Repair forge.json, plugin module exports, or duplicate tool ids before retrying.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

export async function listCommand(root = process.cwd()): Promise<CommandResult<unknown>> {
  const client = await commandClient(root);
  return client.ok ? { ok: true, value: client.value.list() } : client;
}

export async function describeCommand(
  options: OperationCommandOptions,
): Promise<CommandResult<unknown>> {
  if (options.id === undefined) {
    return {
      ok: false,
      error: {
        code: 'cli-parse-error',
        expected: 'forgeax describe <operation-id>',
        hint: 'Pass the stable id returned by forgeax list.',
        detail: {},
      },
    };
  }
  const client = await commandClient(options.root ?? process.cwd());
  if (!client.ok) return client;
  const entry = client.value.describe(options.id);
  return entry === undefined
    ? {
        ok: false,
        error: {
          code: 'tool-not-found',
          expected: 'the requested operation id to exist in the static catalog',
          hint: 'Run forgeax list and choose one of its ids.',
          detail: { id: options.id },
        },
      }
    : { ok: true, value: entry };
}

export async function runCommand(
  options: OperationCommandOptions,
): Promise<CommandResult<unknown>> {
  if (options.id === 'preview.run') return { ok: true, value: retiredPreviewTool() };
  if (options.id === undefined || (options.input === undefined && options.args === undefined)) {
    return {
      ok: false,
      error: {
        code: 'cli-parse-error',
        expected: 'forgeax run <operation-id> --input <request.json>',
        hint: 'Describe the operation first, then pass a JSON file matching its args schema.',
        detail: {},
      },
    };
  }
  let encoded = options.args;
  try {
    const input = options.input as string;
    encoded =
      encoded ??
      (input === '-'
        ? readFileSync(0, 'utf8')
        : await readFile(resolve(options.root ?? process.cwd(), input), 'utf8'));
    JSON.parse(encoded);
  } catch {
    return {
      ok: true,
      value: {
        outcome: 'failed',
        failure: {
          code: 'tool-invalid-args',
          expected: 'operation arguments to be valid JSON',
          hint: 'Encode one JSON value that conforms to the descriptor argsSchema.',
          detail: { message: 'Invalid JSON', value: null },
        },
        artifacts: [],
      },
    };
  }
  return { ok: true, value: await runOperationCommand({ ...options, args: encoded }) };
}

export async function execCommand(
  options: OperationCommandOptions,
): Promise<CommandResult<unknown>> {
  if (options.program === undefined) {
    return {
      ok: false,
      error: {
        code: 'cli-parse-error',
        expected: 'forgeax exec <program.mjs>',
        hint: 'Pass a trusted local JavaScript module exporting a default ToolClient program.',
        detail: {},
      },
    };
  }
  const root = options.root ?? process.cwd();
  const browser = createBrowserCapture(root);
  try {
    const module = (await import(pathToFileURL(resolve(root, options.program)).href)) as {
      readonly default?: unknown;
      readonly run?: unknown;
    };
    const program = module.default ?? module.run;
    if (typeof program !== 'function') {
      throw new TypeError('operation program must export a default function or named run function');
    }
    const client = await createToolClient({ projectRoot: root });
    const context: ForgeaXExecContext = { ...client, browser };
    const value = await program(context);
    if (!isSerializableValue(value)) {
      throw new TypeError('tool program returned a non-serializable live value');
    }
    return { ok: true, value };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'tool-program-failed',
        expected: 'the trusted local operation program to complete with serializable results',
        hint: 'Repair the program module or inspect its selected operation terminal.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  } finally {
    await browser.close();
  }
}
