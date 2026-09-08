import { describe, expect, it } from 'vitest';
import {
  buildMaterialAcceptanceVerdict,
  buildReceipt,
  parseSmokeOutput,
  validateMaterialAcceptanceDeclaration,
} from '../material-fleet-smoke.mjs';

describe('material fleet smoke receipt parsing', () => {
  it('recognizes the established 300-frame PASS output forms', () => {
    const parsed = parseSmokeOutput(
      [
        '[smoke] rendered 300 frames',
        '[smoke] frames observed=300',
        '[smoke] result={"frames":300}',
        '[smoke] PASS - RhiError count=0, deferred-to-PR for AC-09',
      ].join('\n'),
      '',
    );

    expect(parsed.frameCount).toBe(300);
    expect(parsed.criterion).toBe('structural');
    expect(parsed.markers).toEqual([]);
  });

  it('extracts quoted JSON keys from prefixed PASS output', () => {
    const parsed = parseSmokeOutput(
      '[smoke-dawn] PASS {"frames":300,"structural":true,"pixelSamples":{"center":1}}',
      '',
    );

    expect(parsed.frameCount).toBe(300);
    expect(parsed.criterion).toBe('pixel');
    expect(parsed.markers).toEqual([]);
  });

  it('retains real material contract failures as receipt markers', () => {
    const parsed = parseSmokeOutput(
      '[RhiError material-derived-interface-mismatch] expected: generated interface',
      '',
    );

    expect(parsed.frameCount).toBe(0);
    expect(parsed.markers).toEqual([
      '[RhiError material-derived-interface-mismatch] expected: generated interface',
    ]);
  });

  it('trusts M7 app-owned device-loss evidence after its recovery oracle passes', () => {
    const parsed = parseSmokeOutput(
      [
        '[RhiError device-lost] expected: device must remain alive',
        '[m7-browser-device-loss] PASS - driver=Browser.crashGpuProcess',
        '[m7-backend] PASS - M7 backend/recovery evidence GREEN',
      ].join('\n'),
      '',
    );

    expect(parsed.declaredPass).toBe(true);
    expect(parsed.markers).toEqual([]);
  });

  it('does not convert low-frame output into a false pass', () => {
    const parsed = parseSmokeOutput('[smoke] frames observed=60', '');

    expect(parsed.frameCount).toBe(60);
    expect(parsed.criterion).toBe('unreported');
    expect(parsed.markers).toEqual([]);
  });

  it('accepts an app-owned PASS oracle when the app deliberately does not report a frame count', () => {
    const parsed = parseSmokeOutput(
      '[m1-composition] PASS - schedule and lifecycle gates GREEN',
      '',
    );

    expect(parsed.frameCount).toBe(0);
    expect(parsed.criterion).toBe('declared');
    expect(parsed.declaredPass).toBe(true);
    expect(parsed.markers).toEqual([]);
  });

  it('accepts a successful JSON app oracle without a textual frame count', () => {
    const parsed = parseSmokeOutput(
      JSON.stringify({ ok: true, reports: [{ tier: 'main-serial' }] }),
      '',
    );

    expect(parsed.frameCount).toBe(0);
    expect(parsed.criterion).toBe('declared');
    expect(parsed.declaredPass).toBe(true);
    expect(parsed.markers).toEqual([]);
  });

  it('does not turn an expected composite falsifier into a gate failure', () => {
    const parsed = parseSmokeOutput(
      [
        '[smoke] FAIL - low mode frame 60 has zero foreground pixels',
        '[m5-interactive] debug-draw falsifier: PASS (expected non-zero falsifier)',
        '[m5-interactive] PASS - M5 interaction/media gates GREEN',
      ].join('\n'),
      '',
    );

    expect(parsed.expectedFalsifierPass).toBe(true);
    expect(parsed.criterion).toBe('declared');
    expect(parsed.markers).toEqual([]);
  });

  it('requires a producer declaration for every material witness', () => {
    const declaration = {
      schemaVersion: 1,
      kind: 'material-acceptance-declaration',
      producer: 'fixture-producer',
      witnesses: [
        {
          id: 'custom-dawn',
          subject: 'custom shader',
          fixture: 'fixture.pack.json',
          materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
          evidence: 'dawn',
          command: { program: 'node', args: ['smoke-dawn.mjs'] },
        },
        {
          id: 'custom-browser',
          subject: 'custom shader',
          fixture: 'fixture.pack.json',
          materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
          evidence: 'browser',
          command: { program: 'node', args: ['smoke-browser.mjs'] },
        },
      ],
    };

    expect(validateMaterialAcceptanceDeclaration(declaration, () => true)).toEqual({
      ok: true,
      errors: [],
    });

    const verdict = buildMaterialAcceptanceVerdict(declaration, [
      {
        witnessId: 'custom-dawn',
        verdict: 'pass',
        evidence: { materialIdentity: { materialGuid: declaration.witnesses[0].materialGuid } },
      },
    ]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.missingWitnesses).toEqual(['custom-browser']);
  });

  it('keeps material and repository verdicts independent', () => {
    const declaration = {
      schemaVersion: 1,
      kind: 'material-acceptance-declaration',
      producer: 'fixture-producer',
      witnesses: [
        {
          id: 'custom-dawn',
          subject: 'custom shader',
          fixture: 'fixture.pack.json',
          materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
          evidence: 'dawn',
          command: { program: 'node', args: ['smoke-dawn.mjs'] },
        },
      ],
    };
    const material = buildMaterialAcceptanceVerdict(declaration, [
      {
        witnessId: 'custom-dawn',
        verdict: 'pass',
        evidence: { materialIdentity: { materialGuid: declaration.witnesses[0].materialGuid } },
      },
    ]);
    const receipt = buildReceipt(
      'revision',
      [{ app: 'apps/hello/unrelated', required: true, verdict: 'fail' }],
      { declaration, material },
    );

    expect(receipt.materialAcceptanceVerdict).toBe('pass');
    expect(receipt.repositoryRegressionVerdict).toBe('fail');
    expect(receipt.verdict).toBe('fail');
  });
});
