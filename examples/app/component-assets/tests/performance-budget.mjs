// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';
import {
  brotliCompressSync,
  constants,
  gzipSync,
} from 'node:zlib';

// Release production build of main 6ceba632 merged with the lazy-region
// redesign: shared Link sheets and per-request asset-base resolution in
// styles.js.
const BASELINE = {
  startupRaw: 89_976,
  startupGzip: 28_811,
  startupBrotli: 25_260,
  totalRaw: 92_203,
  totalGzip: 29_979,
  totalBrotli: 26_223,
  coldRaw: 1_388,
  coldGzip: 737,
  coldBrotli: 609,
  startupRequests: 2,
  coldRequests: 2,
};

// The baseline above was minified by esbuild plus three Terser passes. The
// client build now uses Bun.build's minifier only (Bun 1.4.4, 2026-11-12):
// startup 95_879 raw / 30_621 gzip / 26_934 brotli, total 98_036 / 31_733 /
// 27_841, i.e. about +6% over the Terser baseline and on par with esbuild's own
// minifier (total gzip 31_987). Startup and total budgets keep ~2% headroom
// over the Bun measurement; the Main column still reports the Terser delta.
const BUDGETS = {
  startupRaw: 98_000,
  startupGzip: 31_300,
  startupBrotli: 27_500,
  totalRaw: 100_000,
  totalGzip: 32_400,
  totalBrotli: 28_400,
  coldRaw: Math.ceil(BASELINE.coldRaw * 1.1),
  coldGzip: Math.ceil(BASELINE.coldGzip * 1.1),
  coldBrotli: Math.ceil(BASELINE.coldBrotli * 1.1),
  startupRequests: 3,
  coldRequests: BASELINE.coldRequests,
};

const metafile = JSON.parse(readFileSync('dist/client-metafile.json', 'utf8'));
if (Object.values(metafile.outputs).some(output => Object.entries(output.inputs).some(
  ([input, contribution]) => input.endsWith('/hydration-mismatch.js') && contribution.bytesInOutput > 0,
))) {
  throw new Error('Production builds must set __WEBUI_DEV__=false to exclude hydration diagnostics.');
}
const outputs = metafile.outputs;
const entry = findOutput('src/index.ts');
const lazy = findOutput('.webui/lazy-panel.webui.js');
const startup = staticClosure(entry);
const cold = staticClosure(lazy);
for (const output of startup) cold.delete(output);

const allJavaScript = new Set(
  Object.keys(outputs).filter(path => path.endsWith('.js')),
);
const measurements = {
  ...sizes('startup', startup),
  ...sizes('total', allJavaScript),
  ...sizes('cold', cold),
  startupRequests: startup.size,
  coldRequests: cold.size,
};

let failed = false;
console.log('| Metric | Main | Current | Delta | Budget |');
console.log('|---|---:|---:|---:|---:|');
for (const key of Object.keys(BUDGETS)) {
  const baseline = BASELINE[key];
  const current = measurements[key];
  const delta = ((current - baseline) / baseline) * 100;
  const budget = BUDGETS[key];
  if (current > budget) failed = true;
  console.log(
    `| ${key} | ${baseline} | ${current} | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% | <= ${budget} |`,
  );
}

if (failed) {
  throw new Error('Component asset production bundle exceeded its performance budget.');
}

function findOutput(entryPoint) {
  const match = Object.entries(outputs)
    .find(([, output]) => output.entryPoint === entryPoint);
  if (!match) throw new Error(`Missing bundle output for ${entryPoint}.`);
  return match[0];
}

function staticClosure(entryPoint) {
  const closure = new Set();
  const pending = [entryPoint];
  while (pending.length > 0) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    const output = outputs[path];
    if (!output) throw new Error(`Missing bundle output ${path}.`);
    for (const imported of output.imports ?? []) {
      if (imported.kind === 'import-statement' && !imported.external) {
        pending.push(imported.path);
      }
    }
  }
  return closure;
}

function sizes(prefix, paths) {
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const path of paths) {
    const bytes = readFileSync(path);
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    brotli += brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  }
  return {
    [`${prefix}Raw`]: raw,
    [`${prefix}Gzip`]: gzip,
    [`${prefix}Brotli`]: brotli,
  };
}
