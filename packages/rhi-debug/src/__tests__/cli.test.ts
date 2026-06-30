// @forgeax/engine-rhi-debug/src/__tests__/cli.test.ts
//
// CLI --help snapshot tests: capture-frame, inspect-at, and trigger-browser --help.
// Verifies flag table presence (each flag has name + type + description)
// and example invocation presence.
//
// TDD red-green-refactor (plan-strategy 5.1): M-7 test layer for AC-22;
// t6 test layer for AC-10 trigger-browser flag parsing.
// Snapshot is inline so vitest diff catches flag changes automatically
// (charter P2: explicit failure -- flag change breaks snapshot).
//
// I-2 fix (implement-review round 1): add real parsing tests for
// parseTriggerBrowserArgs (SSOT pure function) covering --frames default/
// override, --dev-url default/override, --label optional, unknown flag error.
// These tests guard the SHIPPED parsing logic, not just --help text.
//
// Related: m7-4; t6; requirements AC-10/AC-22.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getCaptureFrameHelp,
  getInspectAtHelp,
  getSummaryHelp,
  getTriggerBrowserHelp,
  parseTriggerBrowserArgs,
  runSummary,
} from '../cli';
import { serializeTape } from '../tape-format';
import type { RhiCallEvent, Tape } from '../types';

describe('CLI --help output', () => {
  describe('capture-frame --help', () => {
    it('m7-4 snapshot: capture-frame --help matches snapshot (flag table + example)', () => {
      const help = getCaptureFrameHelp();
      expect(help).toMatchInlineSnapshot(`
        "Usage: capture-frame [--frames=N] [--label=STR] [--target=WS]

        Capture N frames from a running forgeax engine via WebSocket JSON-RPC.

        Flags:
          --frames=N     Number of frames to capture (default: 1).
          --label=STR    Optional label for the capture run.
          --target=WS    WebSocket target URL (default: ws://localhost:5732).

        Example:
          forgeax-engine-console capture-frame --frames=1 --label=test

        Output:
          JSON object with tapePaths array containing runId, tapePath, and reportPath."
      `);
    });

    it('m7-4 flag table: capture-frame --help contains frames flag', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('--frames');
      expect(help).toContain('Number of frames');
      expect(help).toContain('default: 1');
    });

    it('m7-4 flag table: capture-frame --help contains label flag', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('--label');
      expect(help).toContain('label');
    });

    it('m7-4 flag table: capture-frame --help contains target flag', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('--target');
      expect(help).toContain('ws://localhost:5732');
    });

    it('m7-4 example: capture-frame --help contains example invocation', () => {
      const help = getCaptureFrameHelp();
      expect(help).toContain('forgeax-engine-console capture-frame');
      expect(help).toContain('Example:');
    });
  });

  describe('inspect-at --help', () => {
    it('m7-4 snapshot: inspect-at --help matches snapshot (flag table + example)', () => {
      const help = getInspectAtHelp();
      expect(help).toMatchInlineSnapshot(`
        "Usage: inspect-at <tapePath> <drawIdx> [--fields=LIST] [--target=WS]

        Inspect a specific draw index within a captured tape.

        Arguments:
          tapePath     Path to the .tape.bin file to inspect.
          drawIdx      Global draw event index to inspect (integer >= 0).

        Flags:
          --fields=LIST   Comma-separated fields to include: bindings,drawCall,rt (default: all).
          --target=WS     WebSocket target URL (default: ws://localhost:5732).

        Example:
          forgeax-engine-console inspect-at .forgeax-debug/2026-06-12T120000Z-abcd/frame-0.tape.bin 42 --fields=bindings,rt

        Output:
          JSON InspectReport with frameIdx, drawIdx, passIdx, and requested fields."
      `);
    });

    it('m7-4 flag table: inspect-at --help contains fields flag', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('--fields');
      expect(help).toContain('bindings,drawCall,rt');
    });

    it('m7-4 flag table: inspect-at --help contains target flag', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('--target');
      expect(help).toContain('ws://localhost:5732');
    });

    it('m7-4 arguments: inspect-at --help contains positional argument docs', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('tapePath');
      expect(help).toContain('drawIdx');
    });

    it('m7-4 example: inspect-at --help contains example invocation', () => {
      const help = getInspectAtHelp();
      expect(help).toContain('forgeax-engine-console inspect-at');
      expect(help).toContain('Example:');
      expect(help).toContain('--fields=bindings,rt');
    });
  });

  // ============================================================================
  // t6: trigger-browser --help (AC-10)
  // ============================================================================

  describe('trigger-browser --help', () => {
    it('(a) snapshot: trigger-browser --help output contains three flags + defaults + example (AC-10)', () => {
      const help = getTriggerBrowserHelp();
      expect(help).toMatchInlineSnapshot(`
        "Usage: trigger-browser [--frames=N] [--label=STR] [--dev-url=URL]

        Trigger a browser tab to capture frames via the dev-server HMR channel.

        Flags:
          --frames=N     Number of frames to capture (default: 1).
          --label=STR    Optional label for the capture run.
          --dev-url=URL  Dev-server URL (default: http://localhost:5173).

        Example:
          forgeax-rhi-debug trigger-browser --frames=1 --label=sponza-black

        Output:
          tapePath: path to the .tape.bin file.
          reportPath: path to the .report.json file.
          runId: unique run identifier."
      `);
    });

    it('(b) trigger-browser --help contains --frames flag with default 1', () => {
      const help = getTriggerBrowserHelp();
      expect(help).toContain('--frames');
      expect(help).toContain('default: 1');
    });

    it('(c) trigger-browser --help contains --label flag (optional)', () => {
      const help = getTriggerBrowserHelp();
      expect(help).toContain('--label');
    });

    it('(d) trigger-browser --help contains --dev-url flag with default http://localhost:5173', () => {
      const help = getTriggerBrowserHelp();
      expect(help).toContain('--dev-url');
      expect(help).toContain('http://localhost:5173');
    });

    it('(e) trigger-browser --help contains example invocation', () => {
      const help = getTriggerBrowserHelp();
      expect(help).toContain('Example:');
    });

    it('(f) trigger-browser --help contains Output section with three paths', () => {
      const help = getTriggerBrowserHelp();
      expect(help).toContain('tapePath');
      expect(help).toContain('reportPath');
      expect(help).toContain('runId');
    });
  });
});

