#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const retryPatterns = Object.freeze({
  vitest: [
    /Device was destroyed/,
    /Browser connection was closed/,
    /rpc is closed/,
    /A valid external Instance reference no longer exists/,
    /bootstrap inconclusive within \d+s[\s\S]*runner instability, rerun/,
    /ForgeaX linear HDR observation failed: observation-unavailable/,
    // Headed Chrome Beta + lavapipe can occasionally stall an isolated
    // advanced-lighting WebGPU bootstrap until its bounded 60s test budget.
    // Retry only this exact gate timeout; assertions and other test timeouts
    // remain hard failures on the first attempt.
    /apps\/learn-render\/5\.advanced-lighting\/6\.hdr\/src\/__tests__\/onerror-gate\.browser\.test\.ts[\s\S]*Test timed out in 60000ms\./,
  ],
  'rhi-debug': [
    /capture (?:off|on) failed before materializing v7 tape:[\s\S]*"code":"capture-timeout"/,
    /transient WebGPU external Instance loss/,
  ],
  benchmark: [
    /\[multithreaded benchmark\] browser readiness timeout; runner instability:/,
    /\[multithreaded benchmark\] runner pause detected; runner instability:/,
    // A cold/shared browser can lose its first frame deadline without a page
    // error. Retry only that structured frame fault; a repeated fault still
    // fails the required benchmark on the second attempt.
    /\[multithreaded benchmark\] browser readiness failed:[\s\S]*"phase":"frame"[\s\S]*"pageErrors":\[\]/,
  ],
});

export function isRetryableOutput(mode, output) {
  const patterns = retryPatterns[mode];
  if (!patterns) throw new Error(`unknown browser gate retry mode: ${mode}`);
  return patterns.some((pattern) => pattern.test(output));
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator !== 1 || separator === argv.length - 1) {
    throw new Error(
      'usage: run-browser-gate-with-retry.mjs --mode=<vitest|benchmark|rhi-debug> -- <command>',
    );
  }
  const modeArgument = argv[0];
  if (!modeArgument.startsWith('--mode=')) {
    throw new Error('the retry mode must use --mode=<vitest|benchmark|rhi-debug>');
  }
  const mode = modeArgument.slice('--mode='.length);
  if (!retryPatterns[mode]) throw new Error(`unknown browser gate retry mode: ${mode}`);
  return { mode, command: argv.slice(separator + 1) };
}

export function runBrowserCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  const [program, ...args] = command;
  return new Promise((finish) => {
    let output = '';
    let settled = false;
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const forward = (chunk, destination) => {
      const text = String(chunk);
      output += text;
      destination.write(text);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      finish({ ...result, output });
    };
    child.stdout.on('data', (chunk) => forward(chunk, process.stdout));
    child.stderr.on('data', (chunk) => forward(chunk, process.stderr));
    child.once('error', (error) => {
      const detail = `[browser-gate] failed to start ${program}: ${error.message}\n`;
      process.stderr.write(detail);
      output += detail;
      settle({ status: 1 });
    });
    child.once('close', (status) => settle({ status: status ?? 1 }));
  });
}

async function main(argv) {
  const { mode, command } = parseArgs(argv);
  const first = await runBrowserCommand(command);
  if (first.status === 0) return;
  if (!isRetryableOutput(mode, first.output)) {
    process.exitCode = first.status;
    return;
  }

  process.stderr.write(
    `::warning::${mode} browser gate reported declared runner instability; retrying once with a fresh process\n`,
  );
  const second = await runBrowserCommand(command);
  process.exitCode = second.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[browser-gate] ${error.message}\n`);
    process.exitCode = 1;
  });
}
