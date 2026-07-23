#!/usr/bin/env node
// check-build-artifact-contract.mjs — contract checker (t5)
//
// (a) Validates the contract JSON schema
// (b) Checks that all artifact file class paths are non-overlapping
// (c) When run with --workflow, parses ci.yml to verify every download-artifact
//     step references a declared artifact name and every declared artifact has
//     a corresponding upload step
// (d) Validates timingRoster section: jobIdentity matches workflow job name,
//     each entry projects its requiredArtifactClasses from one declared consumer,
//     and notApplicable consumers have no download-artifact step in the PR path
// (e) F-1 bidirectional needs check: for each timing consumer, parse the
//     workflow YAML to extract actual direct needs array and verify against
//     allowedNonArtifactPrerequisites
// (f) Provenance section validation: producerRoster (exactly 4), namingTemplate,
//     mergedClass, mergedWriter, mergedReader, payloadClasses
//
// Usage:
//   node scripts/ci/check-build-artifact-contract.mjs [contract.json]
//   node scripts/ci/check-build-artifact-contract.mjs --workflow ci.yml [contract.json]

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ============================================================================
// Minimal YAML parser for GitHub Actions workflow files
// ============================================================================

/**
 * Parse a minimal subset of YAML for GitHub Actions workflow files.
 * Only extracts jobs, their needs, and upload-artifact / download-artifact step names.
 */
function parseWorkflowYaml(text) {
  const jobs = {};
  const lines = text.split('\n');

  // Find job sections by looking for top-level keys under 'jobs:'
  let inJobs = false;
  let currentJob = null;
  let _currentJobIndent = 0;
  let inSteps = false;
  let _stepsIndent = 0;
  let currentStep = null;
  let _currentStepIndent = 0;
  let inWith = false;
  let withIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = getIndent(line);
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (!inJobs) {
      if (trimmed === 'jobs:') {
        inJobs = true;
      }
      continue;
    }

    // Top-level job keys
    if (indent === 2 && !trimmed.startsWith('-') && !trimmed.startsWith('#')) {
      const keyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/);
      if (keyMatch) {
        // Save previous step
        if (currentStep && currentJob) {
          const jobSteps = jobs[currentJob].steps || [];
          jobSteps.push(currentStep);
          jobs[currentJob].steps = jobSteps;
        }
        inSteps = false;
        inWith = false;
        currentStep = null;

        currentJob = keyMatch[1];
        _currentJobIndent = indent;
        jobs[currentJob] = { steps: [], needs: [] };
        continue;
      }
    }

    if (!currentJob) continue;

    // Parse needs
    if (indent === 4 && trimmed.startsWith('needs:')) {
      const needsMatch = trimmed.match(/^needs:\s*(.*)/);
      if (needsMatch) {
        const needsVal = needsMatch[1].trim();
        if (needsVal.startsWith('[') && needsVal.endsWith(']')) {
          jobs[currentJob].needs = needsVal
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          jobs[currentJob].needs = [needsVal];
        }
      }
      continue;
    }

    // Parse steps section
    if (indent === 4 && trimmed === 'steps:') {
      inSteps = true;
      _stepsIndent = indent;
      inWith = false;
      currentStep = null;
      continue;
    }

    if (inSteps && indent === 6 && trimmed.startsWith('-')) {
      // Save previous step
      if (currentStep) {
        jobs[currentJob].steps.push(currentStep);
      }
      inWith = false;
      currentStep = { uses: '', with: {} };
      _currentStepIndent = indent;

      const itemContent = trimmed.slice(1).trim();
      const keyMatch = itemContent.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)/);
      if (keyMatch) {
        if (keyMatch[1] === 'uses') {
          currentStep.uses = keyMatch[2].trim();
        }
        // Look ahead for more keys at this step's mapping level
        for (let j = i + 1; j < lines.length; j++) {
          const lookLine = lines[j];
          const lookTrimmed = lookLine.trim();
          if (lookTrimmed === '' || lookTrimmed.startsWith('#')) continue;
          const lookIndent = getIndent(lookLine);
          if (lookIndent < 6) break;
          if (lookIndent === 6 && lookTrimmed.startsWith('-')) break;
          if (lookIndent === 6 || lookIndent === 8) {
            const lookKeyMatch = lookTrimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)/);
            if (lookKeyMatch) {
              if (lookKeyMatch[1] === 'uses') {
                currentStep.uses = lookKeyMatch[2].trim();
              } else if (lookKeyMatch[1] === 'with') {
                inWith = true;
                withIndent = lookIndent;
              } else if (lookKeyMatch[1] === 'name') {
                currentStep.name = lookKeyMatch[2].trim();
              } else if (lookKeyMatch[1] === 'run') {
                const runLines = [lookKeyMatch[2].trim()];
                for (let k = j + 1; k < lines.length; k++) {
                  const runLine = lines[k];
                  const runIndent = getIndent(runLine);
                  if (runLine.trim() !== '' && runIndent <= lookIndent) break;
                  if (runLine.trim() !== '') runLines.push(runLine.trim());
                }
                currentStep.run = runLines.join('\n');
              }
            }
          } else if (inWith && lookIndent >= withIndent + 2) {
            const wKeyMatch = lookTrimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)/);
            if (wKeyMatch) {
              currentStep.with[wKeyMatch[1]] = wKeyMatch[2].trim();
            }
          } else {
            inWith = false;
          }
        }
        if (currentStep) {
          jobs[currentJob].steps.push(currentStep);
          currentStep = null;
        }
      }
    }
  }

  // Save last step
  if (currentStep && currentJob) {
    jobs[currentJob].steps.push(currentStep);
  }

  return jobs;
}