// ============================================================================
// I-2: Real flag parsing tests for parseTriggerBrowserArgs (SSOT pure function)
//
// The original t6 tested ONLY --help text (snapshot). These tests exercise
// the SHIPPED parsing logic: default values, overrides, optional flags,
// and error paths. triggerBrowserDispatch delegates parsing to this function.
// ============================================================================

describe('parseTriggerBrowserArgs (AC-10 parsing logic)', () => {
  describe('default values', () => {
    it('--frames defaults to 1 when no --frames flag is given', () => {
      const result = parseTriggerBrowserArgs([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.frames).toBe(1);
        expect(result.value.devUrl).toBe('http://localhost:5173');
        expect(result.value.label).toBeUndefined();
      }
    });

    it('--dev-url defaults to http://localhost:5173 when no --dev-url flag is given', () => {
      const result = parseTriggerBrowserArgs([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.devUrl).toBe('http://localhost:5173');
      }
    });

    it('--label defaults to undefined when no --label flag is given', () => {
      const result = parseTriggerBrowserArgs([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.label).toBeUndefined();
      }
    });
  });

  describe('explicit flag overrides', () => {
    it('--frames=3 overrides default to 3', () => {
      const result = parseTriggerBrowserArgs(['--frames=3']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.frames).toBe(3);
      }
    });

    it('--frames=10 parses correctly', () => {
      const result = parseTriggerBrowserArgs(['--frames=10']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.frames).toBe(10);
      }
    });

    it('--dev-url=http://localhost:9999 overrides default dev-url', () => {
      const result = parseTriggerBrowserArgs(['--dev-url=http://localhost:9999']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.devUrl).toBe('http://localhost:9999');
      }
    });

    it('--label=my-capture sets label correctly', () => {
      const result = parseTriggerBrowserArgs(['--label=my-capture']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.label).toBe('my-capture');
      }
    });

    it('all three flags combined parse correctly', () => {
      const result = parseTriggerBrowserArgs([
        '--frames=5',
        '--label=sponza',
        '--dev-url=http://localhost:3000',
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.frames).toBe(5);
        expect(result.value.label).toBe('sponza');
        expect(result.value.devUrl).toBe('http://localhost:3000');
      }
    });
  });

  describe('optional --label', () => {
    it('--label omitted -> label is undefined', () => {
      const result = parseTriggerBrowserArgs(['--frames=2']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.label).toBeUndefined();
      }
    });
  });

  describe('--help / -h', () => {
    it('--help returns help text with exitCode 0', () => {
      const result = parseTriggerBrowserArgs(['--help']);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(0);
        expect(result.helpText).toContain('Usage: trigger-browser');
        expect(result.helpText).toContain('--frames');
      }
    });

    it('-h returns help text with exitCode 0', () => {
      const result = parseTriggerBrowserArgs(['-h']);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(0);
        expect(result.helpText).toContain('Usage: trigger-browser');
      }
    });
  });

  describe('unknown flag error path', () => {
    it('unknown flag returns error with exitCode 1', () => {
      const result = parseTriggerBrowserArgs(['--unknown=foo']);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(1);
        expect(result.error).toContain('Unknown argument');
        expect(result.helpText.length).toBeGreaterThan(0);
      }
    });

    it('positional argument without -- prefix returns error', () => {
      const result = parseTriggerBrowserArgs(['foobar']);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(1);
        expect(result.error).toContain('Unknown argument');
      }
    });

    it('unknown flag with valid flags still fails (no partial parse)', () => {
      const result = parseTriggerBrowserArgs(['--frames=3', '--bogus']);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(1);
      }
    });
  });
});

