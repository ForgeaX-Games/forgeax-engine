#!/usr/bin/env node

// Resolve the declared hello and learn-render smoke surface into one audited
// 300-frame roster. Declaration mode describes the exact scripts; --execute
// runs each declared command and preserves its runtime result in the roster.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function workspaces(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (existsSync(join(path, 'package.json'))) result.push(path);
        else visit(path);
      }
    }
  };
  visit(root);
  return result;
}

function tokenizeInvocation(invocation) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of invocation) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped || quote !== null) throw new Error('unterminated quoted invocation');
  if (started) tokens.push(token);
  return tokens;
}

function parseInvocation(invocation) {
  const tokens = tokenizeInvocation(invocation);
  if (
    tokens.length < 4 ||
    tokens[0] !== 'pnpm' ||
    tokens[1] !== '--filter' ||
    tokens[2].length === 0 ||
    tokens[3].length === 0
  ) {
    throw new Error('expected pnpm --filter <package> <script> invocation');
  }
  return { tokens, package: tokens[2], script: tokens[3] };
}

function smokeDeclaration(root, workspace) {
  const manifestPath = join(workspace, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const workspaceName = relative(root, workspace);
  const packageName = manifest.name ?? workspaceName;
  const invocation = manifest.forgeax?.smokeInvocation;
  if (typeof invocation !== 'string' || invocation.trim().length === 0) {
    return {
      entries: [],
      unavailable: [
        {
          workspace: workspaceName,
          package: packageName,
          reason: 'missing forgeax.smokeInvocation',
        },
      ],
    };
  }
  let parsed;
  try {
    parsed = parseInvocation(invocation);
  } catch (error) {
    return {
      entries: [],
      unavailable: [
        {
          workspace: workspaceName,
          package: packageName,
          invocation,
          reason: error instanceof Error ? error.message : 'invalid smoke invocation',
        },
      ],
    };
  }
  if (parsed.package !== packageName) {
    return {
      entries: [],
      unavailable: [
        {
          workspace: workspaceName,
          package: packageName,
          invocation,
          reason: `invocation package ${parsed.package} does not match manifest package ${packageName}`,
        },
      ],
    };
  }
  const declaredCommand = manifest.scripts?.[parsed.script];
  if (typeof declaredCommand !== 'string') {
    return {
      entries: [],
      unavailable: [
        {
          workspace: workspaceName,
          package: packageName,
          invocation,
          reason: `invocation script ${parsed.script} is not declared in package.json#scripts`,
        },
      ],
    };
  }
  return {
    entries: [
      {
        workspace: workspaceName,
        package: packageName,
        script: parsed.script,
        invocation,
        tokens: parsed.tokens,
        command: invocation,
        declaredCommand,
        frames: 300,
        status: 'declared',
      },
    ],
    unavailable: [],
  };
}

export function buildSmokeRoster(appsRoot, learnRoot, frames = 300) {
  const roots = [resolve(appsRoot), resolve(learnRoot)];
  const entries = [];
  const unavailable = [];
  for (const root of roots) {
    const packages = workspaces(root);
    if (packages.length === 0) {
      unavailable.push({ root, reason: 'no package workspace was found' });
      continue;
    }
    for (const workspace of packages) {
      const declaration = smokeDeclaration(root, workspace);
      entries.push(...declaration.entries);
      unavailable.push(...declaration.unavailable);
    }
  }
  return {
    schemaVersion: 1,
    frameCount: frames,
    execution: {
      status: 'not-executed',
      mode: 'declaration-only',
      reason:
        'This roster resolves declared commands; each command must run separately for runtime evidence.',
    },
    roots,
    entries: entries.map((entry) => ({ ...entry, frames })),
    unavailable,
    status: entries.length === 0 || unavailable.length > 0 ? 'unavailable' : 'ready',
  };
}

const OUTPUT_LIMIT = 4000;

function truncate(value) {
  const text = String(value ?? '');
  return text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n[truncated ${text.length - OUTPUT_LIMIT} chars]`;
}

function backendFor(entry, stdout, stderr) {
  const text = `${entry.command}\n${entry.declaredCommand}\n${stdout}\n${stderr}`.toLowerCase();
  if (text.includes('dawn') || text.includes('wgpu')) return 'dawn';
  if (text.includes('browser') || text.includes('chromium') || text.includes('webgpu')) {
    return 'browser';
  }
  return 'unknown';
}

export function executeSmokeRoster(roster, { cwd = process.cwd(), timeoutMs = 300_000 } = {}) {
  const entries = roster.entries.map((entry) => {
    const [executable, ...args] = entry.tokens;
    const result = spawnSync(executable, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
    });
    const stdout = truncate(result.stdout);
    const stderr = truncate(result.stderr ?? result.error?.message ?? '');
    const passed = result.status === 0 && result.error === undefined;
    return {
      ...entry,
      status: passed ? 'passed' : 'failed',
      returnCode: result.status,
      signal: result.signal ?? null,
      stdout,
      stderr,
      backend: backendFor(entry, stdout, stderr),
      frames: entry.frames,
    };
  });
  const failed = entries.filter((entry) => entry.status !== 'passed');
  const unavailable = roster.unavailable.length;
  const failedCount = failed.length + unavailable;
  return {
    ...roster,
    status: failedCount === 0 ? 'passed' : 'failed',
    entries,
    execution: {
      status: failedCount === 0 ? 'passed' : 'failed',
      mode: 'execute',
      commandCount: entries.length,
      passedCount: entries.length - failed.length,
      failedCount,
      unavailableCount: unavailable,
      reason: unavailable > 0 ? 'one or more packages lack a valid smokeInvocation' : undefined,
      entries,
    },
  };
}

function parseArgs(argv) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = {
    appsRoot: join(root, 'apps/hello'),
    learnRoot: join(root, 'apps/learn-render'),
    frames: 300,
    json: null,
    execute: false,
    cwd: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apps-root' && argv[index + 1]) args.appsRoot = argv[++index];
    else if (arg === '--learn-root' && argv[index + 1]) args.learnRoot = argv[++index];
    else if (arg === '--frames' && argv[index + 1]) args.frames = Number(argv[++index]);
    else if (arg === '--json' && argv[index + 1]) args.json = argv[++index];
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--cwd' && argv[index + 1]) args.cwd = resolve(argv[++index]);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const declared = buildSmokeRoster(args.appsRoot, args.learnRoot, args.frames);
  const report = args.execute ? executeSmokeRoster(declared, { cwd: args.cwd }) : declared;
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.json) {
    mkdirSync(dirname(resolve(args.json)), { recursive: true });
    writeFileSync(resolve(args.json), output);
  }
  process.stdout.write(output);
  if (report.status !== 'ready' && report.status !== 'passed') process.exitCode = 1;
}