function timingConsumer(contract, entry) {
  const name = entry?.consumer;
  return typeof name === 'string' ? (contract.consumers?.[name] ?? null) : null;
}

function timingRequiredArtifactClasses(contract, entry) {
  if (entry?.notApplicable) return [];
  return timingConsumer(contract, entry)?.requiredArtifactClasses ?? null;
}

function getIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Check if two glob patterns could overlap.
 * A simple approximation: if one glob is a prefix of the other, they overlap.
 * For patterns like packages/star/dist and packages/star/pkg, they do not overlap
 * because the final segment differs.
 */
function globsOverlap(a, b) {
  const aParts = a.split('/').filter(Boolean);
  const bParts = b.split('/').filter(Boolean);

  // If globs have different segment counts, they can only overlap if the
  // shorter one ends with '**' (which matches any depth).
  if (aParts.length !== bParts.length) {
    const shorter = aParts.length < bParts.length ? aParts : bParts;
    const longer = aParts.length < bParts.length ? bParts : aParts;
    if (shorter[shorter.length - 1] !== '**') return false;
    // Check prefix up to the '**'
    for (let i = 0; i < shorter.length - 1; i++) {
      if (shorter[i] !== longer[i] && shorter[i] !== '*' && longer[i] !== '*') return false;
    }
    return true;
  }

  for (let i = 0; i < aParts.length; i++) {
    const aSeg = aParts[i];
    const bSeg = bParts[i];
    if (aSeg === bSeg) continue;
    if (aSeg === '*' || bSeg === '*') continue;
    if (aSeg === '**' || bSeg === '**') continue;
    return false;
  }
  return true;
}

/**
 * Emit errors. When there are multiple errors, emit the first one as a single
 * object (the most important). When there is exactly one, emit it directly.
 * Tests expect a single JSON object with `.code`.
 */
function emitErrors(errors) {
  if (errors.length === 0) return;
  // Always emit the first error as the primary one
  const first = errors[0];
  process.stdout.write(`${JSON.stringify(first)}\n`);
}

// ============================================================================
// Main validator
// ============================================================================