// ============================================================================
// summary: --help text + runSummary FrameModel emission (AI-first CLI/UI parity)
//
// `summary <tape>` is the CLI mirror of the viewer's whole-frame view: it emits
// buildFrameModel(tape) JSON without a GPU device. These tests pin the help text
// and that runSummary returns the same structural model the viewer renders.
// ============================================================================

function makeSummaryTape(): Tape {
  const events: RhiCallEvent[] = [
    { kind: 'createPipelineLayout', handleId: 'layout:1', bglHandleIds: [] },
    {
      kind: 'createRenderPipeline',
      handleId: 'pipe:1',
      desc: {
        vertex: { module: undefined as unknown as GPUShaderModule, entryPoint: 'main' },
        primitive: { topology: 'triangle-list' as GPUPrimitiveTopology },
        fragment: {
          module: undefined as unknown as GPUShaderModule,
          entryPoint: 'main',
          targets: [{ format: 'bgra8unorm' as GPUTextureFormat, writeMask: 0xf }],
        },
      },
      layoutHandleId: 'layout:1',
      vertexShaderModuleHandleId: undefined,
      fragmentShaderModuleHandleId: undefined,
    },
    { kind: 'frameMark', frameIdx: 0 },
    { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: [],
    },
    { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
    {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
  ];
  return {
    formatVersion: 3,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events,
    blobPool: new Map(),
  };
}

describe('summary subcommand', () => {
  it('--help text contains usage, argument, example, and output sections', () => {
    const help = getSummaryHelp();
    expect(help).toContain('Usage: summary <tapePath>');
    expect(help).toContain('tapePath');
    expect(help).toContain('Example:');
    expect(help).toContain('FrameModel');
  });

  it('runSummary emits a FrameModel with meta/tree/draws/resources for an on-disk tape', () => {
    const { json, blob } = serializeTape(makeSummaryTape());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-cli-'));
    const tapePath = path.join(dir, 'frame-0.tape.bin');
    const reportPath = path.join(dir, 'frame-0.report.json');
    const parsed = JSON.parse(json) as { header: unknown; events: unknown };
    fs.writeFileSync(tapePath, Buffer.from(blob));
    fs.writeFileSync(reportPath, JSON.stringify(parsed));

    const result = runSummary({ tapePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = JSON.parse(result.value) as {
      meta: { totalDraws: number; totalPasses: number };
      tree: unknown[];
      draws: { pipelineState: { inputAssembly: { topology: string } } }[];
      resources: unknown[];
    };
    expect(model.meta.totalDraws).toBe(1);
    expect(model.meta.totalPasses).toBe(1);
    expect(model.tree).toHaveLength(1);
    expect(model.draws[0]?.pipelineState.inputAssembly.topology).toBe('triangle-list');
    // resources Map is serialized as an array (JSON-safe), not {}
    expect(Array.isArray(model.resources)).toBe(true);
    expect(model.resources.length).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runSummary returns a tape-format error for a missing tape', () => {
    const result = runSummary({ tapePath: '/nonexistent/frame-0.tape.bin' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('tape-format-version-mismatch');
    }
  });
});
