// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const localCarrier = process.argv.slice(2).includes('--local-carrier');
if (process.argv.slice(2).some(argument => argument !== '--local-carrier')) {
  throw new Error('Usage: bun scripts/build.mjs [--local-carrier]');
}
const options = {
  target: 'browser',
  minify: true,
  banner: '// Copyright (c) Microsoft Corporation.\n// Licensed under the MIT license.',
};
await Promise.all((localCarrier ? [true] : [false, true]).flatMap(native => {
  const prefix = native ? 'local-' : '';
  return [
    bundle({ ...options, define: { __WEBUI_NATIVE_CARRIER__: String(native) },
      entrypoints: [`${root}src/native-entry.ts`], format: 'iife' },
      `${root}dist/${prefix}native-bootstrap.js`),
    bundle({ ...options, ...(native ? { define: { __WEBUI_NATIVE_CARRIER__: 'true' } } : {}),
      entrypoints: [`${root}src/${native ? 'local-index.ts' : 'index.ts'}`], format: 'esm' },
      `${root}dist/${prefix}desktop-runtime.js`),
  ];
}));

/** Bun.build writes by entry name; the runtime ships fixed single-file names. */
async function bundle(config, outfile) {
  const { outputs } = await Bun.build(config);
  if (outputs.length !== 1) throw new Error(`Expected one output for ${outfile}, got ${outputs.length}`);
  await Bun.write(outfile, outputs[0]);
}
