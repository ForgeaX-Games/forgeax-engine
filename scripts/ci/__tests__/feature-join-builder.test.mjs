import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createBrowserFeatureObservation,
  createDawnFeatureObservation,
} from '../../../apps/hello/taa/scripts/feature-evidence-producer.mjs';
import { validateFeatureEvidenceBundle } from '../../../apps/hello/taa/scripts/validate-feature-evidence.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILDER = resolve(REPO, 'scripts/ci/build-auto-exposure-feature-join.mjs');
const HEAD = 'a'.repeat(40);
const hash = (letter) => letter.repeat(64);
const fixtureIdentity = {
  asset: { id: 'asset-v1', sha256: hash('a') },
  camera: { id: 'camera-v1', sha256: hash('b') },
  light: { id: 'light-v1', sha256: hash('c') },
  input: { id: 'input-v1', sha256: hash('d') },
};

function input(kind, backend) {
  const active = kind !== 'manual';
  const isLut = kind === 'positive-lut';
  const stages = active
    ? ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
        id: ['linear-hdr', 'linear-ldr', 'final-srgb'][index],
        domain,
        readback: { rawHash: hash(String(index + (isLut ? 4 : 1))), frame: 60 },
        metadata: {
          frameId: 60,
          deviceGeneration: 1,
          graphGeneration: 2,
          textureIdentity: index + (isLut ? 10 : 1),
          readbackIdentity: index + (isLut ? 20 : 4),
          width: 200,
          height: 150,
          bytesPerRow: 800,
        },
      }))
    : [];
  return {
    workloadKind: kind,
    executionMode: 'simulated',
    state: {
      backend,
      workload: {
        kind,
        executed: true,
        exposureMode: kind === 'auto' ? 'auto' : 'manual',
        colorLutStrength: isLut ? 0.75 : 0,
        sourceKey: isLut ? 'positive-lut' : undefined,
        autoExposure:
          kind === 'auto'
            ? { targetGeneration: 2, receipt: { committed: true, frameId: 60 } }
            : undefined,
        lutReceipt: isLut ? { generation: 2, committed: true, frameId: 60 } : undefined,
      },
    },
    frames: 60,
    frameIdentity: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('e') },
    stages,
    fixtureIdentity: structuredClone(fixtureIdentity),
    source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('f') },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('0') },
    resolution: { width: 200, height: 150 },
    runner:
      backend === 'browser-webgpu'
        ? { kind: 'playwright', id: 'chrome' }
        : { kind: 'dawn', id: 'smoke-dawn' },
    provenance: {
      source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('f') },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('0') },
      fixture: 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json',
      frame: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('e') },
      backend,
      adapter:
        backend === 'browser-webgpu'
          ? {
              physicalGpu: false,
              fallbackAdapter: true,
              vendorId: 1,
              deviceId: 2,
              vendor: 'Mesa',
              device: 'llvmpipe',
              architecture: 'software',
              description: 'Lavapipe software adapter',
            }
          : { physicalGpu: false, fallbackAdapter: false },
      runner:
        backend === 'browser-webgpu'
          ? {
              kind: 'playwright',
              id: 'chrome',
              channel: 'chrome',
              version: '152.0.0.0',
              headless: true,
              launchArgs: ['--headless'],
            }
          : { kind: 'dawn', id: 'smoke-dawn' },
    },
    resourceGrowth: active
      ? {
          stableFrames: 60,
          byteLengthDelta: 0,
          bindGroupDelta: 0,
          resourceCountDelta: 0,
          liveResourceDelta: 0,
          allocationCount: 3,
          peakLiveCount: 3,
          mapCount: 3,
          readbackCount: 3,
        }
      : {
          stableFrames: 60,
          byteLengthDelta: 0,
          bindGroupDelta: 0,
          resourceCountDelta: 0,
          liveResourceDelta: 0,
          allocationCount: 0,
          peakLiveCount: 0,
          mapCount: 0,
          readbackCount: 0,
        },
  };
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function writeFixture(root, backend, producer) {
  const workloads = {};
  for (const kind of ['manual', 'auto', 'positive-lut']) {
    const report = producer(input(kind, backend));
    const outer =
      backend === 'browser-webgpu'
        ? {
            schemaVersion: 'hello-taa-browser-feature-evidence/1',
            testedRevision: HEAD,
            featureEvidence: report,
          }
        : {
            schemaVersion: 'hello-taa-dawn-feature-evidence/1',
            testedRevision: HEAD,
            featureEvidence: report,
          };
    const rawPath = join(root, `${backend}-${kind}.json`);
    const rawText = `${JSON.stringify(outer, null, 2)}\n`;
    writeFileSync(rawPath, rawText);
    workloads[kind] = {
      path: rawPath,
      sha256: digest(rawText),
      testedRevision: HEAD,
      report,
    };
  }
  const bundle = {
    schemaVersion: 'hello-taa-auto-exposure-evidence-bundle/1',
    featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
    backend,
    testedRevision: HEAD,
    workloads,
  };
  const bundlePath = join(root, `${backend}-bundle.json`);
  const derivedPath = join(root, `${backend}-derived.json`);
  writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  const validation = validateFeatureEvidenceBundle(bundle);
  writeFileSync(
    derivedPath,
    `${JSON.stringify(
      {
        schemaVersion: 'hello-taa-auto-exposure-feature-validator/1',
        featureId: bundle.featureId,
        backend,
        testedRevision: HEAD,
        status: validation.status,
        ...(validation.status === 'pass' ? { verdictSource: 'validator' } : {}),
        derivedFrom: Object.fromEntries(
          Object.entries(workloads).map(([kind, entry]) => [kind, entry.sha256]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  return { bundlePath, derivedPath };
}

function runBuilder(root, browser, dawn) {
  return execFileSync(
    process.execPath,
    [
      BUILDER,
      `--browser-bundle=${browser.bundlePath}`,
      `--browser-derived=${browser.derivedPath}`,
      `--dawn-bundle=${dawn.bundlePath}`,
      `--dawn-derived=${dawn.derivedPath}`,
      `--head=${HEAD}`,
      `--output=${join(root, 'join', 'report.json')}`,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
}

test('feature join rebinds derived evidence to raw bytes and actual backend slots', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-feature-join-'));
  try {
    const browser = writeFixture(root, 'browser-webgpu', createBrowserFeatureObservation);
    const dawn = writeFixture(root, 'dawn-node', createDawnFeatureObservation);
    const report = JSON.parse(runBuilder(root, browser, dawn));
    assert.notEqual(report.status, 'pass');
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feature join treats identity object key order as semantic-neutral', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-feature-join-key-order-'));
  try {
    const browser = writeFixture(root, 'browser-webgpu', createBrowserFeatureObservation);
    const dawn = writeFixture(root, 'dawn-node', createDawnFeatureObservation);
    const dawnBundle = JSON.parse(readFileSync(dawn.bundlePath, 'utf8'));
    for (const kind of ['manual', 'auto', 'positive-lut']) {
      const entry = dawnBundle.workloads[kind];
      const raw = JSON.parse(readFileSync(entry.path, 'utf8'));
      const frame = raw.featureEvidence.frameIdentity;
      raw.featureEvidence.frameIdentity = {
        first: frame.first,
        last: frame.last,
        count: frame.count,
        contiguous: frame.contiguous,
        sequenceSha256: frame.sequenceSha256,
      };
      const rawText = `${JSON.stringify(raw, null, 2)}\n`;
      writeFileSync(entry.path, rawText);
      entry.sha256 = digest(rawText);
      entry.report = raw.featureEvidence;
    }
    writeFileSync(dawn.bundlePath, `${JSON.stringify(dawnBundle, null, 2)}\n`);
    const dawnDerived = JSON.parse(readFileSync(dawn.derivedPath, 'utf8'));
    dawnDerived.derivedFrom = Object.fromEntries(
      Object.entries(dawnBundle.workloads).map(([kind, entry]) => [kind, entry.sha256]),
    );
    writeFileSync(dawn.derivedPath, `${JSON.stringify(dawnDerived, null, 2)}\n`);

    const report = JSON.parse(runBuilder(root, browser, dawn));
    assert.notEqual(report.status, 'failed');
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feature join preserves dual identities for a capability-blocked resolution mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-feature-join-blocked-'));
  try {
    const browser = writeFixture(root, 'browser-webgpu', createBrowserFeatureObservation);
    const dawn = writeFixture(root, 'dawn-node', createDawnFeatureObservation);
    const browserBundle = JSON.parse(readFileSync(browser.bundlePath, 'utf8'));
    for (const kind of ['auto', 'positive-lut']) {
      const entry = browserBundle.workloads[kind];
      const rawPath = entry.path;
      const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
      raw.featureEvidence.status = 'blocked';
      raw.featureEvidence.resolution = { width: 1922, height: 1082 };
      raw.featureEvidence.provenance.adapter.physicalGpu = false;
      raw.featureEvidence.provenance.adapter.fallbackAdapter = true;
      raw.featureEvidence.provenance.adapter.isFallbackAdapter = true;
      raw.featureEvidence.provenance.adapter.vendor = 'Google Inc.';
      raw.featureEvidence.provenance.adapter.device = 'llvmpipe';
      raw.featureEvidence.provenance.adapter.architecture = 'swiftshader';
      raw.featureEvidence.provenance.adapter.description = 'SwiftShader software adapter';
      const rawText = `${JSON.stringify(raw, null, 2)}\n`;
      writeFileSync(rawPath, rawText);
      entry.sha256 = digest(rawText);
      entry.report = raw.featureEvidence;
    }
    writeFileSync(browser.bundlePath, `${JSON.stringify(browserBundle, null, 2)}\n`);
    const browserDerived = JSON.parse(readFileSync(browser.derivedPath, 'utf8'));
    const validation = validateFeatureEvidenceBundle(browserBundle);
    assert.equal(validation.status, 'blocked');
    browserDerived.status = validation.status;
    delete browserDerived.verdictSource;
    browserDerived.derivedFrom = Object.fromEntries(
      Object.entries(browserBundle.workloads).map(([kind, entry]) => [kind, entry.sha256]),
    );
    writeFileSync(browser.derivedPath, `${JSON.stringify(browserDerived, null, 2)}\n`);

    const report = JSON.parse(runBuilder(root, browser, dawn));
    assert.equal(report.status, 'blocked');
    assert.ok(report.errors.some((entry) => entry.code === 'identity-mismatch'));
    assert.deepEqual(report.gates.browser.identity.resolution, { width: 1922, height: 1082 });
    assert.deepEqual(report.gates.dawn.identity.resolution, { width: 200, height: 150 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feature join keeps source and fixture identity mismatches fatal even when capability-blocked', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-feature-join-identity-'));
  try {
    const browser = writeFixture(root, 'browser-webgpu', createBrowserFeatureObservation);
    const dawn = writeFixture(root, 'dawn-node', createDawnFeatureObservation);
    const browserBundle = JSON.parse(readFileSync(browser.bundlePath, 'utf8'));
    for (const kind of ['auto', 'positive-lut']) {
      const entry = browserBundle.workloads[kind];
      const rawPath = entry.path;
      const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
      raw.featureEvidence.status = 'blocked';
      raw.featureEvidence.source = { path: 'other.ts', sha256: hash('9') };
      raw.featureEvidence.provenance.source = { path: 'other.ts', sha256: hash('9') };
      raw.featureEvidence.provenance.adapter.physicalGpu = false;
      raw.featureEvidence.provenance.adapter.fallbackAdapter = true;
      raw.featureEvidence.provenance.adapter.isFallbackAdapter = true;
      const rawText = `${JSON.stringify(raw, null, 2)}\n`;
      writeFileSync(rawPath, rawText);
      entry.sha256 = digest(rawText);
      entry.report = raw.featureEvidence;
    }
    writeFileSync(browser.bundlePath, `${JSON.stringify(browserBundle, null, 2)}\n`);
    const browserDerived = JSON.parse(readFileSync(browser.derivedPath, 'utf8'));
    const validation = validateFeatureEvidenceBundle(browserBundle);
    assert.equal(validation.status, 'failed');
    browserDerived.status = validation.status;
    delete browserDerived.verdictSource;
    browserDerived.derivedFrom = Object.fromEntries(
      Object.entries(browserBundle.workloads).map(([kind, entry]) => [kind, entry.sha256]),
    );
    writeFileSync(browser.derivedPath, `${JSON.stringify(browserDerived, null, 2)}\n`);
    assert.throws(() => runBuilder(root, browser, dawn));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feature join rejects raw digest drift and positional backend relabeling', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-feature-join-'));
  try {
    const browser = writeFixture(root, 'browser-webgpu', createBrowserFeatureObservation);
    const dawn = writeFixture(root, 'dawn-node', createDawnFeatureObservation);
    const rawPath = join(root, 'browser-webgpu-auto.json');
    writeFileSync(rawPath, `${readFileSync(rawPath, 'utf8')}\n`);
    assert.throws(() => runBuilder(root, browser, dawn), /raw evidence digest drift/);

    const dawnAsBrowser = writeFixture(root, 'dawn-node', createDawnFeatureObservation);
    assert.throws(() => runBuilder(root, dawnAsBrowser, dawn), /Browser backend slot/);

    const mixedBrowser = writeFixture(root, 'browser-webgpu', createBrowserFeatureObservation);
    const dawnBundle = JSON.parse(readFileSync(dawn.bundlePath, 'utf8'));
    const mixedBundle = JSON.parse(readFileSync(mixedBrowser.bundlePath, 'utf8'));
    const mixedRawPath = mixedBundle.workloads.manual.path;
    const mixedRaw = {
      schemaVersion: 'hello-taa-browser-feature-evidence/1',
      testedRevision: HEAD,
      featureEvidence: dawnBundle.workloads.manual.report,
    };
    const mixedRawText = `${JSON.stringify(mixedRaw, null, 2)}\n`;
    writeFileSync(mixedRawPath, mixedRawText);
    mixedBundle.workloads.manual.report = dawnBundle.workloads.manual.report;
    mixedBundle.workloads.manual.sha256 = digest(mixedRawText);
    writeFileSync(mixedBrowser.bundlePath, `${JSON.stringify(mixedBundle, null, 2)}\n`);
    const mixedDerived = JSON.parse(readFileSync(mixedBrowser.derivedPath, 'utf8'));
    mixedDerived.derivedFrom.manual = mixedBundle.workloads.manual.sha256;
    writeFileSync(mixedBrowser.derivedPath, `${JSON.stringify(mixedDerived, null, 2)}\n`);
    assert.throws(() => runBuilder(root, mixedBrowser, dawn), /Browser manual backend slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
