import { createVertexColorForgeaxProducer } from '../adapters/forgeax-adapter';
import { createVertexColorThreeProducer } from '../adapters/three-adapter';
import type { VertexColorBackend, VertexColorSemanticFixture } from '../contracts/types';
import {
  captureVertexColor,
  type VertexColorFalsifierMode,
  type VertexColorForgeaxBundler,
} from './vertex-color-capture';

declare global {
  var __forgeaxVertexColorPublish: ((path: string, output: unknown) => Promise<void> | void) | undefined;
}

const fixtureModules = import.meta.glob('../../cases/vertex-color/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, VertexColorSemanticFixture>;

function dispatchEnvironment(): Record<string, string | undefined> {
  const processEnvironment = typeof process === 'undefined' ? {} : process.env;
  return {
    ...import.meta.env,
    ...processEnvironment,
  };
}

function parseEnvironmentMap(value: string | undefined, name: string): Record<string, string> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `${name} must be a JSON object` }));
  }
}

export function vertexColorProducerIsScheduled(): boolean {
  return dispatchEnvironment().VITE_FORGEAX_VERTEX_COLOR_SCHEDULED === '1'
    || dispatchEnvironment().FORGEAX_VERTEX_COLOR_SCHEDULED === '1';
}

export async function runVertexColorProducerEntry(
  implementation: 'forgeax' | 'three',
  backend: VertexColorBackend,
  forgeaxBundler?: VertexColorForgeaxBundler,
): Promise<void> {
  const environment = dispatchEnvironment();
  const singleCaseId = environment.FORGEAX_VERTEX_COLOR_CASE_ID ?? environment.VITE_FORGEAX_VERTEX_COLOR_CASE_ID;
  const batchCaseIdsValue = environment.FORGEAX_VERTEX_COLOR_CASE_IDS ?? environment.VITE_FORGEAX_VERTEX_COLOR_CASE_IDS;
  let caseIds: string[];
  try {
    const parsed: unknown = batchCaseIdsValue === undefined ? undefined : JSON.parse(batchCaseIdsValue);
    caseIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'case IDs must be a JSON array' }));
  }
  if (caseIds.length === 0 && singleCaseId !== undefined) caseIds = [singleCaseId];
  const outputPath = environment.FORGEAX_VERTEX_COLOR_OUTPUT ?? environment.VITE_FORGEAX_VERTEX_COLOR_OUTPUT;
  const outputPaths = parseEnvironmentMap(
    environment.FORGEAX_VERTEX_COLOR_OUTPUTS ?? environment.VITE_FORGEAX_VERTEX_COLOR_OUTPUTS,
    'output paths',
  );
  const falsifierOutputPaths = parseEnvironmentMap(
    environment.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS ?? environment.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS,
    'falsifier output paths',
  );
  const falsifierOutputUrls = parseEnvironmentMap(
    environment.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUT_URLS,
    'falsifier output URLs',
  );
  const sourceSha = environment.FORGEAX_VERTEX_COLOR_SOURCE_SHA ?? environment.VITE_FORGEAX_VERTEX_COLOR_SOURCE_SHA;
  const falsifierValue = environment.FORGEAX_VERTEX_COLOR_FALSIFIER ?? environment.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER;
  const vertexColorFalsifier = falsifierValue === undefined
    ? undefined
    : falsifierValue === 'white-color' || falsifierValue === 'no-color-baseline'
      ? falsifierValue as VertexColorFalsifierMode
      : undefined;
  if (falsifierValue !== undefined && vertexColorFalsifier === undefined) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `unsupported vertex-color falsifier ${falsifierValue}` }));
  }
  if (
    caseIds.length === 0
    || sourceSha === undefined
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceSha)
  ) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'case/output/source SHA environment is incomplete' }));
  }
  const publish = globalThis.__forgeaxVertexColorPublish;
  if (publish === undefined) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'producer output publisher is unavailable', backend, caseIds }));
  }
  const run = async (candidateFixture: VertexColorSemanticFixture, candidateBackend: VertexColorBackend) =>
    captureVertexColor(implementation, {
      fixture: candidateFixture,
      backend: candidateBackend,
      sourceSha,
      ...(forgeaxBundler === undefined ? {} : { forgeaxBundler }),
      ...(vertexColorFalsifier === undefined ? {} : { vertexColorFalsifier }),
    });
  const producer = implementation === 'forgeax'
    ? createVertexColorForgeaxProducer(run, sourceSha)
    : createVertexColorThreeProducer(run);
  for (const caseId of caseIds) {
    const fixture = fixtureModules[`../../cases/vertex-color/${caseId}.json`];
    if (fixture === undefined) {
      throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `fixture ${caseId} is unavailable` }));
    }
    const candidateOutputPath = outputPaths[caseId] ?? (caseIds.length === 1 ? outputPath : undefined);
    if (candidateOutputPath === undefined) {
      throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `output path for ${caseId} is unavailable` }));
    }
    const output = await producer.capture(fixture, backend);
    await publish(candidateOutputPath, output);
    const candidateFalsifierOutputPath = falsifierOutputPaths[caseId];
    const candidateFalsifierOutputUrl = falsifierOutputUrls[candidateFalsifierOutputPath ?? ''];
    if (implementation === 'forgeax' && (candidateFalsifierOutputPath !== undefined || candidateFalsifierOutputUrl !== undefined)) {
      const falsifierRun = async (candidateFixture: VertexColorSemanticFixture, candidateBackend: VertexColorBackend) =>
        captureVertexColor(implementation, {
          fixture: candidateFixture,
          backend: candidateBackend,
          sourceSha,
          vertexColorFalsifier: candidateFixture.caseId === 'vertex-color-no-color-baseline' ? 'no-color-baseline' : 'white-color',
          ...(forgeaxBundler === undefined ? {} : { forgeaxBundler }),
        });
      const falsifierProducer = createVertexColorForgeaxProducer(falsifierRun, sourceSha);
      const falsifierOutput = await falsifierProducer.capture(fixture, backend);
      if (candidateFalsifierOutputPath !== undefined) await publish(candidateFalsifierOutputPath, falsifierOutput);
      if (candidateFalsifierOutputUrl !== undefined && candidateFalsifierOutputPath === undefined) await publish('__falsifier__', falsifierOutput);
    }
  }
}