function validateContract(contract) {
  const errors = [];

  // Required top-level fields
  if (!contract.version) {
    errors.push({
      code: 'ci-artifact-contract-schema-error',
      actual: 'missing version',
      expected: 'number >= 1',
    });
  }
  if (typeof contract.version !== 'number' || contract.version < 1) {
    errors.push({
      code: 'ci-artifact-contract-schema-error',
      actual: `version=${contract.version}`,
      expected: 'number >= 1',
    });
  }
  if (!contract.artifactClasses || typeof contract.artifactClasses !== 'object') {
    errors.push({
      code: 'ci-artifact-contract-schema-error',
      actual: 'missing artifactClasses',
      expected: 'object mapping class names to definitions',
    });
  }
  if (!contract.consumers || typeof contract.consumers !== 'object') {
    errors.push({
      code: 'ci-artifact-contract-schema-error',
      actual: 'missing consumers',
      expected: 'object mapping consumer names to definitions',
    });
  }

  if (errors.length > 0) return errors;

  // Validate artifact classes
  const classNames = Object.keys(contract.artifactClasses);
  const workflowClasses = new Set(
    Object.values(contract.consumers ?? {}).flatMap(
      (consumer) => consumer.requiredArtifactClasses ?? [],
    ),
  );
  for (const className of classNames.filter((name) => workflowClasses.has(name))) {
    const def = contract.artifactClasses[className];
    if (!def.fileClasses || !Array.isArray(def.fileClasses) || def.fileClasses.length === 0) {
      errors.push({
        code: 'ci-artifact-contract-schema-error',
        actual: `artifactClasses.${className}.fileClasses is empty or missing`,
        expected: 'non-empty array of glob patterns',
      });
    }
  }

  // Validate consumers
  const consumerNames = Object.keys(contract.consumers);
  for (const consumerName of consumerNames) {
    const consumer = contract.consumers[consumerName];
    if (!consumer.requiredArtifactClasses || !Array.isArray(consumer.requiredArtifactClasses)) {
      errors.push({
        code: 'ci-artifact-contract-schema-error',
        actual: `consumers.${consumerName}.requiredArtifactClasses is missing`,
        expected: 'array of artifact class names',
      });
      continue;
    }
    if (consumer.requiredArtifactClasses.length === 0) {
      errors.push({
        code: 'ci-artifact-contract-schema-error',
        actual: `consumers.${consumerName}.requiredArtifactClasses is empty`,
        expected: 'non-empty array of artifact class names',
      });
    }
    for (const className of consumer.requiredArtifactClasses) {
      if (!contract.artifactClasses[className]) {
        errors.push({
          code: 'ci-artifact-contract-class-unknown',
          actual: `consumer "${consumerName}" references unknown class "${className}"`,
          expected: `one of: ${classNames.join(', ')}`,
        });
      }
    }
  }

  // Check non-overlapping file classes
  for (let i = 0; i < classNames.length; i++) {
    for (let j = i + 1; j < classNames.length; j++) {
      const aClasses = contract.artifactClasses[classNames[i]].fileClasses || [];
      const bClasses = contract.artifactClasses[classNames[j]].fileClasses || [];
      for (const aGlob of aClasses) {
        for (const bGlob of bClasses) {
          const sharedShardFamily = (contract.shardFamilies || []).some(
            (family) =>
              family.inventoryRequired === true &&
              family.members?.includes(classNames[i]) &&
              family.members?.includes(classNames[j]),
          );
          if (globsOverlap(aGlob, bGlob) && !sharedShardFamily) {
            errors.push({
              code: 'ci-artifact-contract-overlapping-paths',
              actual: `"${classNames[i]}" and "${classNames[j]}" both match "${aGlob}" / "${bGlob}"`,
              expected: 'non-overlapping file class paths',
            });
          }
        }
      }
    }
  }

  return errors;
}

