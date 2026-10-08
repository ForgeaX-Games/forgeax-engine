import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hashFiles, hashText, readReceipt, walkFiles, writeReceipt } from '../build-task-cache.mjs';

const SHARED_RECEIPT_KIND = 'receipts/shared';

// Hash actual bytes, not mtimes or file sizes. Generated timing facts change on
// every invocation and are not an input or a reusable shader payload.
export function sharedOutputFingerprint(output) {
  return hashFiles(
    output,
    walkFiles(output).filter((file) => file !== join(output, 'production-facts.json')),
  );
}

export function reusableSharedBuild(root, output, inputFingerprint, onMiss) {
  const miss = (reason) => {
    onMiss?.(reason);
    return false;
  };
  try {
    if (!existsSync(join(output, 'manifest.json')))
      return miss(`missing local shader manifest: ${join(output, 'manifest.json')}`);
    const receipt = readReceipt(root, SHARED_RECEIPT_KIND, output);
    if (!receipt) return miss(`missing or invalid local shader receipt: ${output}`);
    if (receipt.inputFingerprint !== inputFingerprint)
      return miss(
        `compiler/source/profile identity mismatch: expected=${inputFingerprint} observed=${receipt.inputFingerprint}`,
      );
    const observed = sharedOutputFingerprint(output);
    if (receipt.outputFingerprint !== observed)
      return miss(
        `shader payload digest mismatch: expected=${receipt.outputFingerprint} observed=${observed} path=${output}`,
      );
    return true;
  } catch (error) {
    return miss(
      `cannot read local shader input ${output}: ${error.code ?? error.name}: ${error.message}`,
    );
  }
}

export function recordSharedBuild(root, output, inputFingerprint) {
  writeReceipt(root, SHARED_RECEIPT_KIND, output, {
    inputFingerprint,
    outputFingerprint: sharedOutputFingerprint(output),
  });
}

// One input identity for local and transferred shader outputs. Generated release
// profiles are outputs, so publishing them cannot invalidate the next lookup.
export function sharedShaderInputFingerprint(root, engineEntries) {
  const packages = new Map(
    readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')),
      )
      .map((entry) => {
        const directory = join(root, 'packages', entry.name);
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        return [manifest.name, { directory, manifest }];
      }),
  );
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name)) return;
    const owner = packages.get(name);
    if (!owner) throw new Error(`shared shader compiler dependency is missing: ${name}`);
    closure.add(name);
    for (const [dependency, version] of Object.entries({
      ...owner.manifest.dependencies,
      ...owner.manifest.optionalDependencies,
      ...owner.manifest.peerDependencies,
    })) {
      if (packages.has(dependency) || version.startsWith('workspace:')) visit(dependency);
    }
  };
  visit('@forgeax/engine-vite-plugin-shader');
  const packageInputs = [...closure]
    .flatMap((name) => {
      const { directory } = packages.get(name);
      return [join(directory, 'package.json'), ...walkFiles(join(directory, 'dist'))];
    })
    .filter((path) => /\.(?:[cm]?js|json|wasm|wgsl)$/.test(path))
    // Release profiles are this producer's output, not compiler implementation.
    .filter(
      (path) => !path.startsWith(join(root, 'packages/vite-plugin-shader/dist/engine-inputs/')),
    );
  return hashText(
    JSON.stringify({
      bytes: hashFiles(root, [
        ...packageInputs,
        // Naga's compiler binary is owned by wgpu-wasm. Runtime codec payloads
        // can differ between producer and consumer without changing shaders.
        // wasm-pack emits .gitignore, docs and declarations which Actions
        // intentionally omits from archives or which do not execute. Bind the
        // actual compiler binary/glue and module mode, not packaging metadata.
        ...walkFiles(join(root, 'packages/wgpu-wasm/pkg')).filter(
          (path) =>
            /\.(?:[cm]?js|wasm)$/.test(path) ||
            path === join(root, 'packages/wgpu-wasm/pkg/package.json'),
        ),
        ...walkFiles(join(root, 'packages/shader/src')),
        ...walkFiles(join(root, 'packages/vfx-render/src/shaders')),
        join(root, 'package.json'),
        join(root, 'pnpm-lock.yaml'),
        join(root, 'scripts/build-shared-inputs.mjs'),
        join(root, 'scripts/ci/build-shared-app-inputs.mjs'),
        join(root, 'scripts/lib/shared-build-cache.mjs'),
        join(root, 'scripts/build-task-cache.mjs'),
      ]),
      node: process.version,
      engineEntries,
    }),
  );
}

// Bind the transferable shader manifest to the same source/compiler/profile
// identity as local reuse, without adding a second shader payload to artifacts.
export function sharedShaderReceipt(root, manifestPath, inputFingerprint) {
  return { inputFingerprint, outputFingerprint: hashFiles(root, [manifestPath]) };
}

export function reusableSharedShader(root, sharedManifestPath, inputFingerprint, onMiss) {
  const miss = (reason) => {
    onMiss?.(reason);
    return null;
  };
  try {
    const manifest = JSON.parse(readFileSync(sharedManifestPath, 'utf8'));
    if (!['repo-build-inputs', 'shared-app-inputs'].includes(manifest.producer))
      return miss(`unsupported shared producer: ${manifest.producer}`);
    if (!manifest.shaderBuild)
      return miss('missing shaderBuild receipt; regenerate with the current producer');
    if (manifest.shaderBuild.inputFingerprint !== inputFingerprint)
      return miss(
        `compiler/source/profile identity mismatch: expected=${inputFingerprint} observed=${manifest.shaderBuild.inputFingerprint}`,
      );
    const shaderPath = resolve(root, manifest.payload.engineShaderManifest);
    const expectedPath = resolve(dirname(sharedManifestPath), 'shaders/manifest.json');
    if (realpathSync(shaderPath) !== realpathSync(expectedPath))
      return miss(`shader payload path mismatch: expected=${expectedPath} observed=${shaderPath}`);
    const observed = hashFiles(root, [shaderPath]);
    if (manifest.shaderBuild.outputFingerprint !== observed)
      return miss(
        `shader payload digest mismatch: expected=${manifest.shaderBuild.outputFingerprint} observed=${observed} path=${shaderPath}`,
      );
    return shaderPath;
  } catch (error) {
    return miss(
      `cannot read shared shader input ${sharedManifestPath}: ${error.code ?? error.name}: ${error.message}`,
    );
  }
}
