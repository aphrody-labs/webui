// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const [mode, requestedDestination] = process.argv.slice(2);
if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: bun scripts/stage-rust-assets.mjs --write|--check [DESTINATION]');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(
  requestedDestination ?? resolve(root, '../../target/webui-desktop-assets/ipc'),
);

const assets = new Map();
for (const name of [
  'native-bootstrap.js',
  'desktop-runtime.js',
  'local-native-bootstrap.js',
  'local-desktop-runtime.js',
]) {
  assets.set(name, await readFile(resolve(root, 'dist', name)));
}

for (const [entry, output] of [
  ['linux-local-entry.ts', 'linux-local-entry.js'],
  ['linux-local-mediator.ts', 'linux-local-mediator.js'],
]) {
  const result = await Bun.build({
    entrypoints: [resolve(root, 'src', entry)],
    target: 'browser',
    format: 'iife',
    minify: true,
    banner: '// Copyright (c) Microsoft Corporation.\n// Licensed under the MIT license.',
  });
  const artifact = result.outputs[0];
  const bytes = artifact && new Uint8Array(await artifact.arrayBuffer());
  if (!bytes) throw new Error(`Missing generated Rust asset: ${entry}`);
  assets.set(output, bytes);
}

if (mode === '--write') await mkdir(destination, { recursive: true });
for (const [name, bytes] of assets) {
  const output = resolve(destination, name);
  if (mode === '--write') {
    await writeFile(output, bytes);
    continue;
  }
  if (!Buffer.from(bytes).equals(await readFile(output))) {
    throw new Error(`Generated Rust asset differs: ${name}. Run stage-rust-assets.mjs --write.`);
  }
}