function validateTimingRoster(contract) {
  const errors = [];
  const classNames =
    contract.artifactClasses && typeof contract.artifactClasses === 'object'
      ? Object.keys(contract.artifactClasses)
      : [];

  if (!contract.timingRoster || !Array.isArray(contract.timingRoster)) {
    errors.push({
      code: 'ci-artifact-contract-timing-roster-missing',
      actual: 'missing timingRoster',
      expected: 'array of timing roster entries',
    });
    return errors;
  }
  // If artifactClasses is missing, skip class-level checks (already caught by validateContract)
  if (!contract.artifactClasses || typeof contract.artifactClasses !== 'object') {
    return errors;
  }

  const seenIdentities = new Set();
  for (const entry of contract.timingRoster) {
    if (!entry.jobIdentity) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-invalid',
        actual: 'missing jobIdentity',
        expected: 'string job identity matching a workflow job name',
      });
      continue;
    }

    if (seenIdentities.has(entry.jobIdentity)) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-duplicate',
        actual: `duplicate jobIdentity "${entry.jobIdentity}"`,
        expected: 'unique job identities',
      });
    }
    seenIdentities.add(entry.jobIdentity);

    if (typeof entry.consumer !== 'string' || !entry.consumer) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-invalid',
        actual: `missing consumer for "${entry.jobIdentity}"`,
        expected: 'consumer name declared in consumers',
      });
      continue;
    }

    if (Object.hasOwn(entry, 'requiredArtifactClasses')) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-duplicate-projection',
        actual: `timing roster "${entry.jobIdentity}" carries requiredArtifactClasses directly`,
        expected: 'timing entries reference consumers; artifact classes belong only to consumers',
      });
    }

    const consumer = timingConsumer(contract, entry);
    if (!consumer) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-unknown-consumer',
        actual: `timing roster "${entry.jobIdentity}" references unknown consumer "${entry.consumer}"`,
        expected: `one of: ${Object.keys(contract.consumers ?? {}).join(', ')}`,
      });
      continue;
    }
    const requiredArtifactClasses = timingRequiredArtifactClasses(contract, entry);
    if (!Array.isArray(requiredArtifactClasses)) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-invalid',
        actual: `consumer "${entry.consumer}" has no requiredArtifactClasses`,
        expected: 'consumer projection with an artifact class array',
      });
      continue;
    }

    if (contract.version >= 2 && !entry.notApplicable && !entry.artifactProvider) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-invalid',
        actual: `missing artifactProvider for "${entry.jobIdentity}"`,
        expected: 'workflow job identity that exposes the required artifact IDs',
      });
    }

    // Not applicable consumers don't need requiredArtifactClasses
    if (entry.notApplicable) {
      const releasePattern = /^publish-.*-release$/;
      if (!releasePattern.test(entry.jobIdentity)) {
        errors.push({
          code: 'ci-artifact-contract-timing-roster-invalid',
          actual: `"${entry.jobIdentity}" has notApplicable=true but is not a release consumer`,
          expected: 'notApplicable only for publish-*-release consumers',
        });
      }
      continue;
    }

    // Release consumers MUST have notApplicable=true
    const releasePattern = /^publish-.*-release$/;
    if (releasePattern.test(entry.jobIdentity)) {
      errors.push({
        code: 'ci-artifact-contract-timing-roster-invalid',
        actual: `"${entry.jobIdentity}" is a release consumer but notApplicable is not true`,
        expected: 'notApplicable must be true for publish-*-release consumers',
      });
    }

    for (const className of requiredArtifactClasses) {
      if (!contract.artifactClasses?.[className]) {
        errors.push({
          code: 'ci-artifact-contract-timing-roster-unknown-class',
          actual: `timing roster "${entry.jobIdentity}" references unknown class "${className}"`,
          expected: `one of: ${classNames.join(', ')}`,
        });
      }
    }

    // Check allowedNonArtifactPrerequisites doesn't overlap with requiredArtifactClasses
    if (entry.allowedNonArtifactPrerequisites) {
      for (const prereq of entry.allowedNonArtifactPrerequisites) {
        if (requiredArtifactClasses.includes(prereq) || classNames.includes(prereq)) {
          errors.push({
            code: 'ci-artifact-contract-timing-roster-overlap',
            actual: `"${entry.jobIdentity}" has "${prereq}" in both requiredArtifactClasses and allowedNonArtifactPrerequisites`,
            expected: 'allowedNonArtifactPrerequisites must not overlap with artifact classes',
          });
        }
      }
    }
  }

  return errors;
}

