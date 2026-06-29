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

import { describe, expect, it } from 'vitest';
import {
  getCaptureFrameHelp,
  getInspectAtHelp,
  getTriggerBrowserHelp,
  parseTriggerBrowserArgs,
} from '../cli';

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
