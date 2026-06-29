#!/usr/bin/env node

// regenerate.mjs — regenerate hello-cube tape fixture for rhi-debug-viewer
//
// This script documents the two methods for regenerating the committed
// hello-cube tape fixture. The preferred method (Option A) generates a
// minimal valid fixture from in-process primitives. Option B captures
// from a real browser run (requires WebGPU + Chromium).
//
// === Option A: in-process generation (preferred, fast) ===
// node apps/rhi-debug-viewer/fixtures/generate-fixture.mjs
//
// === Option B: real browser capture (requires WebGPU) ===
// 1. Run hello-cube smoke:browser with RHI debug enabled:
//      FORGEAX_ENGINE_RHI_DEBUG=1 pnpm -F @forgeax/hello-cube smoke:browser
//    This arms the recorder and captures frame 1 via page.evaluate.
// 2. Locate the output:
//      ls .forgeax-debug/*/frame-0.*
//    The runId is a timestamp-based directory (e.g., 2026-06-19T17-17-21-128Z-74f9).
// 3. Copy to fixtures/:
//      cp .forgeax-debug/<runId>/frame-0.{tape.bin,report.json} apps/rhi-debug-viewer/fixtures/
// 4. Verify the fixture:
//      Verify frame-0.tape.bin is non-empty (>0 bytes) and frame-0.report.json
//      contains valid header + events + passOffsets with 1 render pass + 1 draw.

console.log('To regenerate the hello-cube tape fixture:');
console.log('');
console.log('  Option A (fast, no browser needed):');
console.log('    node apps/rhi-debug-viewer/fixtures/generate-fixture.mjs');
console.log('');
console.log('  Option B (real browser capture, requires WebGPU):');
console.log('    FORGEAX_ENGINE_RHI_DEBUG=1 pnpm -F @forgeax/hello-cube smoke:browser');
console.log('    cp .forgeax-debug/<runId>/frame-0.{tape.bin,report.json} apps/rhi-debug-viewer/fixtures/');
console.log('');
console.log('See fixtures/README.md for details.');