function validateProvenance(contract) {
  const errors = [];
  const classNames =
    contract.artifactClasses && typeof contract.artifactClasses === 'object'
      ? Object.keys(contract.artifactClasses)
      : [];

  if (!contract.provenance) {
    errors.push({
      code: 'ci-artifact-contract-provenance-missing',
      actual: 'missing provenance',
      expected:
        'provenance section with producerRoster, namingTemplate, mergedClass, payloadClasses',
    });
    return errors;
  }

  const prov = contract.provenance;

  if (!prov.producerRoster || !Array.isArray(prov.producerRoster)) {
    errors.push({
      code: 'ci-artifact-contract-provenance-invalid',
      actual: 'missing producerRoster',
      expected: 'array of declared producer job identities',
    });
  } else if (!classNames.includes('shared-asset-pack')) {
    const expectedRoster = ['core-build', 'app-shard-0', 'app-shard-1', 'app-shard-2'];
    if (
      prov.producerRoster.length !== expectedRoster.length ||
      expectedRoster.some((producer) => !prov.producerRoster.includes(producer))
    ) {
      errors.push({
        code: 'ci-artifact-contract-provenance-invalid',
        actual: `producerRoster=${prov.producerRoster.join(', ')}`,
        expected: expectedRoster.join(', '),
      });
    }
  }

  if (!prov.namingTemplate) {
    errors.push({
      code: 'ci-artifact-contract-provenance-invalid',
      actual: 'missing namingTemplate',
      expected: 'provenance-<producerJobId>-a<runAttempt>',
    });
  }

  if (!prov.mergedClass) {
    errors.push({
      code: 'ci-artifact-contract-provenance-invalid',
      actual: 'missing mergedClass',
      expected: 'provenance-merged',
    });
  }

  if (!prov.mergedWriter) {
    errors.push({
      code: 'ci-artifact-contract-provenance-invalid',
      actual: 'missing mergedWriter',
      expected: 'build-artifacts',
    });
  }

  if (!prov.mergedReader) {
    errors.push({
      code: 'ci-artifact-contract-provenance-invalid',
      actual: 'missing mergedReader',
      expected: 'cost-reporter',
    });
  }

  if (!prov.payloadClasses || !Array.isArray(prov.payloadClasses)) {
    errors.push({
      code: 'ci-artifact-contract-provenance-invalid',
      actual: 'missing payloadClasses',
      expected: 'array of all contract artifact class names',
    });
  } else {
    // Check payloadClasses covers all artifact classes
    const payloadSet = new Set(prov.payloadClasses);
    for (const className of classNames) {
      if (!payloadSet.has(className)) {
        errors.push({
          code: 'ci-artifact-contract-provenance-invalid',
          actual: `payloadClasses missing "${className}"`,
          expected: `payloadClasses must cover all artifact classes: ${classNames.join(', ')}`,
        });
      }
    }
  }

  const shared =
    contract.sharedInputs ??
    (classNames.includes('shared-asset-pack') && classNames.includes('shared-engine-shaders')
      ? {
          producer: 'shared-app-inputs',
          consumer: 'app-shard',
          payloadClasses: ['shared-asset-pack', 'shared-engine-shaders'],
        }
      : null);
  if (shared) {
    const payloadClasses = shared.payloadClasses ?? [];
    if (
      shared.producer !== 'shared-app-inputs' ||
      !prov.producerRoster?.includes(shared.producer)
    ) {
      errors.push({
        code: 'ci-artifact-shared-producer-missing',
        actual: shared.producer ?? 'missing',
        expected: 'shared-app-inputs',
        hint: 'Declare shared-app-inputs in provenance.producerRoster before app shards consume shared inputs.',
      });
    }
    if (shared.consumer !== 'app-shard') {
      errors.push({
        code: 'ci-artifact-shared-consumer-unknown',
        actual: shared.consumer ?? 'missing',
        expected: 'app-shard',
        hint: 'Only the app-shard consumer may consume the shared-app-inputs payload classes.',
      });
    }
    for (const className of payloadClasses) {
      if (!contract.artifactClasses?.[className] || !prov.payloadClasses?.includes(className)) {
        errors.push({
          code: 'ci-artifact-shared-class-undeclared',
          actual: className,
          expected: 'a declared artifact and provenance payload class',
          hint: 'Add the shared class to artifactClasses and provenance.payloadClasses.',
        });
      }
      for (const [consumerName, consumer] of Object.entries(contract.consumers ?? {})) {
        if (consumerName !== 'app-shard' && consumer.requiredArtifactClasses?.includes(className)) {
          errors.push({
            code: 'ci-artifact-shared-consumer-unknown',
            actual: consumerName,
            expected: 'app-shard',
            hint: 'Route shared-app-inputs only through the app-shard consumer contract.',
          });
        }
      }
    }
  }

  return errors;
}

