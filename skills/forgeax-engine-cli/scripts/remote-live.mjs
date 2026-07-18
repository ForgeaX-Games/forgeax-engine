#!/usr/bin/env node
// remote-live.mjs — drive an ALREADY-OPEN browser engine via the DEV bridge.
//
// A browser engine cannot host a Node WS server (packages/remote/src/server.ts),
// so the classic `forgeax-engine-remote eval` CLI has nothing to connect to in a
// real dev browser. This driver instead POSTs a JS snippet to the loopback relay
// (remote-bridge-server.mjs), which forwards it to the live page bridge →
// @forgeax/engine-remote/execute in YOUR open window. Same in-memory world; a
// world.set shows up on screen immediately, no rebuild/refresh.
//
// The eval scope carries the four live roots (world / renderer / assets /
// debugAdapter) + _import(specifier) — identical to the WS-server eval channel.
// Handle discovery uses the real queryRun callback form:
//   let r; const {createQueryState,queryRun,Entity}=await _import('@forgeax/engine-ecs');
//   const st=createQueryState({with:[Entity]}); queryRun(st,world,b=>{r=Array.from(b.Entity.self)}); r
//
// Prereqs: dev stack running (relay on :5733 + an app dev server open at :5173
// with the bridge connected). Start both with: node scripts/dev-live.mjs <app>.
// Prints the {ok, value|error} envelope as JSON. Exit 1 when the relay/page is
// unreachable or eval failed.
//
//   node remote-live.mjs "world.inspect().entityCount"
//   node remote-live.mjs --file snippet.js
//   node remote-live.mjs --health
//   FORGEAX_ENGINE_BRIDGE_PORT=5733 node remote-live.mjs "<code>"

import { parseArgs, readSnippet, printResult } from './remote-cli-common.mjs';

const PORT = Number(process.env.FORGEAX_ENGINE_BRIDGE_PORT ?? 5733);
const BASE = `http://127.0.0.1:${PORT}`;

// --health is a distinct MODE (not a snippet run) — handle it before parseArgs so
// the strict parser never sees it as an unknown flag.
if (process.argv.slice(2).includes('--health')) {
  try {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    process.exit(j.pageConnected ? 0 : 1);
  } catch (e) {
    console.error(`relay unreachable on ${BASE} — is the dev stack up? (${e.message})`);
    process.exit(1);
  }
}

// Strict spec-driven parse (shared SSOT). Live accepts ONLY --file (and the
// special-cased --health above) — so a stray flag fails loudly instead of
// leaking its bare value into the code string.
const { code: posCode, flags } = parseArgs(process.argv, { value: ['file'] });
const code = readSnippet(
  { code: posCode, file: flags.file },
  'usage: remote-live.mjs "<js code>" | --file <path> | --health',
);

let out;
try {
  const r = await fetch(`${BASE}/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  out = await r.json();
} catch (e) {
  console.error(
    `relay unreachable on ${BASE} — start it: node skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs (${e.message})`,
  );
  process.exit(1);
}

printResult(out);
