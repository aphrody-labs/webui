// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runWebUIClientBuild } from './build-client.mjs';

const packageRoot = fileURLToPath(new URL('../packages/webui/', import.meta.url));
const { hashContent } = await import(
  pathToFileURL(path.join(packageRoot, 'dist/projection/index.js')).href
);
// Resolve @microsoft/webui and the TypeScript peer the way an example does.
// `bun test` shares one process across files, so restore the directory.
const initialDirectory = process.cwd();
beforeAll(() => {
  process.chdir(fileURLToPath(new URL('../packages/webui-test-support/', import.meta.url)));
});
afterAll(() => {
  process.chdir(initialDirectory);
});

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(options = {}, files = {}) {
  const root = await mkdtemp(path.join(packageRoot, '.tmp-client-build-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/index.js'), `/*! @license Fixture MIT */
export function calculate(value) {
  const redundant = value + 1;
  return redundant;
}
export const development = typeof __WEBUI_DEV__ === 'undefined' || __WEBUI_DEV__;
export const load = () => import('./lazy.js');
`);
  await writeFile(path.join(root, 'src/lazy.js'), 'export const lazy = 7;\n');
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  const result = await runWebUIClientBuild({
    absWorkingDir: root,
    entryPoints: ['src/index.js'],
    outdir: 'dist',
    ...options,
  });
  return { root, result };
}

test('production output is minified before projection binds its bytes', async () => {
  const { root, result } = await fixture();
  expect(result.success).toBe(true);
  const code = await readFile(path.join(root, 'dist/index.js'), 'utf8');
  expect(code).toMatch(/@license Fixture MIT/);
  expect(code).not.toMatch(/redundant/);
  expect(code).not.toMatch(/modulepreload/);
  const module = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  expect(module.calculate(41)).toBe(42);
  expect(module.development).toBe(false);
  expect((await module.load()).lazy).toBe(7);

  const manifest = JSON.parse(await readFile(path.join(root, 'dist/webui-projection.json'), 'utf8'));
  expect(manifest.adapter).toEqual({ name: 'bun', bundler: `bun@${Bun.version}` });
  expect(Object.values(manifest.outputs)).toContain(hashContent(code));
});

test('metafile output ids are relative to absWorkingDir, as with esbuild', async () => {
  const { root, result } = await fixture();
  const output = result.metafile.outputs['dist/index.js'];
  expect(output).toBeDefined();
  const code = await readFile(path.join(root, 'dist/index.js'));
  expect(output.bytes).toBe(code.byteLength);
  for (const [id, metadata] of Object.entries(result.metafile.outputs)) {
    expect(id.startsWith('./')).toBe(false);
    for (const edge of metadata.imports) {
      if (!edge.external) expect(result.metafile.outputs[edge.path]).toBeDefined();
    }
  }
});

test('explicit minify false and developer flag overrides remain supported', async () => {
  const { root } = await fixture({ minify: false, define: { __WEBUI_DEV__: 'true' } });
  const code = await readFile(path.join(root, 'dist/index.js'), 'utf8');
  expect(code).toMatch(/redundant/);
  const module = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  expect(module.development).toBe(true);
});

test('named entry points emit flat outputs and reject mismatched names', async () => {
  const { root } = await fixture(
    { entryPoints: { index: 'src/index.js', panel: 'src/panel/panel.js' } },
    { 'src/panel/panel.js': 'export const panel = true;\n' },
  );
  const panel = await import(pathToFileURL(path.join(root, 'dist/panel.js')).href);
  expect(panel.panel).toBe(true);
  await expect(fixture({ entryPoints: { other: 'src/index.js' } })).rejects.toThrow(
    /must match its file name/,
  );
});

test('projection failures reject the build', async () => {
  await expect(
    fixture({ projectionManifest: 'dist/index.js' }),
  ).rejects.toThrow(/PROJ-C013|collides/);
});

test('relative external specifiers stay imports in the bundle', async () => {
  const { root } = await fixture(
    { entryPoints: ['src/app.js'], external: ['./wasm/handler.js'] },
    { 'src/app.js': 'export const load = () => import("./wasm/handler.js");\n' },
  );
  const code = await readFile(path.join(root, 'dist/app.js'), 'utf8');
  expect(code).toContain('./wasm/handler.js');
});
