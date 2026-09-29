import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [inputArg, frozenArg, section, outputArg, selectedArg, factorArg] = process.argv.slice(2);
const minStepFactor = Number(factorArg ?? 1);
assert(Number.isFinite(minStepFactor) && minStepFactor > 0 && minStepFactor <= 1);
assert(
  inputArg &&
    frozenArg &&
    /^[a-z0-9-]+$/.test(section) &&
    outputArg &&
    /^\d+(,\d+){0,7}$/.test(selectedArg),
  'trace-global-sdf-prefixes <world-input> <frozen-output> <section> <new-output> <ray-indices> [min-step-factor]',
);
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  input = resolve(inputArg),
  frozen = resolve(frozenArg),
  output = resolve(outputArg),
  selected = selectedArg.split(',').map(Number);
assert(new Set(selected).size === selected.length);
const manifestBytes = await readFile(resolve(input, 'composition.json'));
const manifest = JSON.parse(manifestBytes),
  row = manifest.cases.find((r) => r.name === section);
assert(row?.queryFile);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const provenance = {
  manifest: sha(manifestBytes),
  cohort: sha(await readFile(resolve(input, row.queryFile))),
  composition: sha(await readFile(resolve(frozen, `${section}.bin`))),
  hits: sha(await readFile(resolve(frozen, `${section}-query.bin`))),
};
await mkdir(output);
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [],
  sizes = new Map();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
});
await page.exposeFunction('saveGlobalPrefix', async (name, offset, text) => {
  assert(/^[a-z0-9-]+\.(bin|rhitape)$/.test(name));
  assert.equal(offset, sizes.get(name) ?? 0);
  const bytes = Buffer.from(text, 'base64');
  if (offset === 0) await writeFile(resolve(output, name), bytes);
  else await appendFile(resolve(output, name), bytes);
  sizes.set(name, offset + bytes.length);
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, input, frozen, section, selected, provenance, minStepFactor }) => {
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`),
        debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`),
        render = await import(`/@fs/${root}packages/render/dist/internal.mjs`),
        geometry = await import(`/@fs/${root}packages/geometry/dist/index.mjs`);
      const load = async (path) => {
        const r = await fetch(`/@fs/${path}`);
        if (!r.ok) throw Error(`input ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const sha = async (b) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (v) =>
          v.toString(16).padStart(2, '0'),
        ).join('');
      const decode = (b) => JSON.parse(new TextDecoder().decode(b));
      const manifestBytes = await load(`${input}/composition.json`),
        manifest = decode(manifestBytes),
        row = manifest.cases.find((r) => r.name === section);
      const cohortBytes = await load(`${input}/${row.queryFile}`),
        cohort = decode(cohortBytes),
        expectedGrid = await load(`${frozen}/${section}.bin`),
        expectedHits = await load(`${frozen}/${section}-query.bin`);
      for (const [key, bytes] of [
        ['manifest', manifestBytes],
        ['cohort', cohortBytes],
        ['composition', expectedGrid],
        ['hits', expectedHits],
      ])
        if ((await sha(bytes)) !== provenance[key]) throw Error(`transport changed ${key}`);
      if (
        !selected.every((i) => i < cohort.rays.length) ||
        expectedHits.length !== cohort.rays.length * 64
      )
        throw Error('invalid selected rays');
      const source = [];
      for (const s of row.sources) {
        if (!s.fieldFile) throw Error('prefix diagnosis requires admitted source fields');
        const b = await load(`${input}/${s.fieldFile}`);
        if ((await sha(b)) !== manifest.fields[s.fieldFile].sha256) throw Error('field changed');
        source.push({
          ...s,
          field: (await geometry.decodeMeshDistanceField(b, s.meshDigest)).unwrap(),
        });
      }
      const originalSteps = new DataView(expectedHits.buffer);
      const steps = Math.max(...selected.map((i) => originalSteps.getUint32(i * 64 + 8, true)));
      if (steps < 1 || steps > 256) throw Error('selected rays have no admitted 256-step history');
      const budgets = [...Array.from({ length: steps }, (_, i) => i + 1), 256];
      const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const save = async (name, bytes) => {
        for (let offset = 0; offset < bytes.length; offset += 262144) {
          const chunk = bytes.subarray(offset, offset + 262144);
          let text = '';
          for (let i = 0; i < chunk.length; i += 8192)
            text += String.fromCharCode(...chunk.subarray(i, i + 8192));
          await window.saveGlobalPrefix(name, offset, btoa(text));
        }
      };
      const recorder = debug.attachRecorder(gpu).unwrap();
      const device = (
        await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      const raw = gpu._internal_getRawDevice(device._realDevice);
      if (!raw) throw Error('capture native device missing');
      const gpuErrors = [];
      raw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      let composition, query, tapeBytes;
      const outputs = [];
      const read = async (buffer, size) => {
        const staging = device.createBuffer({ size, usage: 9 }).unwrap();
        try {
          const e = device.createCommandEncoder({}).unwrap();
          e.copyBufferToBuffer(buffer, 0, staging, 0, size);
          device.queue.submit([e.finish().unwrap()]).unwrap();
          const m = (await staging.mapAsync(1)).unwrap();
          const bytes = new Uint8Array(m.getMappedRange().unwrap()).slice();
          m.unmap();
          return bytes;
        } finally {
          device.destroyBuffer(staging);
        }
      };
      try {
        composition = (
          await render.createGlobalSdfComposition(
            device,
            recorder.backend.createShaderModule,
            source,
            row.grid,
          )
        ).unwrap();
        query = (
          await render.createGlobalSdfQuery(
            device,
            recorder.backend.createShaderModule,
            composition,
            cohort.rays,
            { minStepFactor },
          )
        ).unwrap();
        const e = device.createCommandEncoder({}).unwrap();
        composition.record(e).unwrap();
        query.record(e).unwrap();
        device.queue.submit([e.finish().unwrap()]).unwrap();
        if (!equal(await read(composition.buffers.voxels, expectedGrid.length), expectedGrid))
          throw Error('original composition differs');
        if (!equal(await read(query.buffers.hits, expectedHits.length), expectedHits))
          throw Error('original full-cohort query differs');
        // Allocate observation buffers before capture so their initial bytes are explicit.
        // They never feed a query and only retain each dispatch's full-cohort output.
        const copies = budgets.map(() => {
          const copy = device.createBuffer({ size: expectedHits.length, usage: 140 }).unwrap();
          device.queue.writeBuffer(copy, 0, new Uint8Array(expectedHits.length)).unwrap();
          return copy;
        });
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const produce = device.createCommandEncoder({}).unwrap();
        composition.record(produce).unwrap();
        device.queue.submit([produce.finish().unwrap()]).unwrap();
        for (const [i, budget] of budgets.entries()) {
          device.queue.writeBuffer(query.buffers.settings, 0, new Uint32Array([budget])).unwrap();
          const copy = copies[i];
          const enc = device.createCommandEncoder({}).unwrap();
          query.record(enc).unwrap();
          enc.copyBufferToBuffer(query.buffers.hits, 0, copy, 0, expectedHits.length);
          device.queue.submit([enc.finish().unwrap()]).unwrap();
        }
        (await recorder.frameBoundary()).unwrap();
        tapeBytes = (await pending).unwrap().bytes;
        for (const b of copies) {
          outputs.push(await read(b, expectedHits.length));
          device.destroyBuffer(b);
        }
        if (!equal(outputs.at(-1), expectedHits)) throw Error('final full-cohort control differs');
        for (const i of selected)
          if (
            !equal(
              outputs[steps - 1].subarray(i * 64, (i + 1) * 64),
              expectedHits.subarray(i * 64, (i + 1) * 64),
            )
          )
            throw Error('selected final prefix differs');
        await save('global-prefixes.rhitape', tapeBytes);
        const joined = new Uint8Array(outputs.length * expectedHits.length);
        outputs.forEach((b, i) => {
          joined.set(b, i * expectedHits.length);
        });
        await save('global-prefixes.bin', joined);
      } finally {
        query?.dispose();
        composition?.dispose();
        (await recorder.dispose()).unwrap();
        raw.destroy();
      }
      const tape = debug.decodeTape(tapeBytes).unwrap(),
        model = debug.buildFrameModel(tape);
      if (model.unseededResources.length) throw Error('unseeded prefix resource');
      const works = model.works.filter((w) =>
        w.pipeline.shaders.some((s) => s.source.includes('fn queryGlobal(')),
      );
      if (works.length !== budgets.length) throw Error('prefix work missing');
      const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const freshRaw = gpu._internal_getRawDevice(fresh);
      if (!freshRaw) throw Error('replay native device missing');
      freshRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const replay = (
        await debug.openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      const checks = [];
      try {
        for (const [i, w] of works.entries()) {
          const id = w.bindings.find((b) => b.binding === 3).resourceId;
          const bytes = (await replay.readResourceAtWork(id, w.workIndex)).unwrap().bytes;
          if (!equal(bytes, outputs[i])) throw Error(`prefix replay differs at ${i}`);
          checks.push({ budget: budgets[i], workIndex: w.workIndex, byteExact: true });
        }
      } finally {
        (await replay.dispose()).unwrap();
        freshRaw.destroy();
      }
      if (gpuErrors.length) throw Error(gpuErrors.join('\n'));
      return {
        section,
        minStepFactor,
        selected,
        cohortRays: cohort.rays.length,
        budgets,
        checks,
        works: model.works.length,
        originalCompositionByteExact: true,
        originalFullCohortByteExact: true,
        finalFullCohortByteExact: true,
        unseededResources: model.unseededResources,
        gpuErrors,
        tapeSha256: await sha(tapeBytes),
      };
    },
    { root, input, frozen, section, selected, provenance, minStepFactor },
  );
  const report = {
    scope:
      'Original Global composition/query, all cohort rays retained; only the existing step budget changes. Prefix positions are the final sampled positions, except terminal hits include pullback.',
    ...result,
    provenance,
    errors,
  };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify({ message: String(error), errors, provenance }, null, 2),
  );
  throw error;
} finally {
  await page.close();
  await browser.close();
}