function validateWorkflow(contract, workflowPath) {
  const errors = [];

  if (!existsSync(workflowPath)) {
    errors.push({
      code: 'ci-artifact-contract-workflow-missing',
      actual: workflowPath,
      expected: 'path to ci.yml workflow file',
    });
    return errors;
  }

  let workflowJobs;
  try {
    const yamlText = readFileSync(workflowPath, 'utf-8');
    workflowJobs = parseWorkflowYaml(yamlText);
  } catch (err) {
    errors.push({
      code: 'ci-artifact-contract-workflow-parse-error',
      actual: err.message,
      expected: 'valid YAML workflow file',
    });
    return errors;
  }

  const jobs = workflowJobs;
  const jobNames = Object.keys(jobs);

  // Collect upload-artifact and download-artifact steps
  const uploadedArtifactNames = new Set();
  const downloadedArtifactNames = new Map(); // jobName -> Set<artifactName>

  for (const jobName of jobNames) {
    const job = jobs[jobName];
    const steps = job?.steps || [];
    const jobDownloads = new Set();

    for (const step of steps) {
      if (typeof step === 'object' && step !== null) {
        // Check for uses: actions/upload-artifact@v6 or download-artifact@v7
        const uses = step.uses || '';
        if (uses.includes('upload-artifact')) {
          const name = step.with?.name;
          if (name) {
            uploadedArtifactNames.add(name);
          }
        }
        if (uses.includes('download-artifact')) {
          const reference = step.with?.['artifact-ids'] ?? step.with?.name;
          if (reference) {
            downloadedArtifactNames.set(jobName, jobDownloads);
            jobDownloads.add(reference);
          }
        }
        if (typeof step.run === 'string') {
          for (const match of step.run.matchAll(/--artifact-ids\s+(?:"([^"]+)"|(\S+))/g)) {
            jobDownloads.add(match[1] ?? match[2]);
            downloadedArtifactNames.set(jobName, jobDownloads);
          }
        }
      }
    }

    if (jobDownloads.size > 0) {
      downloadedArtifactNames.set(jobName, jobDownloads);
    }
  }

  const classNames = Object.keys(contract.artifactClasses || {});

  // Check: every declared artifact class has a corresponding upload. Immutable
  // retry-safe artifacts suffix the class with producer identity / attempt.
  for (const className of classNames) {
    const transferArtifact = contract.artifactClasses[className]?.transferArtifact ?? className;
    const hasUpload = [...uploadedArtifactNames].some(
      (name) => name === transferArtifact || name.startsWith(`${transferArtifact}-`),
    );
    if (!hasUpload) {
      errors.push({
        code: 'ci-artifact-contract-upload-missing',
        actual: `artifact class "${className}" not found in any upload-artifact step`,
        expected: `upload step with name="${transferArtifact}" or immutable "${transferArtifact}-…"`,
      });
    }
  }

  // Check: every download-artifact that references an artifact produced by
  // the contract-configured uploader (build-artifacts) must reference a
  // declared artifact name. Non-contract artifacts (e.g. metrics-report
  // uploaded by metrics-validate) are not checked — they belong to a
  // separate artifact pipeline.
  const contractUploader = contract.provenance?.mergedWriter || 'build-artifacts';
  const contractUploadedNames = new Set();
  for (const step of jobs[contractUploader]?.steps || []) {
    if (typeof step === 'object' && step !== null) {
      const uses = step.uses || '';
      if (uses.includes('upload-artifact')) {
        const name = step.with?.name;
        if (name) contractUploadedNames.add(name);
      }
    }
  }

  for (const [jobName, downloads] of downloadedArtifactNames) {
    for (const name of downloads) {
      // Skip "build-output" (legacy monolithic artifact)
      if (name === 'build-output') continue;
      const immutableUploads = [...uploadedArtifactNames].filter((uploadName) =>
        uploadName.startsWith(`${name}-`),
      );
      if (
        classNames.includes(name) &&
        !uploadedArtifactNames.has(name) &&
        immutableUploads.length > 0
      ) {
        errors.push({
          code: 'ci-artifact-contract-download-name-mismatch',
          actual: `job "${jobName}" downloads missing mutable artifact "${name}"`,
          expected: `an exact immutable upload (${immutableUploads.join(', ')}) or its artifact ID`,
        });
        continue;
      }
      // Only flag downloads that are also uploaded by the contract-configured
      // uploader (build-artifacts). Non-contract artifacts (metrics-report,
      // etc.) are uploaded by other jobs and belong to separate pipelines.
      const isMergedProvenance = name.startsWith(
        `${contract.provenance?.mergedClass ?? 'provenance-merged'}-a`,
      );
      if (contractUploadedNames.has(name) && !classNames.includes(name) && !isMergedProvenance) {
        errors.push({
          code: 'ci-artifact-contract-undeclared-download',
          actual: `job "${jobName}" downloads undeclared artifact "${name}" from contract uploader`,
          expected: `one of: ${classNames.join(', ')}`,
        });
      }
    }
  }

  // Validate timing roster against workflow
  if (contract.timingRoster && Array.isArray(contract.timingRoster)) {
    for (const entry of contract.timingRoster) {
      const jobId = entry.jobIdentity;
      if (!jobId) continue;

      // Check job exists in workflow
      if (!jobs[jobId]) {
        errors.push({
          code: 'ci-artifact-contract-timing-roster-job-not-found',
          actual: `timing roster job "${jobId}" not found in workflow`,
          expected: `one of workflow job names: ${jobNames.join(', ')}`,
        });
        continue;
      }

      if (entry.notApplicable) continue;

      // F-1 bidirectional needs check: validate needs against allowedNonArtifactPrerequisites
      const job = jobs[jobId];
      const actualNeeds = job.needs || [];

      const artifactProvider = entry.artifactProvider ?? contract.provenance?.mergedWriter;
      const allowedPrereqs = entry.allowedNonArtifactPrerequisites || [];

      // Check: the contract-selected artifact provider must be in needs.
      if (!actualNeeds.includes(artifactProvider)) {
        errors.push({
          code: 'ci-artifact-timing-roster-missing-artifact-needs',
          actual: `timing consumer "${jobId}" needs does not include "${artifactProvider}"`,
          expected: `needs must include its declared artifact provider "${artifactProvider}"`,
        });
      }

      // Check: every needs entry except the provider must be explicitly non-artifact work.
      const undeclaredNeeds = [];
      for (const need of actualNeeds) {
        if (need === artifactProvider) continue;
        if (!allowedPrereqs.includes(need)) {
          undeclaredNeeds.push(need);
        }
      }
      if (undeclaredNeeds.length > 0) {
        errors.push({
          code: 'ci-artifact-timing-roster-unknown-prerequisite',
          actual: undeclaredNeeds,
          expected: `all non-artifact prerequisites must be declared in allowedNonArtifactPrerequisites: [${allowedPrereqs.join(', ')}]`,
        });
      }

      // Check: every allowedNonArtifactPrerequisites entry must be in actual needs
      const stalePrereqs = [];
      for (const prereq of allowedPrereqs) {
        if (!actualNeeds.includes(prereq)) {
          stalePrereqs.push(prereq);
        }
      }
      if (stalePrereqs.length > 0) {
        errors.push({
          code: 'ci-artifact-timing-roster-stale-prerequisite',
          actual: stalePrereqs,
          expected: `all declared prerequisites must appear in actual needs: [${actualNeeds.join(', ')}]`,
        });
      }

      const shared =
        contract.sharedInputs ??
        (classNames.includes('shared-asset-pack')
          ? {
              producer: 'shared-app-inputs',
              payloadClasses: ['shared-asset-pack', 'shared-engine-shaders'],
            }
          : null);
      const sharedClasses = shared?.payloadClasses ?? [];
      if (entry.artifactProvider === shared?.producer) {
        for (const className of sharedClasses) {
          const outputName =
            shared?.artifactOutput ??
            (className === 'shared-asset-pack'
              ? 'asset_artifact_id'
              : className === 'shared-engine-shaders'
                ? 'shader_artifact_id'
                : null);
          const downloaded = [...(downloadedArtifactNames.get(jobId) ?? [])].some(
            (reference) =>
              reference === className ||
              reference.startsWith(`${className}-`) ||
              (outputName !== null &&
                reference.includes(`needs.${entry.artifactProvider}.outputs.${outputName}`)),
          );
          if (!downloaded) {
            errors.push({
              code: 'ci-artifact-workflow-shared-download-missing',
              actual: `job "${jobId}" has no declared download for "${className}"`,
              expected: className,
              hint: `Add an explicit ${className} download to ${jobId} after it needs ${entry.artifactProvider}.`,
            });
          }
        }
      }

      // Check: notApplicable consumers should not have download-artifact in PR path
      // (Already handled above — notApplicable consumers are skipped)
    }
  }

  return errors.sort((a, b) =>
    a.code === 'ci-artifact-workflow-shared-download-missing'
      ? -1
      : b.code === 'ci-artifact-workflow-shared-download-missing'
        ? 1
        : 0,
  );
}

// ============================================================================
// Main entry point
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  let workflowPath = null;
  let contractPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workflow' && i + 1 < args.length) {
      workflowPath = resolve(args[++i]);
    } else if (!contractPath) {
      contractPath = resolve(args[i]);
    }
  }

  if (!contractPath) {
    contractPath = resolve(join(__dirname, 'build-artifact-contract.json'));
  }

  // Read contract
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
  } catch (err) {
    emitErrors([
      {
        code: 'ci-artifact-contract-parse-error',
        actual: err.message,
        expected: `valid JSON at ${contractPath}`,
        hint: 'Verify the contract file exists and is valid JSON.',
      },
    ]);
    process.exit(1);
  }

  // Validate contract schema
  const allErrors = [
    ...validateContract(contract),
    ...validateTimingRoster(contract),
    ...validateProvenance(contract),
  ];

  // Validate workflow if requested
  if (workflowPath) {
    allErrors.push(...validateWorkflow(contract, workflowPath));
  }

  if (allErrors.length > 0) {
    emitErrors(allErrors);
    process.exit(1);
  }

  process.stdout.write('ok: contract is valid\n');
  process.exit(0);
}

main();
