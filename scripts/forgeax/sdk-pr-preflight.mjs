import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

export const SDK_ARCHIVE_VERIFY_GROUPS = Object.freeze(['project', 'source', 'view']);
export const SDK_PR_CONSUMERS = Object.freeze(['npm', ...SDK_ARCHIVE_VERIFY_GROUPS]);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function seedFiles(root, version) {
  return [
    `forgeax-sdk-v${version}.zip`,
    ...readdirSync(resolve(root, 'npm'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'))
      .sort(),
  ];
}

export function writeSeedChecksums(root, version) {
  writeFileSync(
    resolve(root, 'SHA256SUMS'),
    seedFiles(root, version)
      .map((path) => `${digest(resolve(root, path))}  ${path}\n`)
      .join(''),
  );
}

export function checkSeed(root, expectedHead, version) {
  const build = JSON.parse(readFileSync(resolve(root, 'sdk-build-result.json'), 'utf8'));
  if (!build.ok || build.engineCommit !== expectedHead || build.sdkVersion !== version)
    throw new Error('sdk-pr-seed-identity');
  const files = seedFiles(root, version);
  const expected = files.map((path) => `${digest(resolve(root, path))}  ${path}\n`).join('');
  if (
    readFileSync(resolve(root, 'SHA256SUMS'), 'utf8') !== expected ||
    digest(resolve(root, files[0])) !== build.sha256 ||
    files.length !== build.npm.packageCount + 2
  )
    throw new Error('sdk-pr-seed-byte-closure');
  return build;
}

export function aggregateSdkConsumers(reports, expectedHead, version) {
  if (!/^[0-9a-f]{40}$/.test(expectedHead) || reports.length !== SDK_PR_CONSUMERS.length)
    throw new Error('sdk-pr-consumer-conservation');
  const identities = new Set();
  for (const group of SDK_PR_CONSUMERS) {
    const matches = reports.filter((report) => report.group === group);
    if (matches.length !== 1) throw new Error(`sdk-pr-consumer-missing-or-duplicate:${group}`);
    const report = matches[0];
    if (
      !report.ok ||
      report.engineCommit !== expectedHead ||
      (report.sdkVersion ?? report.version) !== version ||
      !/^[0-9a-f]{64}$/.test(report.sha256) ||
      !/^[0-9a-f]{40}$/.test(report.viewCommit)
    )
      throw new Error(`sdk-pr-consumer-identity:${group}`);
    identities.add(`${report.sha256}:${report.viewCommit}`);
  }
  if (identities.size !== 1) throw new Error('sdk-pr-consumer-byte-mismatch');
  return { ok: true, engineCommit: expectedHead, sdkVersion: version, groups: SDK_PR_CONSUMERS };
}

if (import.meta.main) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  const version = value('--version');
  if (process.argv.includes('--write-seed'))
    writeSeedChecksums(resolve(value('--write-seed')), version);
  else if (process.argv.includes('--check-seed'))
    checkSeed(resolve(value('--check-seed')), value('--expected-head'), version);
  else if (process.argv.includes('--aggregate')) {
    const root = resolve(value('--aggregate'));
    const reports = SDK_PR_CONSUMERS.map((group) =>
      JSON.parse(readFileSync(resolve(root, `sdk-verify-${group}-result.json`), 'utf8')),
    );
    console.log(JSON.stringify(aggregateSdkConsumers(reports, value('--expected-head'), version)));
  } else throw new Error(`unknown-sdk-pr-command:${basename(process.argv[1])}`);
}
